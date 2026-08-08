import type { ConversationId, TurnId } from "../turn/turn.types"
import type { SubagentRunRecord } from "./subagent-run-store.service"

/**
 * Immutable identity of a sub-agent branch in the parent conversation graph.
 *
 * This is deliberately separate from an execution lease. A foreground to
 * background handoff changes only the execution turn; it must never rewrite
 * the branch, its parent task owner, or its fork origin.
 */
export interface SubagentGraphIdentity {
  readonly conversationId: ConversationId
  readonly parentToolCallId: string
  readonly subagentId: string
  readonly threadId: string
  readonly branchId: string
  readonly agentId: string
  readonly forkSourceUuid: string
  readonly forkLineage: readonly string[]
}

/** One currently selected execution lease for an immutable branch. */
export interface SubagentGraphExecutionLease {
  readonly turnId: TurnId
}

/**
 * A branch identity paired with the exact execution that is attempting a
 * write or request. Durable graph rows retain their own historical lease;
 * callers must not infer that lease from the current run row.
 */
export interface SubagentGraphBranch
  extends SubagentGraphIdentity, SubagentGraphExecutionLease {}

/**
 * Derive an execution branch exclusively from the durable run record.  A
 * branch is a read/write scope, not a second runtime state container, so
 * callers must never retain or reconstruct one from a transient child loop.
 */
export function subagentGraphBranchFromRun(
  run: Pick<
    SubagentRunRecord,
    | "conversationId"
    | "agentId"
    | "parentToolCallId"
    | "threadId"
    | "branchId"
    | "forkSourceUuid"
    | "forkLineage"
    | "executionTurnId"
  >
): SubagentGraphBranch {
  return {
    conversationId: run.conversationId,
    parentToolCallId: run.parentToolCallId,
    subagentId: run.agentId,
    threadId: run.threadId,
    branchId: run.branchId,
    agentId: run.agentId,
    forkSourceUuid: run.forkSourceUuid,
    forkLineage: [...run.forkLineage],
    turnId: run.executionTurnId,
  }
}
