import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common"

import {
  SubagentRunStore,
  type SubagentRunMode,
  type SubagentRunRecord,
} from "../session/subagent-run-store.service"
import { TurnLifecycle } from "../turn/turn-lifecycle.service"
import {
  ConversationId,
  type TurnId,
  type TurnTerminalResult,
} from "../turn/turn.types"

export interface SubagentRuntimeHandle {
  conversationId: ConversationId
  agentId: string
  executionTurnId: TurnId
  mode: SubagentRunMode
}

/**
 * Process-local handles for durable sub-agent runs.
 *
 * SQLite is the sole lifecycle authority. This registry only connects the
 * current execution turn to cancellation and structured waiting; it never
 * infers status from transcript files or from the presence of a Map entry.
 */
@Injectable()
export class SubagentTaskRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(SubagentTaskRegistry.name)
  private readonly handles = new Map<string, SubagentRuntimeHandle>()

  constructor(
    private readonly runs: SubagentRunStore,
    private readonly turns: TurnLifecycle
  ) {}

  async onModuleDestroy(): Promise<void> {
    const active = [...this.handles.values()]
    for (const handle of active) {
      this.turns.cancelTurn(handle.executionTurnId, { kind: "shutdown" })
    }
    await Promise.all(
      active.map(
        (handle) =>
          this.turns.awaitTurn(handle.executionTurnId) ?? Promise.resolve()
      )
    )
    this.handles.clear()
  }

  register(handle: SubagentRuntimeHandle): void {
    const key = this.key(handle.conversationId, handle.agentId)
    if (this.handles.has(key)) {
      throw new Error(
        `SubagentTaskRegistry.register: duplicate runtime handle ` +
          `conversation=${handle.conversationId} agentId=${handle.agentId}`
      )
    }
    this.assertDurableOwner(handle)
    const terminal = this.requireActiveExecution(handle, "register")
    this.handles.set(key, { ...handle })
    this.observe(handle, terminal)
  }

  /** Replace the foreground execution only after the durable handoff commits. */
  replaceExecution(
    expectedExecutionTurnId: TurnId,
    next: SubagentRuntimeHandle
  ): void {
    const key = this.key(next.conversationId, next.agentId)
    const current = this.handles.get(key)
    if (!current || current.executionTurnId !== expectedExecutionTurnId) {
      throw new Error(
        `SubagentTaskRegistry.replaceExecution: runtime owner mismatch ` +
          `conversation=${next.conversationId} agentId=${next.agentId}`
      )
    }
    this.assertDurableOwner(next)
    const terminal = this.requireActiveExecution(next, "replaceExecution")
    this.handles.set(key, { ...next })
    this.observe(next, terminal)
  }

  getRun(
    conversationId: ConversationId,
    agentId: string
  ): SubagentRunRecord | undefined {
    return this.runs.get(conversationId, agentId)
  }

  isRunning(conversationId: ConversationId, agentId: string): boolean {
    return this.runs.get(conversationId, agentId)?.status === "running"
  }

  listRunning(conversationId?: ConversationId): SubagentRuntimeHandle[] {
    return [...this.handles.values()]
      .filter(
        (handle) =>
          conversationId === undefined ||
          handle.conversationId === conversationId
      )
      .map((handle) => ({ ...handle }))
  }

  kill(
    conversationId: ConversationId,
    agentId: string
  ): "cancelled" | "already_terminal" | "missing_runtime" | "missing" {
    // A foreground → background handoff swaps the durable execution and the
    // process-local handle in adjacent synchronous operations. Re-read once
    // if we observe that boundary so `kill_agent` never reports a missing
    // handle for a live successor.
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = this.runs.get(conversationId, agentId)
      if (!run) return "missing"
      if (run.status !== "running") return "already_terminal"
      const handle = this.handles.get(this.key(conversationId, agentId))
      if (handle && handle.executionTurnId === run.executionTurnId) {
        this.turns.cancelTurn(handle.executionTurnId, {
          kind: "subagent-killed",
          agentId,
        })
        return "cancelled"
      }

      const afterMismatch = this.runs.get(conversationId, agentId)
      if (
        !afterMismatch ||
        afterMismatch.status !== "running" ||
        afterMismatch.executionTurnId === run.executionTurnId
      ) {
        return afterMismatch?.status === "running"
          ? "missing_runtime"
          : afterMismatch
            ? "already_terminal"
            : "missing"
      }
    }
    return "missing_runtime"
  }

  async awaitDone(
    conversationId: ConversationId,
    agentId: string,
    signal: AbortSignal
  ): Promise<SubagentRunRecord> {
    // This loop follows the *durable* execution owner. It is intentionally
    // not a single await on whichever TurnHandle was current at entry: a
    // legal foreground → background handoff terminalizes the foreground turn
    // while the logical run remains running on its replacement turn.
    for (;;) {
      signal.throwIfAborted()
      const observed = this.runs.get(conversationId, agentId)
      if (!observed) {
        throw new Error(`Unknown sub-agent: ${agentId}`)
      }
      if (observed.status !== "running") return observed

      const handle = this.handles.get(this.key(conversationId, agentId))
      if (!handle || handle.executionTurnId !== observed.executionTurnId) {
        const afterLookup = this.runs.get(conversationId, agentId)
        if (afterLookup && afterLookup.status !== "running") return afterLookup
        if (
          afterLookup &&
          afterLookup.executionTurnId !== observed.executionTurnId
        ) {
          // The handoff committed between the durable read and registry read.
          continue
        }
        throw new Error(
          `Sub-agent ${agentId} is durably running without its execution handle`
        )
      }

      const terminal = this.turns.awaitTurn(handle.executionTurnId)
      if (!terminal) {
        const afterLookup = this.runs.get(conversationId, agentId)
        if (afterLookup && afterLookup.status !== "running") return afterLookup
        if (
          afterLookup &&
          afterLookup.executionTurnId !== observed.executionTurnId
        ) {
          continue
        }
        throw new Error(`Sub-agent ${agentId} execution turn is not active`)
      }

      await this.waitForTerminalOrAbort(terminal, signal)
      const afterTerminal = this.runs.get(conversationId, agentId)
      if (!afterTerminal) {
        throw new Error(
          `Sub-agent ${agentId} disappeared after execution ended`
        )
      }
      if (afterTerminal.status !== "running") return afterTerminal
      if (afterTerminal.executionTurnId !== observed.executionTurnId) {
        // The foreground terminal was the official handoff boundary. Await
        // the newly installed background execution rather than treating a
        // healthy successor as an orphaned run.
        continue
      }
      throw new Error(
        `Sub-agent ${agentId} execution ended without a durable terminal outcome`
      )
    }
  }

  private requireActiveExecution(
    handle: SubagentRuntimeHandle,
    operation: "register" | "replaceExecution"
  ): Promise<TurnTerminalResult> {
    const terminal = this.turns.awaitTurn(handle.executionTurnId)
    if (!terminal) {
      throw new Error(
        `SubagentTaskRegistry.${operation}: execution turn is not active: ${handle.executionTurnId}`
      )
    }
    return terminal
  }

  private observe(
    handle: SubagentRuntimeHandle,
    terminal: Promise<TurnTerminalResult>
  ): void {
    // `terminalPromise` itself never rejects, but the durable orphan guard
    // can. Do not create an unowned rejected promise during a shutdown or a
    // malformed runner path; logging is the only safe action once the turn
    // has already reached its lifecycle terminal state.
    void terminal.then(
      (result) => {
        try {
          this.onExecutionTerminal(handle, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          this.logger.error(
            `Sub-agent terminal reconciliation failed: ` +
              `conversation=${handle.conversationId} agentId=${handle.agentId} ` +
              `turn=${handle.executionTurnId} error=${message}`
          )
        }
      },
      (error) => {
        // Defensive only: TurnLifecycle promises are specified not to reject.
        this.logger.error(
          `Sub-agent terminal promise rejected: conversation=${handle.conversationId} ` +
            `agentId=${handle.agentId} turn=${handle.executionTurnId} ` +
            `error=${error instanceof Error ? error.message : String(error)}`
        )
      }
    )
  }

  private onExecutionTerminal(
    observed: SubagentRuntimeHandle,
    result: TurnTerminalResult
  ): void {
    const key = this.key(observed.conversationId, observed.agentId)
    const current = this.handles.get(key)
    // A foreground-to-background handoff installs its successor before the
    // old turn unwinds. The old observer must not delete or terminalize it.
    if (!current || current.executionTurnId !== observed.executionTurnId) {
      return
    }
    this.handles.delete(key)

    const run = this.runs.get(observed.conversationId, observed.agentId)
    if (
      !run ||
      run.status !== "running" ||
      run.executionTurnId !== observed.executionTurnId
    ) {
      return
    }

    // Do not synthesize a durable terminal state here. A terminal run must
    // commit in the same graph transaction as either its parent `task`
    // tool_result or its explicit background notification. This observer has
    // neither graph ownership nor a delivery slot, so using it as a fallback
    // would create a second lifecycle authority and an unpaired terminal.
    //
    // The turn finalizer is required to perform that atomic transition. If it
    // did not, preserve the running record for the explicit graph-recovery
    // path and make the invariant violation visible rather than fabricating a
    // plausible failure result.
    this.logger.error(
      `Sub-agent turn ended without an atomic durable terminal transition: ` +
        `conversation=${observed.conversationId} agentId=${observed.agentId} ` +
        `turn=${observed.executionTurnId} lifecycleStatus=${result.status}`
    )
  }

  private assertDurableOwner(handle: SubagentRuntimeHandle): void {
    const run = this.runs.get(handle.conversationId, handle.agentId)
    if (
      !run ||
      run.status !== "running" ||
      run.executionTurnId !== handle.executionTurnId ||
      run.mode !== handle.mode
    ) {
      throw new Error(
        `SubagentTaskRegistry: durable execution owner mismatch ` +
          `conversation=${handle.conversationId} agentId=${handle.agentId}`
      )
    }
  }

  private async waitForTerminalOrAbort(
    terminal: Promise<TurnTerminalResult>,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    let abortListener: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError")
        )
      signal.addEventListener("abort", abortListener, { once: true })
    })
    try {
      await Promise.race([terminal, aborted])
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener)
    }
  }

  private key(conversationId: ConversationId, agentId: string): string {
    return `${conversationId}\u0000${agentId}`
  }
}
