import { Injectable, Logger } from "@nestjs/common"
import { ContextStateService } from "../session/context-state.service"
import { AssistantToolBatchService } from "../session/assistant-tool-batch.service"
import {
  SessionLifecycleService,
  type PendingToolCall,
} from "../session/session-lifecycle.service"
import { SubagentExecBridgeService } from "../subagents/subagent-exec-bridge.service"
import { TopLevelAgentTurnRunnerService } from "./top-level-agent-turn-runner.service"
import type { AbortReason } from "../session/tool-call-ledger.service"
import {
  OutboundSealViolationError,
  type TurnOutbound,
} from "../bidi/bidi-outbound"
import { TurnFinalizationError, TurnLifecycle } from "./turn-lifecycle.service"
import {
  type BidiId,
  type CancelReason,
  type ConversationId,
  type TurnId,
} from "./turn.types"

/**
 * Single funnel for every interruption / cleanup path in the bridge.
 *
 * Pre-step-5 the bridge had five distinct unwind sites:
 *   1. `BidiStreamController.seal` (BiDi closed by client)
 *   2. `cursor-connect-stream.handleBidiStream` finally (BiDi
 *      superseded by a new attachment)
 *   3. `cursor-connect-stream.handleChatMessage` supersede (new user
 *      message lands while the previous turn is still in-flight)
 *   4. `cursor-connect-stream` inbound `abort-stream` dispatcher
 *      (user-cancel via `cancelTurnAndAwait`)
 *   5. explicit lifecycle cleanup requests
 *
 * Each site reimplemented its own ordering: some called
 * `outbound.beginSeal+finishSeal` directly, some cancelled the
 * supervisor first, some ran ledger sweeps after the channel was
 * already closed (so abort tool_results never made it back to the
 * IDE). The cleanup coordinator collapses all five into a single
 * 6-step protocol so ordering is uniform and observable:
 *
 *   1. `outbound.beginSeal(reason)` — reject new writes immediately
 *      so a runner that wakes up mid-cancel cannot interleave a frame
 *      between cancel and ledger sweep.
 *   2. snapshot the conversations we will need to ledger-sweep
 *      (capture under the BiDi BEFORE cancellation drops records).
 *   3. `lifecycle.cancelBidiAndAwait(...)` (or `cancelTurnAndAwait`)
 *      — fire AbortSignal, wait for every runner's `finally` to run.
 *   4. `outbound.awaitWritersDrained({ timeout })` — guarantee no
 *      writer remains active before closing the channel.
 *   5. `contextState.abortOpenGraphToolCalls(...)` — atomically transition
 *      open ledger entries to aborted, append structured tool_results, and
 *      advance the mounted graph projection from those committed UUIDs.
 *   6. `outbound.finishSeal()` (or `forceFinishSeal()` on timeout) —
 *      close the channel, emit `onSealed` to the controller.
 *
 * The function resolves only after every required cleanup step has completed.
 * A report containing errors is rejected as `TurnCleanupError`; callers that
 * would start replacement work must not proceed from a partially unwound
 * ownership boundary.
 */
export type CleanupInput =
  | { kind: "bidi-closed"; bidiId: BidiId; outbound: TurnOutbound }
  | {
      kind: "bidi-superseded"
      oldBidiId: BidiId
      newBidiId: BidiId
      outbound: TurnOutbound
    }
  | {
      kind: "turn-superseded"
      oldTurnId: TurnId
      newTurnId: TurnId
      conversationId: ConversationId
    }
  | {
      kind: "user-cancelled"
      turnId: TurnId
      conversationId: ConversationId
      reason: string
    }
  | { kind: "shutdown" }

export interface CleanupReport {
  kind: CleanupInput["kind"]
  cancelledTurnCount: number
  drained: boolean
  abortedToolCallCount: number
  forced: boolean
  errors: string[]
}

/**
 * A cleanup report with errors is not a successful unwind. Callers that are
 * about to install a replacement turn must stop rather than treating a
 * partially-cleared graph as safe ownership for the next turn.
 */
export class TurnCleanupError extends Error {
  readonly report: CleanupReport

