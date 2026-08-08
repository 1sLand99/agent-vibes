import { Injectable, Logger } from "@nestjs/common"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { ConversationId } from "../turn/turn.types"

const EXEC_DISPATCH_QUEUE_PRESSURE_THRESHOLD = 8

export interface SerializedExecDispatch {
  execId: number
  /** Exact opaque Cursor exec id needed for durable outbox transitions. */
  protocolExecId: string
  frame: Buffer
  label: string
}

/**
 * The writer must report whether the frame reached its owning outbound. The
 * callback owns the durable outbox transitions around that write:
 *
 *   beginDelivery → write → markDelivered
 *
 * Returning `not_written` means the caller has already restored the durable
 * row to `queued` (or cancelled it through an explicit teardown path).
 */
export type ExecDispatchWriteOutcome = "written" | "not_written"

export type ExecDispatchWriter = (
  dispatch: SerializedExecDispatch
) => ExecDispatchWriteOutcome

export type ExecDispatchSerializerOutcome =
  | { kind: "queued"; execId: number }
  | { kind: "written"; execId: number }
  | { kind: "not_written"; execId: number }
  | { kind: "released"; execId: number }
  | { kind: "ignored"; execId: number }

/**
 * Per-conversation, per-BiDi in-memory serializer for durable outbox entries.
 *
 * It never decides whether a frame was sent: the supplied writer must return
 * an explicit outcome after moving the corresponding durable outbox row. On a
 * `not_written` outcome this serializer drops only its in-memory schedule;
 * durable queued entries remain available for explicit replay.
 */
@Injectable()
export class ExecDispatchSerializerService {
  private readonly logger = new Logger(ExecDispatchSerializerService.name)

  private readonly stateByStream = new Map<
    string,
    {
      inFlight?: SerializedExecDispatch & { sentAt: Date }
      queue: Array<SerializedExecDispatch & { queuedAt: number }>
      writer: ExecDispatchWriter
      queuePressureNotified?: boolean
    }
  >()

  /**
   * Schedule one durable outbox entry. The first entry is offered to the
   * writer immediately; later entries stay FIFO until the prior exact slot is
   * released.
   */
  enqueueAndDispatch(
    conversationId: string,
    streamEpoch: string,
    dispatch: SerializedExecDispatch,
    writer: ExecDispatchWriter
  ): ExecDispatchSerializerOutcome {
    this.assertDispatch(dispatch, "enqueueAndDispatch")
    const state = this.getOrCreateState(conversationId, streamEpoch, writer)
    state.writer = writer
    if (state.inFlight) {
      this.assertNotScheduled(state, dispatch, "enqueueAndDispatch")
      state.queue.push({ ...this.copyDispatch(dispatch), queuedAt: Date.now() })
      this.logQueued(conversationId, streamEpoch, dispatch, state)
      return { kind: "queued", execId: dispatch.execId }
    }

    return this.dispatchNow(
      conversationId,
      streamEpoch,
      state,
      dispatch,
      writer
    )
  }

  /**
   * Replay an explicit, already-persisted queued set after reattachment. The
   * caller supplies the durable order (normally `listQueuedForReplay` order).
   * Existing in-memory scheduling is rejected rather than merged heuristically.
   */
  replayQueued(
    conversationId: string,
    streamEpoch: string,
    dispatches: readonly SerializedExecDispatch[],
    writer: ExecDispatchWriter
  ): ExecDispatchSerializerOutcome[] {
    const key = this.streamKey(conversationId, streamEpoch)
    if (dispatches.length === 0) return []
    if (this.stateByStream.has(key)) {
      throw new Error(
        `ExecDispatchSerializerService.replayQueued: stream already has in-memory scheduling ` +
          `conversation=${conversationId} streamEpoch=${streamEpoch}`
      )
    }

    const outcomes: ExecDispatchSerializerOutcome[] = []
    for (const dispatch of dispatches) {
      const outcome = this.enqueueAndDispatch(
        conversationId,
        streamEpoch,
        dispatch,
        writer
      )
      outcomes.push(outcome)
      if (outcome.kind === "not_written") {
        // The writer has explicitly preserved durable recovery state. Do not
        // make later entries appear ordered behind a transport that is gone.
        this.clearStream(conversationId, streamEpoch)
        break
      }
    }
    return outcomes
  }

