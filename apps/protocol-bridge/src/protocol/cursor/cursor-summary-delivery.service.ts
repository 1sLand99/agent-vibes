import { Injectable, Logger } from "@nestjs/common"
import { CursorGrpcService } from "./cursor-grpc.service"
import { ConversationContextRuntimeService } from "./session/conversation-context-runtime.service"

export interface CursorSummaryCommit {
  conversationId: string
  compactionId: string
  epoch: number
  summary: string
}

export interface CursorSummaryTransport {
  isWritable(): boolean
  write(frame: Buffer): boolean
}

/**
 * Cursor protocol adapter for committed context summaries.
 *
 * Compaction engines publish one semantic commit. The durable runtime owns its
 * delivery state. This adapter is the only component that translates that
 * commit into Cursor's summaryStarted -> summary -> summaryCompleted sequence.
 * A claimed sequence is never replayed after an interrupted write or restart.
 */
@Injectable()
export class CursorSummaryDeliveryService {
  private readonly logger = new Logger(CursorSummaryDeliveryService.name)

  constructor(
    private readonly runtime: ConversationContextRuntimeService,
    private readonly grpc: CursorGrpcService
  ) {}

  enqueue(input: CursorSummaryCommit): void {
    this.runtime.enqueueSummary(input)
  }

  async deliverPending(
    conversationId: string,
    transport: CursorSummaryTransport
  ): Promise<void> {
    if (!transport.isWritable()) return

    for (;;) {
      const delivery = this.runtime.claimNextSummary(conversationId)
      if (!delivery) return

      const written =
        transport.write(this.grpc.createSummaryStartedResponse()) &&
        transport.write(this.grpc.createSummaryResponse(delivery.summary)) &&
        transport.write(this.grpc.createSummaryCompletedResponse())

      if (!written) {
        this.runtime.interruptSummary(delivery)
        this.logger.warn(
          `Cursor summary delivery interrupted for ${conversationId}: ${delivery.compactionId}`
        )
        return
      }

      this.runtime.completeSummary(delivery)
      this.logger.log(
        `Delivered Cursor context summary for ${conversationId}: ${delivery.compactionId}`
      )
      await Promise.resolve()
    }
  }
}