  constructor(report: CleanupReport) {
    super(`turn cleanup failed for ${report.kind}: ${report.errors.join("; ")}`)
    this.name = TurnCleanupError.name
    this.report = report
  }
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000

@Injectable()
export class TurnCleanupCoordinator {
  private readonly logger = new Logger(TurnCleanupCoordinator.name)

  constructor(
    private readonly lifecycle: TurnLifecycle,
    private readonly contextState: ContextStateService,
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly subagentExecBridge: SubagentExecBridgeService,
    private readonly assistantToolBatch: AssistantToolBatchService,
    private readonly topLevelAgentTurnRunner: TopLevelAgentTurnRunnerService
  ) {}

  async cleanup(
    input: CleanupInput,
    opts: { drainTimeoutMs?: number } = {}
  ): Promise<CleanupReport> {
    const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    const errors: string[] = []
    let cancelledTurnCount = 0
    let abortedToolCallCount = 0
    let drained = true
    let forced = false

    try {
      switch (input.kind) {
        case "bidi-closed":
        case "bidi-superseded": {
          const result = await this.unwindBidi(
            input.kind === "bidi-closed" ? input.bidiId : input.oldBidiId,
            input.outbound,
            mapReasonForBidi(input),
            mapAbortReasonForBidi(input.kind),
            drainTimeoutMs,
            errors
          )
          cancelledTurnCount = result.cancelled
          abortedToolCallCount = result.abortedToolCalls
          drained = result.drained
          forced = result.forced
          break
        }
        case "turn-superseded": {
          const result = await this.unwindTurn(
            input.oldTurnId,
            input.conversationId,
            { kind: "superseded", by: input.newTurnId },
            "turn_superseded",
            errors
          )
          cancelledTurnCount = result.cancelled
          abortedToolCallCount = result.abortedToolCalls
          break
        }
        case "user-cancelled": {
          const result = await this.unwindTurn(
            input.turnId,
            input.conversationId,
            { kind: "user-cancel", reason: input.reason },
            "user_cancelled",
            errors
          )
          cancelledTurnCount = result.cancelled
          abortedToolCallCount = result.abortedToolCalls
          break
        }
        case "shutdown": {
          // Shutdown is process-wide; per-bidi seal happens through
          // the per-controller seal path. Coordinator's job here is
          // just to drive lifecycle.cancelConversation through the
          // same audit-log discipline as the other entry points.
          // The actual outbound seal arrives via each controller's
          // own seal() handler (which calls back into this method
          // with kind=bidi-closed).
          break
        }
      }
    } catch (err) {
      errors.push(`cleanup(${input.kind}): ${(err as Error).message}`)
    }

    const report: CleanupReport = {
      kind: input.kind,
      cancelledTurnCount,
      drained,
      abortedToolCallCount,
      forced,
      errors,
    }

    this.logger.log(
      `[cleanup] kind=${input.kind} cancelled=${cancelledTurnCount} ` +
        `drained=${drained} forced=${forced} ` +
        `tool_aborts=${abortedToolCallCount}` +
        (errors.length > 0 ? ` errors=${errors.length}` : "")
    )

    if (errors.length > 0) {
      this.logger.error(
        `[cleanup] failed kind=${input.kind}: ${errors.join("; ")}`
      )
      throw new TurnCleanupError(report)
    }

    return report
  }

  // ── internal: bidi unwind ────────────────────────────────────────