  /**
   * Release the exact in-flight slot after its protocol control/result path
   * has completed. If a queued frame is next, it is offered to the writer.
   */
  release(
    conversationId: string,
    streamEpoch: string,
    execId: number,
    writer: ExecDispatchWriter
  ): ExecDispatchSerializerOutcome {
    this.assertExecId(execId, "release")
    const state = this.stateByStream.get(
      this.streamKey(conversationId, streamEpoch)
    )
    if (!state || !state.inFlight || state.inFlight.execId !== execId) {
      return { kind: "ignored", execId }
    }
    state.writer = writer

    const released = state.inFlight
    state.inFlight = undefined
    this.logger.debug(
      `ExecDispatch released: conversation=${conversationId} streamEpoch=${streamEpoch} ` +
        `execId=${released.execId} label=${released.label} ` +
        `held_ms=${Date.now() - released.sentAt.getTime()} queueDepth=${state.queue.length}`
    )
    return this.dispatchNext(conversationId, streamEpoch, state, execId, writer)
  }

  /**
   * Remove exact cancelled slots from this stream's in-memory schedule. The
   * caller must first move the matching durable rows to `cancelled`.
   */
  cancel(
    conversationId: string,
    streamEpoch: string,
    execIds: Iterable<number>,
    writer: ExecDispatchWriter
  ): ExecDispatchSerializerOutcome {
    const key = this.streamKey(conversationId, streamEpoch)
    const ids = new Set<number>()
    for (const execId of execIds) {
      if (!Number.isFinite(execId) || execId <= 0) continue
      ids.add(Math.floor(execId))
    }
    if (ids.size === 0) {
      return { kind: "ignored", execId: 0 }
    }

    const state = this.stateByStream.get(key)
    if (!state) return { kind: "ignored", execId: Array.from(ids)[0]! }
    state.writer = writer

    const beforeQueueDepth = state.queue.length
    state.queue = state.queue.filter((entry) => !ids.has(entry.execId))
    const droppedQueued = beforeQueueDepth - state.queue.length

    if (!state.inFlight || !ids.has(state.inFlight.execId)) {
      if (droppedQueued > 0) {
        this.logger.debug(
          `ExecDispatch cancelled queued: conversation=${conversationId} ` +
            `streamEpoch=${streamEpoch} execIds=${Array.from(ids).join(",")} ` +
            `droppedQueued=${droppedQueued} queueDepth=${state.queue.length}`
        )
      }
      this.maybeCleanup(conversationId, streamEpoch, state)
      return { kind: "ignored", execId: Array.from(ids)[0]! }
    }

    const cancelled = state.inFlight
    state.inFlight = undefined
    this.logger.debug(
      `ExecDispatch cancelled: conversation=${conversationId} streamEpoch=${streamEpoch} ` +
        `execId=${cancelled.execId} label=${cancelled.label} ` +
        `held_ms=${Date.now() - cancelled.sentAt.getTime()} ` +
        `droppedQueued=${droppedQueued} queueDepth=${state.queue.length}`
    )
    return this.dispatchNext(
      conversationId,
      streamEpoch,
      state,
      cancelled.execId,
      writer
    )
  }

