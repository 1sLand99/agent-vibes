import { Logger } from "@nestjs/common"
import { TurnOutbound } from "./bidi-outbound"
import { BidiId, ConversationId, StreamId } from "../turn/turn.types"
import type { BidiAttachment, SealReason } from "./bidi-types"
import { BufferChannel } from "../concurrency/buffer-channel"

/**
 * Small interface so the controller can hand the supervisor's
 * cancel knob to BiDi-close paths without dragging the whole
 * supervisor into the controller's API surface.
 *
 * The controller delegates the entire seal+cancel+ledger-sweep+drain sequence to
 * `TurnCleanupCoordinator.cleanup({ kind: "bidi-closed" })` so every
 * termination path goes through one funnel.
 */
interface SupervisorBridge {
  cleanupBidi(
    bidiId: BidiId,
    outbound: TurnOutbound,
    reason: SealReason
  ): Promise<void>
}

/**
 * One per BiDi attachment. Owns the TurnOutbound, manages the
 * lifecycle of the inbound iterator, and seals on close.
 *
 * `handle()` is shaped as an AsyncIterable<Buffer> so it can be
 * returned directly from a ConnectRPC server-streaming handler. The
 * controller does NOT yield from inside turn-runners — instead, it
 * exposes a BufferChannel that runners write to via the
 * `TurnOutbound`, and `handle()` simply iterates that channel.
 *
 * This separation is the load-bearing structural change: today, the
 * outbound is the generator function's `yield` site, which means
 * frame ownership is implicit in the JavaScript stack. With the
 * channel as the seam, ownership is explicit (the writer stack on
 * the outbound) and the generator just drains.
 */
export class BidiStreamController {
  private readonly logger = new Logger(BidiStreamController.name)
  readonly attachment: BidiAttachment
  readonly outbound: TurnOutbound

  private readonly outboundChannel = new BufferChannel<Buffer>()
  private streamSealed = false

  constructor(args: {
    conversationId: string
    bidiId: string
    streamId: string
    supervisor: SupervisorBridge
  }) {
    this.attachment = {
      conversationId: args.conversationId,
      bidiId: args.bidiId,
      streamId: args.streamId,
      attachedAt: new Date(),
    }
    this.outbound = new TurnOutbound({
      conversationId: args.conversationId,
      bidiId: args.bidiId,
      emit: (frame) => {
        if (this.streamSealed) return
        this.outboundChannel.push(frame)
      },
      onSealed: (reason) => {
        // When the outbound seals, finalise the channel so the
        // generator returned by `handle()` exits.
        this.streamSealed = true
        this.outboundChannel.close()
        this.logger.debug(
          `outbound sealed bidi=${args.bidiId.substring(0, 8)} reason=${reason.kind}`
        )
      },
    })
    this.supervisor = args.supervisor
  }

  private readonly supervisor: SupervisorBridge

  /**
   * Server-streaming generator: yields every frame the outbound
   * accepts, in arrival order. Exits when the outbound is sealed.
   */
  async *handle(): AsyncGenerator<Buffer> {
    for await (const frame of this.outboundChannel) {
      yield frame
    }
  }

  /**
   * Seal the outbound and cancel any turns still active for this
   * conversation. Idempotent.
   *
   * `TurnCleanupCoordinator.cleanup` owns the full seal protocol: cancel,
   * graph/ledger sweep where appropriate, writer drain, and finishSeal.
   */
  seal(reason: SealReason): void {
    if (this.streamSealed) return
    this.streamSealed = true
    // Coordinator owns the unwind; do not touch outbound directly here — it
    // commits any required graph cleanup before closing the attachment.
    // Fire-and-forget by design: seal is invoked from generator finally
    // blocks that cannot await, and the outbound is the observed completion
    // signal for the connection lifecycle.
    void this.supervisor
      .cleanupBidi(BidiId.of(this.attachment.bidiId), this.outbound, reason)
      .catch((err) => {
        this.logger.error(
          `cleanup(bidi-closed) failed bidi=${this.attachment.bidiId.substring(0, 8)}: ${(err as Error).message}`
        )
      })
  }

  /**
   * Rotate the streamId without sealing. Used when the IDE issues a
   * new chat request inside the same BiDi — the outbound stays
   * open, but a new TurnId is allocated under the new streamId.
   *
   * NOTE: streamId is read-only on the BidiAttachment (it is the
   * rotation point recorded at attach-time); this method updates a
   * private mutable copy that the supervisor consults.
   */
  private rotatedStreamId: string | undefined
  rotateStreamId(nextStreamId: string): void {
    this.rotatedStreamId = nextStreamId
  }
  currentStreamId(): StreamId {
    return StreamId.of(this.rotatedStreamId ?? this.attachment.streamId)
  }
  currentConversationId(): ConversationId {
    return ConversationId.of(this.attachment.conversationId)
  }
}