  private async unwindBidi(
    bidiId: BidiId,
    outbound: TurnOutbound,
    cancelReason: CancelReason,
    abortReason: AbortReason | undefined,
    drainTimeoutMs: number,
    errors: string[]
  ): Promise<{
    cancelled: number
    abortedToolCalls: number
    drained: boolean
    forced: boolean
  }> {
    // Step 1: stop accepting new writes.
    outbound.beginSeal(
      cancelReason.kind === "superseded"
        ? {
            kind: "superseded-by",
            supersedingStreamId: cancelReason.by as unknown as string,
          }
        : cancelReason.kind === "shutdown"
          ? { kind: "shutdown" }
          : { kind: "bidi-closed" }
    )

    // Step 2: snapshot turn → conversation pairs BEFORE cancellation
    // because cancelBidi cascades into driveRunner's finally, which
    // detaches the records.
    const snapshot = this.lifecycle.listTurnsForBidi(bidiId)

    // Step 3: cancel and await every lifecycle-committed terminal.
    let cancelled = 0
    let turnsSettled = true
    let terminalFinalizationFailed = false
    try {
      const terminals = await this.lifecycle.cancelBidiAndAwait(
        bidiId,
        cancelReason
      )
      cancelled = terminals.length
      const failedTerminal = terminals.find(
        (terminal) =>
          terminal.status === "failed" &&
          terminal.error instanceof TurnFinalizationError
      )
      if (failedTerminal?.status === "failed") {
        terminalFinalizationFailed = true
        errors.push(
          `cancelBidiAndAwait terminal failed: ${failedTerminal.error.message}`
        )
      }
    } catch (err) {
      turnsSettled = false
      errors.push(`cancelBidiAndAwait: ${(err as Error).message}`)
    }

    // Step 4: drain writers.
    let drained = true
    let forced = false
    try {
      const result = await outbound.awaitWritersDrained({
        timeoutMs: drainTimeoutMs,
      })
      drained = result.drained
      if (!drained) {
        errors.push(
          `awaitWritersDrained: timeout after ${drainTimeoutMs}ms for bidi=${bidiId}`
        )
        this.logger.error(
          `outbound writers did not drain in ${drainTimeoutMs}ms ` +
            `bidi=${bidiId.substring(0, 8)} remaining=${result.remaining.length}`
        )
      }
    } catch (err) {
      drained = false
      errors.push(`awaitWritersDrained: ${(err as Error).message}`)
    }

    // Step 5: an explicit supersede terminates graph edges and then clears
    // their runtime waiters. A plain BiDi close is only a transport detach:
    // Cursor may reconnect with resumeAction, so graph, pending state, batch
    // barriers and durable outbox bytes must remain intact.
    let abortedToolCalls = 0
    if (abortReason && turnsSettled && !terminalFinalizationFailed) {
      const sweptTurns = new Set<string>()
      for (const { turnId, conversationId } of snapshot) {
        const sweepKey = `${conversationId}\u0000${turnId}`
        if (sweptTurns.has(sweepKey)) continue
        sweptTurns.add(sweepKey)
        let graphAbortCommitted = false
        try {
          abortedToolCalls += this.sweepConversation(
            conversationId,
            turnId,
            abortReason
          )
          this.clearCommittedRuntimeToolCalls(
            conversationId,
            turnId,
            abortReason
          )
          graphAbortCommitted = true
        } catch (err) {
          errors.push(`sweep(${conversationId}): ${(err as Error).message}`)
        }
        if (!graphAbortCommitted) continue
        try {
          this.assistantToolBatch.abortGraphTurn(conversationId, turnId)
          this.topLevelAgentTurnRunner.abortGraphTurn(conversationId, turnId)
        } catch (err) {
          errors.push(
            `clear runtime graph state(${conversationId}): ${(err as Error).message}`
          )
        }
      }
    }

    // Step 6: close the channel.
    try {
      if (drained) {
        outbound.finishSeal()
      } else {
        const { lostWriters } = outbound.forceFinishSeal()
        if (lostWriters.length > 0) {
          forced = true
        }
      }
    } catch (err) {
      if (err instanceof OutboundSealViolationError) {
        // Drained said true but a writer was racing us — force-close
        // and surface for telemetry.
        outbound.forceFinishSeal()
        forced = true
        errors.push(`finishSeal violated drained contract: ${err.message}`)
      } else {
        errors.push(`finishSeal: ${(err as Error).message}`)
      }
    }

    return { cancelled, abortedToolCalls, drained, forced }
  }

  // ── internal: per-turn unwind (supersede / user-cancel) ─────────