  /**
   * Remove slots whose durable cancellation already committed with graph
   * cleanup. The stream's registered writer is reused so an unaffected FIFO
   * successor can be delivered without giving the cleanup layer transport
   * ownership.
   */
  cancelCommitted(
    conversationId: string,
    streamEpoch: string,
    execIds: Iterable<number>
  ): ExecDispatchSerializerOutcome {
    const state = this.stateByStream.get(
      this.streamKey(conversationId, streamEpoch)
    )
    if (!state) {
      return { kind: "ignored", execId: 0 }
    }
    try {
      return this.cancel(conversationId, streamEpoch, execIds, state.writer)
    } catch (error) {
      // The durable cancellation is already terminal. dispatchNow removes the
      // ephemeral schedule and the writer re-queues an unwritten successor in
      // the outbox, so surfacing this error would only misreport the committed
      // graph cleanup as retryable.
      this.logger.error(
        `ExecDispatch post-commit cancellation reconciliation failed: ` +
          `conversation=${conversationId} streamEpoch=${streamEpoch} ` +
          `${String(error)}`
      )
      return { kind: "not_written", execId: 0 }
    }
  }

  /** Drop ephemeral scheduling only; durable outbox rows remain untouched. */
  clearStream(conversationId: string, streamEpoch: string): void {
    const key = this.streamKey(conversationId, streamEpoch)
    const state = this.stateByStream.get(key)
    if (!state) return
    if (state.inFlight || state.queue.length > 0) {
      this.logger.debug(
        `ExecDispatch clear: conversation=${conversationId} streamEpoch=${streamEpoch} ` +
          `dropped in-flight=${state.inFlight ? state.inFlight.execId : "(none)"} ` +
          `queueDepth=${state.queue.length}`
      )
    }
    this.stateByStream.delete(key)
  }

  snapshot(
    conversationId: string,
    streamEpoch: string
  ):
    | {
        inFlight?: { execId: number; label: string; sentAt: Date }
        queueDepth: number
        queuedExecIds: number[]
      }
    | undefined {
    const state = this.stateByStream.get(
      this.streamKey(conversationId, streamEpoch)
    )
    if (!state) return undefined
    return {
      inFlight: state.inFlight
        ? {
            execId: state.inFlight.execId,
            label: state.inFlight.label,
            sentAt: new Date(state.inFlight.sentAt),
          }
        : undefined,
      queueDepth: state.queue.length,
      queuedExecIds: state.queue.map((entry) => entry.execId),
    }
  }

  private dispatchNext(
    conversationId: string,
    streamEpoch: string,
    state: NonNullable<ReturnType<typeof this.stateByStream.get>>,
    releasedExecId: number,
    writer: ExecDispatchWriter
  ): ExecDispatchSerializerOutcome {
    const next = state.queue.shift()
    if (state.queue.length < EXEC_DISPATCH_QUEUE_PRESSURE_THRESHOLD) {
      state.queuePressureNotified = false
    }
    if (!next) {
      this.maybeCleanup(conversationId, streamEpoch, state)
      return { kind: "released", execId: releasedExecId }
    }
    return this.dispatchNow(conversationId, streamEpoch, state, next, writer)
  }

  private dispatchNow(
    conversationId: string,
    streamEpoch: string,
    state: NonNullable<ReturnType<typeof this.stateByStream.get>>,
    dispatch: SerializedExecDispatch,
    writer: ExecDispatchWriter
  ): ExecDispatchSerializerOutcome {
    const copied = this.copyDispatch(dispatch)
    state.inFlight = { ...copied, sentAt: new Date() }
    this.logger.debug(
      `ExecDispatch dispatch: conversation=${conversationId} streamEpoch=${streamEpoch} ` +
        `execId=${copied.execId} label=${copied.label}`
    )
    let outcome: ExecDispatchWriteOutcome
    try {
      outcome = writer(copied)
    } catch (error) {
      this.stateByStream.delete(this.streamKey(conversationId, streamEpoch))
      throw error
    }
    if (outcome === "written") {
      return { kind: "written", execId: copied.execId }
    }
    if (outcome !== "not_written") {
      this.stateByStream.delete(this.streamKey(conversationId, streamEpoch))
      throw new Error(
        `ExecDispatchSerializerService writer returned invalid outcome for ` +
          `conversation=${conversationId} streamEpoch=${streamEpoch} execId=${copied.execId}`
      )
    }

    // Do not retain later in-memory queue entries after an explicit failed
    // write. Their durable rows are still queued and an explicit replay owns
    // the next attempt.
    this.stateByStream.delete(this.streamKey(conversationId, streamEpoch))
    return { kind: "not_written", execId: copied.execId }
  }

