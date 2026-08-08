import { forwardRef, Inject, Injectable } from "@nestjs/common"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../../context/durable-identifier"
import { ConversationId, TurnId } from "../turn/turn.types"
import type { BackendType } from "../../../llm/shared/model-router.service"
import { SessionLifecycleService } from "./session-lifecycle.service"

/**
 * AssistantToolBatchService
 *
 * The bridge tracks one in-flight assistant tool batch per
 * conversation. A "batch" is the set of tool_use blocks the model
 * emitted in a single message_stop — the IDE may settle them in any
 * order, but exactly one tool_result claims the right to drive the
 * follow-up continuation. The state machine guards against:
 *
 *   - re-claiming the continuation after it has already fired
 *   - claiming continuation while a sibling tool is still unsettled
 *   - back-end mismatch (a stale batch from a different backend)
 *
 * `mark dirty` / `lastActivityAt` updates flow through the lifecycle
 * service via `forwardRef` whenever a batch transitions.
 */

export interface AssistantToolBatch {
  id: string
  /** Stable identity of the user request across all of its continuations. */
  topLevelTurnId: TurnId
  /** Graph turn that emitted this exact assistant tool-use batch. */
  graphTurnId: TurnId
  backend: BackendType
  streamId?: string
  toolCallIds: string[]
  unsettledToolCallIds: string[]
  completionPolicy: AssistantToolBatchCompletionPolicy
}

export type AssistantToolBatchCompletionPolicy = "continue" | "await_async_user"

interface AssistantToolBatchRecord {
  toolExecutionOrderCounter: number
  activeAssistantToolBatch?: AssistantToolBatch
  pendingInlineContinuation?: AssistantToolBatchPendingContinuation<unknown>
}

export interface AssistantToolBatchIdentity {
  topLevelTurnId: TurnId
  graphTurnId: TurnId
}

export interface AssistantToolBatchPendingContinuation<T> {
  topLevelTurnId: TurnId
  graphTurnId: TurnId
  value: T
}

type AssistantToolBatchOptions = AssistantToolBatchIdentity & {
  completionPolicy?: AssistantToolBatchCompletionPolicy
  streamId?: string
}

@Injectable()
export class AssistantToolBatchService {
  private readonly records = new Map<ConversationId, AssistantToolBatchRecord>()
  private batchSequence = 0

  constructor(
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService
  ) {}

  // ── batch state machine ────────────────────────────────────────

  startAssistantToolBatch(
    conversationId: string,
    backend: BackendType,
    toolCallIds: string[],
    options: AssistantToolBatchOptions
  ): void {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)

    const exactToolCallIds = this.requireExactToolCallIds(
      toolCallIds,
      "startAssistantToolBatch"
    )

    if (exactToolCallIds.length === 0) {
      record.activeAssistantToolBatch = undefined
      this.touchSession(conversationId)
      return
    }