  private async unwindTurn(
    turnId: TurnId,
    conversationId: ConversationId,
    cancelReason: CancelReason,
    abortReason: AbortReason,
    errors: string[]
  ): Promise<{ cancelled: number; abortedToolCalls: number }> {
    let cancelled = 0
    try {
      const result = await this.lifecycle.cancelTurnAndAwait(
        turnId,
        cancelReason
      )
      if (result) {
        cancelled = 1
        if (
          result.status === "failed" &&
          result.error instanceof TurnFinalizationError
        ) {
          errors.push(
            `cancelTurnAndAwait terminal failed: ${result.error.message}`
          )
          return { cancelled, abortedToolCalls: 0 }
        }
      }
    } catch (err) {
      errors.push(`cancelTurnAndAwait: ${(err as Error).message}`)
      return { cancelled, abortedToolCalls: 0 }
    }

    let abortedToolCalls = 0
    let graphAbortCommitted = false
    try {
      abortedToolCalls += this.sweepConversation(
        conversationId,
        turnId,
        abortReason
      )
      this.clearCommittedRuntimeToolCalls(conversationId, turnId, abortReason)
      graphAbortCommitted = true
    } catch (err) {
      errors.push(`sweep(${conversationId}): ${(err as Error).message}`)
    }
    if (!graphAbortCommitted) return { cancelled, abortedToolCalls }
    try {
      this.assistantToolBatch.abortGraphTurn(conversationId, turnId)
      this.topLevelAgentTurnRunner.abortGraphTurn(conversationId, turnId)
    } catch (err) {
      errors.push(
        `clear runtime graph state(${conversationId}): ${(err as Error).message}`
      )
    }
    return { cancelled, abortedToolCalls }
  }

  /**
   * Clear process-local pending entries only after ContextState has committed
   * the canonical graph/ledger/outbox terminal facts. Sub-agent waiters are
   * rejected by exact tool id so sibling branches remain isolated.
   */
  private clearCommittedRuntimeToolCalls(
    conversationId: ConversationId,
    turnId: TurnId,
    reason: AbortReason,
    selectedToolCallIds?: ReadonlySet<string>
  ): number {
    const entries = this.sessionLifecycle
      .pendingToolListForTurn<PendingToolCall>(conversationId, turnId)
      .filter(
        (entry) =>
          !selectedToolCallIds || selectedToolCallIds.has(entry.toolCallId)
      )
    for (const entry of entries) {
      if (entry.payload?.sidechainOwner) {
        this.subagentExecBridge.rejectToolCall(
          String(conversationId),
          entry.payload.sidechainOwner,
          entry.toolCallId,
          new Error(reason)
        )
      }
    }
    if (!selectedToolCallIds) {
      return this.sessionLifecycle.clearPendingToolCallsForTurn(
        conversationId,
        turnId,
        `graph abort committed: ${reason}`
      ).length
    }
    let cleared = 0
    for (const entry of entries) {
      if (
        this.sessionLifecycle.clearPendingToolCall(
          String(conversationId),
          entry.toolCallId,
          `graph abort committed: ${reason}`
        )
      ) {
        cleared += 1
      }
    }
    return cleared
  }

  // ── shared sweep helper ──────────────────────────────────────────

  /**
   * Inside a single SQLite transaction, transition every open ledger
   * entry for the (conversation, turn) pair to `aborted` and append
   * the matching synthetic `is_error: true` tool_result blocks so
   * the transcript carries a structured `[abort:{reason}]` payload
   * the next backend request can ingest without sanitize repair.
   */
  private sweepConversation(
    conversationId: ConversationId,
    turnId: TurnId,
    abortReason: AbortReason
  ): number {
    return this.contextState.abortOpenGraphToolCalls(conversationId, {
      turnId,
      reason: abortReason,
    })
  }
}

function mapReasonForBidi(
  input: Extract<CleanupInput, { kind: "bidi-closed" | "bidi-superseded" }>
): CancelReason {
  if (input.kind === "bidi-superseded") {
    // A superseded BiDi is structurally a bidi-close from the
    // lifecycle's perspective — there is no parent turn to anchor a
    // `superseded` cancel against, and the new BiDi already has its
    // own umbrella. Use bidi-closed so cancelTurn cascades correctly.
    return { kind: "bidi-closed" }
  }
  return { kind: "bidi-closed" }
}

function mapAbortReasonForBidi(
  kind: "bidi-closed" | "bidi-superseded"
): AbortReason | undefined {
  return kind === "bidi-superseded" ? "turn_superseded" : undefined
}