  private logQueued(
    conversationId: string,
    streamEpoch: string,
    dispatch: SerializedExecDispatch,
    state: NonNullable<ReturnType<typeof this.stateByStream.get>>
  ): void {
    this.logger.debug(
      `ExecDispatch queued: conversation=${conversationId} streamEpoch=${streamEpoch} ` +
        `execId=${dispatch.execId} label=${dispatch.label} ` +
        `(in-flight execId=${state.inFlight?.execId ?? "(none)"}, ` +
        `queueDepth=${state.queue.length})`
    )
    if (
      !state.queuePressureNotified &&
      state.queue.length >= EXEC_DISPATCH_QUEUE_PRESSURE_THRESHOLD
    ) {
      state.queuePressureNotified = true
      this.logger.warn(
        `ExecDispatch queue pressure: conversation=${conversationId} ` +
          `streamEpoch=${streamEpoch} queueDepth=${state.queue.length} ` +
          `inFlightExecId=${state.inFlight?.execId ?? "(none)"}`
      )
    }
  }

  private assertNotScheduled(
    state: NonNullable<ReturnType<typeof this.stateByStream.get>>,
    dispatch: SerializedExecDispatch,
    operation: string
  ): void {
    if (
      state.inFlight?.execId === dispatch.execId ||
      state.queue.some((entry) => entry.execId === dispatch.execId)
    ) {
      throw new Error(
        `ExecDispatchSerializerService.${operation}: execId=${dispatch.execId} ` +
          "is already scheduled for this stream"
      )
    }
  }

  private assertDispatch(
    dispatch: SerializedExecDispatch,
    operation: string
  ): void {
    this.assertExecId(dispatch.execId, operation)
    requireExactDurableIdentifier(
      dispatch.protocolExecId,
      `ExecDispatchSerializerService.${operation}: protocolExecId`
    )
    if (!Buffer.isBuffer(dispatch.frame) || dispatch.frame.length === 0) {
      throw new Error(
        `ExecDispatchSerializerService.${operation}: frame must be a non-empty Buffer`
      )
    }
    if (!dispatch.label.trim()) {
      throw new Error(
        `ExecDispatchSerializerService.${operation}: label is required`
      )
    }
  }

  private assertExecId(execId: number, operation: string): void {
    if (!Number.isFinite(execId) || execId <= 0 || !Number.isInteger(execId)) {
      throw new Error(
        `ExecDispatchSerializerService.${operation}: execId must be a positive integer`
      )
    }
  }

  private copyDispatch(
    dispatch: SerializedExecDispatch
  ): SerializedExecDispatch {
    return {
      execId: dispatch.execId,
      protocolExecId: dispatch.protocolExecId,
      frame: Buffer.from(dispatch.frame),
      label: dispatch.label,
    }
  }

  private getOrCreateState(
    conversationId: string,
    streamEpoch: string,
    writer: ExecDispatchWriter
  ): NonNullable<ReturnType<typeof this.stateByStream.get>> {
    const key = this.streamKey(conversationId, streamEpoch)
    let state = this.stateByStream.get(key)
    if (!state) {
      state = { queue: [], writer }
      this.stateByStream.set(key, state)
    }
    return state
  }

  private maybeCleanup(
    conversationId: string,
    streamEpoch: string,
    state: { inFlight?: unknown; queue: unknown[] }
  ): void {
    if (!state.inFlight && state.queue.length === 0) {
      this.stateByStream.delete(this.streamKey(conversationId, streamEpoch))
    }
  }

  private streamKey(conversationId: string, streamEpoch: string): string {
    const exactConversationId = ConversationId.of(conversationId)
    const exactStreamEpoch = requireExactDurableIdentifier(
      streamEpoch,
      "ExecDispatchSerializerService streamEpoch"
    )
    return `${exactConversationId}\u0000${exactStreamEpoch}`
  }
}