    record.activeAssistantToolBatch = {
      id: this.nextBatchId(),
      topLevelTurnId: options.topLevelTurnId,
      graphTurnId: options.graphTurnId,
      backend,
      streamId: this.requireStreamId(options?.streamId),
      toolCallIds: [...exactToolCallIds],
      unsettledToolCallIds: [...exactToolCallIds],
      completionPolicy: options?.completionPolicy ?? "continue",
    }
    this.touchSession(conversationId)
  }

  addAssistantToolBatchTools(
    conversationId: string,
    backend: BackendType,
    toolCallIds: string[],
    options: AssistantToolBatchOptions
  ): void {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)

    const exactToolCallIds = this.requireExactToolCallIds(
      toolCallIds,
      "addAssistantToolBatchTools"
    )
    if (exactToolCallIds.length === 0) return

    const batch = record.activeAssistantToolBatch
    const streamId = this.requireStreamId(options?.streamId)
    if (
      batch &&
      (batch.topLevelTurnId !== options.topLevelTurnId ||
        batch.graphTurnId !== options.graphTurnId)
    ) {
      throw new Error(
        `Assistant tool batch turn ownership changed without cleanup for ${conversationId}: ` +
          `active=${batch.topLevelTurnId}/${batch.graphTurnId}, ` +
          `incoming=${options.topLevelTurnId}/${options.graphTurnId}`
      )
    }
    if (!batch || batch.backend !== backend || batch.streamId !== streamId) {
      this.startAssistantToolBatch(
        conversationId,
        backend,
        exactToolCallIds,
        options
      )
      return
    }

    for (const toolCallId of exactToolCallIds) {
      // A tool already known to this batch carries authoritative settle
      // state: it is either still in `unsettledToolCallIds` (awaiting its
      // result) or was already drained by `settleAssistantToolBatchTool`
      // once its result landed. Re-registering the same id (the
      // message_stop finalization re-adds every tool_use after the
      // streaming early-dispatch path registered them one-by-one) must NOT
      // resurrect an already-settled tool into the unsettled set: with
      // Cursor's early dispatch a sibling result can settle BEFORE the
      // batch is finalized, and resurrecting it would strand the
      // continuation barrier in a permanently-deferred state with no
      // future result to clear it. Only genuinely new ids join the batch,
      // and a new id starts out unsettled in the same step.
      if (!batch.toolCallIds.includes(toolCallId)) {
        batch.toolCallIds.push(toolCallId)
        batch.unsettledToolCallIds.push(toolCallId)
      }
    }
    if (options?.completionPolicy === "await_async_user") {
      batch.completionPolicy = "await_async_user"
    }
    this.touchSession(conversationId)
  }

  settleAssistantToolBatchTool(
    conversationId: string,
    toolCallId: string,
    identity: AssistantToolBatchIdentity
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    if (!record?.activeAssistantToolBatch) return false

    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "Assistant tool batch settled tool call id"
    )

    const batch = record.activeAssistantToolBatch
    if (!this.batchMatchesIdentity(batch, identity)) return false
    const nextUnsettled = batch.unsettledToolCallIds.filter(
      (id) => id !== exactToolCallId
    )
    if (nextUnsettled.length === batch.unsettledToolCallIds.length) {
      return false
    }

    batch.unsettledToolCallIds = nextUnsettled
    this.touchSession(conversationId)
    return true
  }

  hasUnsettledAssistantToolBatchForBackend(
    conversationId: string,
    backend: BackendType,
    identity: AssistantToolBatchIdentity
  ): boolean {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    if (!record?.activeAssistantToolBatch) return false

    const batch = record.activeAssistantToolBatch
    return (
      this.batchMatchesIdentity(batch, identity) &&
      batch.backend === backend &&
      batch.unsettledToolCallIds.length > 0
    )
  }

  claimAssistantToolBatchContinuation(
    conversationId: string,
    backend: BackendType,
    toolCallId: string,
    identity: AssistantToolBatchIdentity
  ): boolean {
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "Assistant tool batch continuation tool call id"
    )
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    const batch = record?.activeAssistantToolBatch
    if (!record || !batch) return false
    if (!this.batchMatchesIdentity(batch, identity)) return false
    if (batch.backend !== backend) return false
    if (!batch.toolCallIds.includes(exactToolCallId)) return false
    if (batch.completionPolicy !== "continue") return false
    if (batch.unsettledToolCallIds.length > 0) return false
    // All results were already appended to the immutable graph before this
    // claim. Close the in-memory barrier in the same synchronous transition as
    // the claim so an exception in later request assembly cannot strand a
    // claimed-but-active batch or make a retry permanently ineligible.
    record.activeAssistantToolBatch = undefined
    this.touchSession(conversationId)
    return true
  }

  // ── snapshot / cleanup ─────────────────────────────────────────

  getActiveAssistantToolBatchSnapshot(
    conversationId: string
  ): AssistantToolBatch | undefined {
    const cid = ConversationId.of(conversationId)
    const batch = this.records.get(cid)?.activeAssistantToolBatch
    if (!batch) return undefined
    return {
      id: batch.id,
      topLevelTurnId: batch.topLevelTurnId,
      graphTurnId: batch.graphTurnId,
      backend: batch.backend,
      streamId: batch.streamId,
      toolCallIds: [...batch.toolCallIds],
      unsettledToolCallIds: [...batch.unsettledToolCallIds],
      completionPolicy: batch.completionPolicy,
    }
  }

  bumpToolExecutionOrderCounter(conversationId: string): number {
    const cid = ConversationId.of(conversationId)
    const record = this.ensureRecord(cid)
    record.toolExecutionOrderCounter += 1
    return record.toolExecutionOrderCounter
  }

  clearAssistantToolBatch(conversationId: string): void {
    const cid = ConversationId.of(conversationId)
    const record = this.records.get(cid)
    if (!record) return
    record.activeAssistantToolBatch = undefined
    record.pendingInlineContinuation = undefined
    this.touchSession(conversationId)
  }

  setPendingInlineContinuation<T>(
    conversationId: string,
    identity: AssistantToolBatchIdentity,
    value: T
  ): boolean {
    const record = this.ensureRecord(ConversationId.of(conversationId))
    const batch = record.activeAssistantToolBatch
    if (
      !batch ||
      !this.batchMatchesIdentity(batch, identity) ||
      batch.completionPolicy !== "continue" ||
      batch.unsettledToolCallIds.length > 0
    ) {
      return false
    }
    record.pendingInlineContinuation = { ...identity, value }
    this.touchSession(conversationId)
    return true
  }

  /**
   * Claims the terminal edge of a batch that intentionally stops after
   * projecting an asynchronous ask-question placeholder. Exactly one result
   * handler may claim it, and only after every sibling tool has settled.
   */
  claimAsyncUserSuspension(
    conversationId: string,
    identity: AssistantToolBatchIdentity
  ): boolean {
    const record = this.records.get(ConversationId.of(conversationId))
    const batch = record?.activeAssistantToolBatch
    if (!record || !batch) return false
    if (!this.batchMatchesIdentity(batch, identity)) return false
    if (batch.completionPolicy !== "await_async_user") return false
    if (batch.unsettledToolCallIds.length > 0) return false

    record.activeAssistantToolBatch = undefined
    record.pendingInlineContinuation = undefined
    this.touchSession(conversationId)
    return true
  }

  takePendingInlineContinuation<T>(
    conversationId: string,
    topLevelTurnId: TurnId
  ): AssistantToolBatchPendingContinuation<T> | undefined {
    const record = this.records.get(ConversationId.of(conversationId))
    const pending = record?.pendingInlineContinuation
    if (!record || !pending) return undefined
    if (pending.topLevelTurnId !== topLevelTurnId) {
      record.pendingInlineContinuation = undefined
      this.touchSession(conversationId)
      return undefined
    }
    record.pendingInlineContinuation = undefined
    this.touchSession(conversationId)
    return {
      topLevelTurnId: pending.topLevelTurnId,
      graphTurnId: pending.graphTurnId,
      value: pending.value as T,
    }
  }

  abortGraphTurn(
    conversationId: string,
    graphTurnId: TurnId
  ): { batchCleared: boolean; inlineCleared: boolean } {
    const record = this.records.get(ConversationId.of(conversationId))
    if (!record) {
      return {
        batchCleared: false,
        inlineCleared: false,
      }
    }
    const batchCleared =
      record.activeAssistantToolBatch?.graphTurnId === graphTurnId
    if (batchCleared) record.activeAssistantToolBatch = undefined
    const inlineCleared =
      record.pendingInlineContinuation?.graphTurnId === graphTurnId
    if (inlineCleared) record.pendingInlineContinuation = undefined
    if (batchCleared || inlineCleared) {
      this.touchSession(conversationId)
    }
    return { batchCleared, inlineCleared }
  }

  beginTopLevelTurn(conversationId: string, topLevelTurnId: TurnId): void {
    const record = this.ensureRecord(ConversationId.of(conversationId))
    const active = record.activeAssistantToolBatch
    if (active && active.topLevelTurnId !== topLevelTurnId) {
      throw new Error(
        `Cannot begin top-level turn ${topLevelTurnId} while assistant batch ` +
          `${active.id} still belongs to ${active.topLevelTurnId}/${active.graphTurnId}`
      )
    }
    let changed = false
    if (
      record.pendingInlineContinuation &&
      record.pendingInlineContinuation.topLevelTurnId !== topLevelTurnId
    ) {
      record.pendingInlineContinuation = undefined
      changed = true
    }
    if (changed) this.touchSession(conversationId)
  }

  /**
   * Drop the entire record on session teardown. Called by
   * SessionLifecycleService.deleteSession.
   */
  forgetSession(conversationId: string): void {
    this.records.delete(ConversationId.of(conversationId))
  }

  // ── internal ───────────────────────────────────────────────────

  private ensureRecord(cid: ConversationId): AssistantToolBatchRecord {
    let record = this.records.get(cid)
    if (!record) {
      record = {
        toolExecutionOrderCounter: 0,
        activeAssistantToolBatch: undefined,
        pendingInlineContinuation: undefined,
      }
      this.records.set(cid, record)
    }
    return record
  }

  private nextBatchId(): string {
    this.batchSequence += 1
    return `assistant-batch-${Date.now()}-${this.batchSequence}`
  }

  private requireStreamId(streamId: string | undefined): string | undefined {
    return requireOptionalExactDurableIdentifier(
      streamId,
      "Assistant tool batch stream id"
    )
  }

  private requireExactToolCallIds(
    toolCallIds: readonly unknown[],
    operation: string
  ): string[] {
    const exactIds = toolCallIds.map((toolCallId, index) =>
      requireExactDurableIdentifier(
        toolCallId,
        `AssistantToolBatchService.${operation} tool call id at index ${index}`
      )
    )
    if (new Set(exactIds).size !== exactIds.length) {
      throw new Error(
        `AssistantToolBatchService.${operation}: tool call ids must be unique`
      )
    }
    return exactIds
  }

  private batchMatchesIdentity(
    batch: AssistantToolBatch,
    identity: AssistantToolBatchIdentity
  ): boolean {
    return (
      batch.topLevelTurnId === identity.topLevelTurnId &&
      batch.graphTurnId === identity.graphTurnId
    )
  }

  private touchSession(conversationId: string): void {
    this.sessionLifecycle.markSessionDirty(conversationId)
  }
}
