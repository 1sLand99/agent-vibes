import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { SessionStreamService } from "./session-stream.service"

/**
 * Periodically expires interaction queries whose wall-clock deadline passed.
 *
 * Async ask-question calls do not enter this registry: Cursor represents them
 * as completed native ToolCalls and later returns a ConversationAction.
 *
 * Client Exec messages are deliberately absent: Cursor's official client
 * runtime has no handler for the proto-declared server abort control, so a
 * tool remains owned by its real result or interrupted-pending resolution.
 */
@Injectable()
export class InteractionQueryDeadlineSweeper
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InteractionQueryDeadlineSweeper.name)
  private readonly SWEEP_INTERVAL_MS = 5_000
  private interval: ReturnType<typeof setInterval> | undefined
  private sweepInProgress = false

  constructor(private readonly sessionStream: SessionStreamService) {}

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.sweep()
    }, this.SWEEP_INTERVAL_MS)
    if (typeof this.interval.unref === "function") {
      // Don't keep the process alive just for this sweeper.
      this.interval.unref()
    }
    this.logger.log(
      `InteractionQueryDeadlineSweeper started (interval=${this.SWEEP_INTERVAL_MS}ms)`
    )
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
    }
  }

  /**
   * Public for tests — production callers go through the timer.
   */
  sweep(): void {
    if (this.sweepInProgress) {
      // Sweep tick took longer than interval. Skip rather than pile
      // up — next tick will pick up anything new.
      return
    }
    this.sweepInProgress = true
    try {
      const overdue = this.sessionStream.listOverdueInteractionQueries()
      if (overdue.length === 0) return

      for (const iq of overdue) {
        try {
          this.sessionStream.resolveInteractionQuery(
            iq.conversationId,
            iq.queryId,
            {
              approved: false,
              resultCase: "error",
              rawResponse: { error: "deadline_exceeded" },
            }
          )
        } catch (err) {
          this.logger.error(
            `expire IQ threw for queryId=${iq.queryId} kind=${iq.kind ?? "(none)"} ` +
              `on ${iq.conversationId}: ${(err as Error).message}`
          )
        }
      }

      this.logger.warn(`Expired ${overdue.length} interaction query(s)`)
    } finally {
      this.sweepInProgress = false
    }
  }
}
