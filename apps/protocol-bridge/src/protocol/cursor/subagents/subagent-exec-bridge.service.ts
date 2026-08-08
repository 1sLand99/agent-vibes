/**
 * Bridges sub-agent ExecServerMessage tool calls onto the existing
 * parent BiDi stream and back.
 *
 * Architecture:
 *   - When a sub-agent's frozen client capability emits an
 *     ExecServerMessage round-trip (edit, delete, or a concrete MCP call), the
 *     sub-agent worker registers a promise here keyed by its exact
 *     `(conversationId, toolCallId)` identity,
 *     yields the ExecServerMessage on the BiDi stream the parent owns,
 *     and `await`s the terminal resolver.
 *   - When the IDE replies with the matching ExecClientMessage or
 *     ExecClientThrow, the BiDi inbound router checks the pending tool call's
 *     `sidechainOwner` receipt. If present, it commits and forwards that exact
 *     client terminal here instead of feeding it into the parent's
 *     continuation pipeline, then unblocks the sub-agent worker.
 *   - On abort / proto error / orphan cleanup, `rejectAll()` walks the
 *     pending map and rejects every outstanding waiter so no sub-agent
 *     turn is permanently stuck.
 *
 * The bridge keeps only the exact volatile waiter map. Capability authority,
 * sidechain identity, branch ownership, and terminal results remain durable
 * graph facts rather than process-local child state.
 */

import { Injectable, Logger } from "@nestjs/common"
import type { SubagentExecTerminalOutcome } from "./subagent-exec-terminal-outcome"

/**
 * Raw client terminal received from the IDE before the sidechain transaction
 * commits it. This value is transport evidence only; it is never delivered to
 * a worker or interpreted as a model-facing tool outcome.
 *
 * The bridge carries the exact single ExecClientMessage terminal selected by
 * the immutable capability owner. It does not decode, synthesize, buffer, or
 * reinterpret client protocol frames.
 */
export interface SubagentExecRawResult {
  /** Raw ExecClientMessage protobuf bytes returned by the IDE. */
  readonly resultData: Buffer
  /** Raw ExecClientMessage oneof case declared by the transport parser. */
  readonly resultCase: string
}

/**
 * The only result a sub-agent worker may observe. Its terminal outcome was
 * committed with the child graph edge before the bridge settles the waiter.
 */
export interface SubagentExecCommittedResult extends SubagentExecRawResult {
  readonly terminalKind: "result"
  readonly terminalOutcome: SubagentExecTerminalOutcome
}

/** Exact ExecClientThrow evidence received from Cursor's control channel. */
export interface SubagentExecRawThrow {
  readonly reason: string
  readonly stack: string
}

/** A throw terminal that is already committed to the child sidechain. */
export interface SubagentExecCommittedThrow extends SubagentExecRawThrow {
  readonly terminalKind: "throw"
  readonly terminalOutcome: SubagentExecTerminalOutcome
}

export type SubagentExecCommittedTerminal =
  | SubagentExecCommittedResult
  | SubagentExecCommittedThrow

interface SubagentExecWaiter {
  conversationId: string
  subagentId: string
  toolCallId: string
  sidechainOwner: SubagentExecSidechainOwner
  resolve: (result: SubagentExecCommittedTerminal) => void
  reject: (reason: Error) => void
  releaseAbort: () => void
}

/**
 * The bridge accepts the complete durable assistant-source identity with each
 * waiter operation.  Matching only a tool id or a transient subagent id would
 * allow a stale client result to wake the wrong sidechain after a restart.
 */
export interface SubagentExecSidechainOwner {
  readonly agentId: string
  readonly threadId: string
  readonly branchId: string
  readonly turnId: string
  readonly forkSourceUuid: string
  readonly forkLineage: readonly string[]
  readonly sourceToolAssistantUuid: string
}

/** A client frame whose exact sidechain identity cannot be trusted. */
export class SubagentExecProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = SubagentExecProtocolError.name
  }
}

/**
 * A durable commit hook returns the distinct committed terminal and
 * its mandatory post-commit reconciliation. If the transaction throws, the
 * waiter remains retryable. Once it returns, the waiter is terminal even if
 * reconciliation fails, so the same client result can never attempt a second
 * graph commit.
 */
