import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import { SessionStreamService } from "./session-stream.service"

/**
 * The proto shape `extractInteractionResultCase` walks, carrying an error the
 * model can read, so an expired query reads like any other failed response.
 */
function expiredInteractionRawResponse(kind: string | undefined): unknown {
  // Kinds read `deferred_tool:web_search`; only the tool half means anything
  // to the model reading this back.
  const tool = kind?.split(":").pop()?.trim()
  const what = tool ? `${tool} ` : ""
  return {
    result: {
      case: "expired",
      value: {
        result: {
          case: "error",
          value: {
            error:
              `the ${what}request expired because it was not answered before ` +
              `its deadline`,
          },
        },
      },
    },
  }
}

/**
 * Periodically expires interaction queries whose wall-clock deadline passed,
 * and hands each expiry to the writer that closes its tool call. Resolving
 * alone is not enough: a deferred tool's query is emitted and never awaited,
 * so an expiry that stops at `resolve` leaves the tool call pending forever.
 *
 * Queries answered by a person carry no deadline and never appear here, which
 * is why an answer given hours later is still the answer to that question.
 *
 * Async ask-question calls do not enter this registry either: Cursor
 * represents them as completed native ToolCalls and later returns a
 * ConversationAction.
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
      void this.sweep().catch((err: unknown) => {
        this.logger.error(
          `interaction query sweep failed: ${(err as Error).message}`
        )
      })
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
  async sweep(): Promise<void> {
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
          // Resolving is not enough. Nothing awaits the promise a deferred
          // tool's query hands out, so an expiry has to travel the same route
          // a real response does and write the tool result itself; otherwise
          // the query disappears and its tool call waits forever.
          await this.sessionStream.expireInteractionQuery(
            iq.conversationId,
            iq.queryId,
            expiredInteractionRawResponse(iq.kind)
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