export interface SubagentExecTerminalCommitReceipt {
  readonly committedTerminal: SubagentExecCommittedTerminal
  readonly afterCommit: () => void
}

export type SubagentExecResultCommitHook = (
  result: SubagentExecRawResult
) => SubagentExecTerminalCommitReceipt

export type SubagentExecThrowCommitHook = (
  terminal: SubagentExecRawThrow
) => SubagentExecTerminalCommitReceipt

function isAfterCommitReconciliation(value: unknown): value is () => void {
  return typeof value === "function"
}

@Injectable()
export class SubagentExecBridgeService {
  private readonly logger = new Logger(SubagentExecBridgeService.name)
  private readonly waiters = new Map<string, SubagentExecWaiter>()
  private readonly idleWaiters = new Map<
    string,
    Set<{
      resolve: () => void
      reject: (error: Error) => void
      release: () => void
    }>
  >()

  /**
   * Register a waiter for the exact Cursor client terminal that the
   * sub-agent worker is about to wait on. Returns a promise that resolves when
   * `deliverResult` or `deliverThrow` commits the
   * terminal and settles it, or
   * rejects when the conversation aborts before the result arrives.
   */
  awaitTerminal(
    conversationId: string,
    sidechainOwner: SubagentExecSidechainOwner,
    toolCallId: string,
    signal: AbortSignal
  ): Promise<SubagentExecCommittedTerminal> {
    signal.throwIfAborted()
    const key = this.waiterKey(conversationId, toolCallId)
    if (this.waiters.has(key)) {
      throw new Error(
        `Sub-agent exec waiter duplicate registration: conversation=${conversationId} toolCallId=${toolCallId}`
      )
    }
    return new Promise<SubagentExecCommittedTerminal>((resolve, reject) => {
      const waiter: SubagentExecWaiter = {
        conversationId,
        subagentId: sidechainOwner.agentId,
        toolCallId,
        sidechainOwner,
        resolve,
        reject,
        releaseAbort: () => signal.removeEventListener("abort", onAbort),
      }
      const onAbort = () => {
        if (this.waiters.get(key) !== waiter) return
        this.waiters.delete(key)
        this.notifyIdleIfReady(conversationId, sidechainOwner.agentId)
        waiter.releaseAbort()
        const reason =
          signal.reason instanceof Error
            ? signal.reason
            : new Error(String(signal.reason ?? "Sub-agent turn aborted"))
        reject(reason)
      }
      this.waiters.set(key, waiter)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  /**
   * Forward one raw ExecClientMessage payload to the exact sub-agent waiter.
   * The required hook must commit an independently constructed terminal
   * result before this waiter is settled. A rejected oneof therefore becomes
   * a durable protocol-error terminal rather than a separate stream state
   * machine.
   *
   * Returns true when a waiter was found (caller can short-circuit the
   * parent's result-handling pipeline); false otherwise.
   */
  deliverResult(
    conversationId: string,
    sidechainOwner: SubagentExecSidechainOwner,
    toolCallId: string,
    result: SubagentExecRawResult,
    commitBeforeResolve: SubagentExecResultCommitHook
  ): boolean {
    if (typeof commitBeforeResolve !== "function") {
      throw new SubagentExecProtocolError(
        "Sub-agent exec delivery requires a durable terminal commit hook"
      )
    }
    const key = this.waiterKey(conversationId, toolCallId)
    const waiter = this.waiters.get(key)
    if (!waiter) return false
    this.assertExactSidechainOwner(waiter, sidechainOwner)
    this.commitAndSettleWaiter(
      conversationId,
      toolCallId,
      waiter,
      result,
      commitBeforeResolve,
      (candidate, receipt) =>
        this.requireCommittedResultReceipt(candidate, receipt)
    )
    return true
  }

  /**
   * Commit and deliver Cursor's control-channel throw to the exact child
   * waiter. A throw is a real client terminal, not a rejected local promise:
   * the worker must continue with the committed error tool_result exactly as
   * it does for an error arm inside ExecClientMessage.
   */
  deliverThrow(
    conversationId: string,
    sidechainOwner: SubagentExecSidechainOwner,
    toolCallId: string,
    terminal: SubagentExecRawThrow,
    commitBeforeResolve: SubagentExecThrowCommitHook
  ): boolean {
    if (typeof commitBeforeResolve !== "function") {
      throw new SubagentExecProtocolError(
        "Sub-agent exec throw delivery requires a durable terminal commit hook"
      )
    }
    const key = this.waiterKey(conversationId, toolCallId)
    const waiter = this.waiters.get(key)
    if (!waiter) return false
    this.assertExactSidechainOwner(waiter, sidechainOwner)
    this.commitAndSettleWaiter(
      conversationId,
      toolCallId,
      waiter,
      terminal,
      commitBeforeResolve,
      (candidate, receipt) =>
        this.requireCommittedThrowReceipt(candidate, receipt)
    )
    return true
  }

  private commitAndSettleWaiter<T>(
    conversationId: string,
    toolCallId: string,
    waiter: SubagentExecWaiter,
    terminal: T,
    commitBeforeResolve: (terminal: T) => SubagentExecTerminalCommitReceipt,
    requireCommittedReceipt: (
      terminal: T,
      receipt: unknown
    ) => SubagentExecTerminalCommitReceipt
  ): void {
    // Only a thrown hook is retryable: it has not acknowledged the durable
    // terminal boundary. Once it returns, its graph commit may already be
    // visible, so no malformed receipt can reopen this waiter for replay.
    const receipt = commitBeforeResolve(terminal)
    this.waiters.delete(this.waiterKey(conversationId, toolCallId))
    this.notifyIdleIfReady(waiter.conversationId, waiter.subagentId)
    waiter.releaseAbort()

    let committedReceipt: SubagentExecTerminalCommitReceipt
    try {
      committedReceipt = requireCommittedReceipt(terminal, receipt)
    } catch (error) {
      const fault =
        error instanceof SubagentExecProtocolError
          ? error
          : new SubagentExecProtocolError(
              `Sub-agent exec durable commit returned an invalid receipt: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
      this.logger.error(
        `Sub-agent exec durable commit returned an invalid receipt after its ` +
          `terminal boundary for toolCallId=${toolCallId} ` +
          `(subagent=${waiter.subagentId}); rejecting the sealed worker waiter: ` +
          fault.message
      )
      waiter.reject(fault)
      return
    }

    try {
      committedReceipt.afterCommit()
    } catch (error) {
      this.logger.error(
        `Sub-agent exec post-commit cleanup failed for ` +
          `toolCallId=${toolCallId} (subagent=${waiter.subagentId}): ` +
          `${error instanceof Error ? error.message : String(error)}; ` +
          `continuing from the already-committed terminal outcome`
      )
    }
    // A commit hook that returned has already written the graph/ledger/outbox
    // terminal. Cleanup can be retried or diagnosed, but it must never turn
    // that durable outcome into a rejected waiter or trigger a second result.
    waiter.resolve(committedReceipt.committedTerminal)
  }

  /** Reject malformed JS callers before an uncommitted raw frame can wake a worker. */
  private requireCommittedResultReceipt(
    rawResult: SubagentExecRawResult,
    receipt: unknown
  ): SubagentExecTerminalCommitReceipt {
    if (!receipt || typeof receipt !== "object") {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit returned no receipt"
      )
    }
    if (!Object.isFrozen(receipt)) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt must be frozen"
      )
    }
    const candidate = receipt as {
      afterCommit?: unknown
      committedTerminal?: unknown
    }
    const afterCommit = candidate.afterCommit
    if (!isAfterCommitReconciliation(afterCommit)) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt has no afterCommit reconciliation"
      )
    }
    const committedCandidate = candidate.committedTerminal
    if (!committedCandidate || typeof committedCandidate !== "object") {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt has no committed result"
      )
    }
    if (committedCandidate === rawResult) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit must return a distinct committed result"
      )
    }
    if (!Object.isFrozen(committedCandidate)) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit result must be frozen"
      )
    }
    const committed = committedCandidate as Record<string, unknown>
    if (committed["terminalKind"] !== "result") {
      throw new SubagentExecProtocolError(
        "Sub-agent exec result receipt has the wrong terminal kind"
      )
    }
    const committedResultData = committed["resultData"]
    const committedResultCase = committed["resultCase"]
    if (
      !Buffer.isBuffer(rawResult.resultData) ||
      !Buffer.isBuffer(committedResultData) ||
      committedResultData === rawResult.resultData ||
      typeof committedResultCase !== "string" ||
      committedResultCase !== rawResult.resultCase ||
      !committedResultData.equals(rawResult.resultData)
    ) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt does not preserve an independent raw client result"
      )
    }
    const outcome = committed["terminalOutcome"]
    if (
      !outcome ||
      typeof outcome !== "object" ||
      (outcome as Record<string, unknown>)["resultCase"] !==
        rawResult.resultCase
    ) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt has no matching terminal outcome"
      )
    }
    if (!Object.isFrozen(outcome)) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit terminal outcome must be frozen"
      )
    }
    return {
      committedTerminal: committedCandidate as SubagentExecCommittedResult,
      afterCommit,
    }
  }

  private requireCommittedThrowReceipt(
    rawThrow: SubagentExecRawThrow,
    receipt: unknown
  ): SubagentExecTerminalCommitReceipt {
    const base = this.requireReceiptShape(receipt)
    const committed = base.committedTerminal as Record<string, unknown>
    if (
      committed["terminalKind"] !== "throw" ||
      committed["reason"] !== rawThrow.reason ||
      committed["stack"] !== rawThrow.stack
    ) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec throw receipt does not preserve its exact control terminal"
      )
    }
    const outcome = committed["terminalOutcome"]
    if (
      !outcome ||
      typeof outcome !== "object" ||
      (outcome as Record<string, unknown>)["resultCase"] !== "exec_throw" ||
      !Object.isFrozen(outcome)
    ) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec throw receipt has no frozen throw terminal outcome"
      )
    }
    return {
      committedTerminal: base.committedTerminal as SubagentExecCommittedThrow,
      afterCommit: base.afterCommit,
    }
  }

  private requireReceiptShape(receipt: unknown): {
    committedTerminal: object
    afterCommit: () => void
  } {
    if (!receipt || typeof receipt !== "object" || !Object.isFrozen(receipt)) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt must be a frozen object"
      )
    }
    const candidate = receipt as {
      committedTerminal?: unknown
      afterCommit?: unknown
    }
    if (!isAfterCommitReconciliation(candidate.afterCommit)) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt has no afterCommit reconciliation"
      )
    }
    if (
      !candidate.committedTerminal ||
      typeof candidate.committedTerminal !== "object" ||
      !Object.isFrozen(candidate.committedTerminal)
    ) {
      throw new SubagentExecProtocolError(
        "Sub-agent exec durable commit receipt has no frozen committed terminal"
      )
    }
    return {
      committedTerminal: candidate.committedTerminal,
      afterCommit: candidate.afterCommit,
    }
  }

  /**
   * Reject every outstanding waiter for the given conversation. Called
   * when the BiDi stream aborts, the sub-agent is killed, or the parent
   * task tool gets a protocol error before its sub-agent finishes.
   */
  rejectConversation(conversationId: string, reason: string): void {
    for (const [key, waiter] of this.waiters) {
      if (waiter.conversationId !== conversationId) continue
      this.waiters.delete(key)
      this.notifyIdleIfReady(waiter.conversationId, waiter.subagentId)
      waiter.releaseAbort()
      try {
        waiter.reject(new Error(reason))
      } catch (error) {
        this.logger.warn(
          `Sub-agent exec waiter reject threw for toolCallId=${waiter.toolCallId} ` +
            `(subagent=${waiter.subagentId}): ${String(error)}`
        )
      }
    }
  }

  /**
   * Reject a single outstanding waiter, identified by toolCallId.
   * Returns true when a waiter was found and rejected, false otherwise.
   *
   * Used by the BiDi recovery path
   * (`interruptPendingToolCallsForRecovery` in CursorConnectStreamService)
   * to surface a stream-closed abort to the sub-agent worker the moment
   * its pending tool call is cleared. Without this, the worker would
   * stay parked on `awaitTerminal()` forever, emitting heartbeats while
   * the IDE-side BiDi stream is already gone.
   */
  rejectToolCall(
    conversationId: string,
    sidechainOwner: SubagentExecSidechainOwner,
    toolCallId: string,
    reason: Error
  ): boolean {
    const key = this.waiterKey(conversationId, toolCallId)
    const waiter = this.waiters.get(key)
    if (!waiter) return false
    this.assertExactSidechainOwner(waiter, sidechainOwner)
    this.waiters.delete(key)
    this.notifyIdleIfReady(waiter.conversationId, waiter.subagentId)
    waiter.releaseAbort()
    try {
      waiter.reject(reason)
    } catch (error) {
      this.logger.warn(
        `Sub-agent exec waiter reject threw for toolCallId=${toolCallId} ` +
          `(subagent=${waiter.subagentId}): ${String(error)}`
      )
    }
    return true
  }

  /** Whether this exact conversation/tool id has an outstanding waiter. */
  hasWaiter(
    conversationId: string,
    sidechainOwner: SubagentExecSidechainOwner,
    toolCallId: string
  ): boolean {
    const waiter = this.waiters.get(this.waiterKey(conversationId, toolCallId))
    if (!waiter) return false
    this.assertExactSidechainOwner(waiter, sidechainOwner)
    return true
  }

  /**
   * Wait until the exact sub-agent has no client-exec result in flight. The
   * foreground-to-background handoff uses this boundary so it never abandons
   * an open tool_use or lets the old and new execution turns append together.
   */
  awaitSubagentIdle(
    conversationId: string,
    subagentId: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    if (!this.hasSubagentWaiter(conversationId, subagentId)) {
      return Promise.resolve()
    }
    const key = this.subagentKey(conversationId, subagentId)
    return new Promise<void>((resolve, reject) => {
      const waiter: {
        resolve: () => void
        reject: (error: Error) => void
        release: () => void
      } = {
        resolve: () => {
          waiter.release()
          resolve()
        },
        reject,
        release: () => signal.removeEventListener("abort", onAbort),
      }
      const onAbort = () => {
        const waiters = this.idleWaiters.get(key)
        waiters?.delete(waiter)
        if (waiters?.size === 0) this.idleWaiters.delete(key)
        waiter.release()
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError")
        )
      }
      let waiters = this.idleWaiters.get(key)
      if (!waiters) {
        waiters = new Set()
        this.idleWaiters.set(key, waiters)
      }
      waiters.add(waiter)
      signal.addEventListener("abort", onAbort, { once: true })
      if (!this.hasSubagentWaiter(conversationId, subagentId)) {
        this.notifyIdleIfReady(conversationId, subagentId)
      }
    })
  }

  private hasSubagentWaiter(
    conversationId: string,
    subagentId: string
  ): boolean {
    for (const waiter of this.waiters.values()) {
      if (
        waiter.conversationId === conversationId &&
        waiter.subagentId === subagentId
      ) {
        return true
      }
    }
    return false
  }

  private notifyIdleIfReady(conversationId: string, subagentId: string): void {
    if (this.hasSubagentWaiter(conversationId, subagentId)) return
    const key = this.subagentKey(conversationId, subagentId)
    const waiters = this.idleWaiters.get(key)
    if (!waiters) return
    this.idleWaiters.delete(key)
    for (const waiter of waiters) waiter.resolve()
  }

  private subagentKey(conversationId: string, subagentId: string): string {
    return `${conversationId}\u0000${subagentId}`
  }

  private waiterKey(conversationId: string, toolCallId: string): string {
    return `${conversationId}\u0000${toolCallId}`
  }

  private assertExactSidechainOwner(
    waiter: SubagentExecWaiter,
    actual: SubagentExecSidechainOwner
  ): void {
    const expected = waiter.sidechainOwner
    if (
      expected.agentId !== actual.agentId ||
      expected.threadId !== actual.threadId ||
      expected.branchId !== actual.branchId ||
      expected.turnId !== actual.turnId ||
      expected.forkSourceUuid !== actual.forkSourceUuid ||
      expected.sourceToolAssistantUuid !== actual.sourceToolAssistantUuid ||
      expected.forkLineage.length !== actual.forkLineage.length ||
      expected.forkLineage.some(
        (entry, index) => entry !== actual.forkLineage[index]
      )
    ) {
      throw new SubagentExecProtocolError(
        `Sub-agent exec waiter sidechain owner mismatch: conversation=${waiter.conversationId} toolCallId=${waiter.toolCallId}`
      )
    }
  }

  /** Sub-agent id that owns this exact pending client result, if any. */
  getOwnerSubagentId(
    conversationId: string,
    toolCallId: string
  ): string | undefined {
    return this.waiters.get(this.waiterKey(conversationId, toolCallId))
      ?.subagentId
  }
}
