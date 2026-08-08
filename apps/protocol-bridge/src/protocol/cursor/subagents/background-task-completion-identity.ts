import type { SubagentRunRecord } from "../session/subagent-run-store.service"
import { BackgroundTaskKind } from "../../../gen/agent/v1_pb"

/**
 * The subset of Cursor's BackgroundTaskCompletion that can establish
 * ownership of a detached sub-agent terminal delivery. Cursor's current
 * runtime first resolves `toolCallId`, then resolves the child identity from
 * `subagentId ?? taskId`; `threadId` is corroborating identity only.
 */
export interface BackgroundTaskCompletionIdentity {
  taskId: string
  kind?: number
  threadId?: string
  subagentId?: string
  toolCallId?: string
}

export interface BackgroundSubagentCompletionPair<
  Completion extends BackgroundTaskCompletionIdentity =
    BackgroundTaskCompletionIdentity,
> {
  completion: Completion
  run: SubagentRunRecord
}

export class BackgroundSubagentCompletionIdentityError extends Error {
  constructor(
    readonly reason:
      | "ambiguous_identity"
      | "conflicting_identity"
      | "malformed_identity"
      | "missing_identity",
    readonly completion: BackgroundTaskCompletionIdentity,
    detail: string
  ) {
    super(
      `Background sub-agent completion identity ${reason}: ${detail} ` +
        `(taskId=${completion.taskId}, kind=${completion.kind ?? 0}, ` +
        `subagentId=${completion.subagentId ?? "(none)"}, ` +
        `toolCallId=${completion.toolCallId ?? "(none)"}, ` +
        `threadId=${completion.threadId ?? "(none)"})`
    )
  }
}

function exactValue(
  completion: BackgroundTaskCompletionIdentity,
  field: "taskId" | "threadId" | "subagentId" | "toolCallId",
  value: string | undefined
): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  if (value.trim() !== value || /\s/.test(value)) {
    throw new BackgroundSubagentCompletionIdentityError(
      "malformed_identity",
      completion,
      `${field} must be a whitespace-free identifier`
    )
  }
  return value
}

/**
 * Resolves one Cursor background completion to at most one durable sub-agent
 * run. This follows the current Cursor runtime ownership order exactly:
 * `toolCallId` selects the parent task, then `subagentId ?? taskId` selects
 * the child. An optional `threadId` can only corroborate that selected run.
 *
 * No other field can independently claim a run. Missing, ambiguous or
 * contradictory ownership is rejected before terminal delivery is committed.
 */
export function resolveBackgroundSubagentCompletion<
  Completion extends BackgroundTaskCompletionIdentity,
>(
  completion: Completion,
  pendingRuns: readonly SubagentRunRecord[]
): BackgroundSubagentCompletionPair<Completion> | undefined {
  const subagentId = exactValue(completion, "subagentId", completion.subagentId)
  const toolCallId = exactValue(completion, "toolCallId", completion.toolCallId)
  const threadId = exactValue(completion, "threadId", completion.threadId)
  const taskId = exactValue(completion, "taskId", completion.taskId)

  if (completion.kind === BackgroundTaskKind.SHELL) {
    if (subagentId !== undefined) {
      throw new BackgroundSubagentCompletionIdentityError(
        "conflicting_identity",
        completion,
        "a shell completion contains a sub-agent identity"
      )
    }
    return undefined
  }
  if (completion.kind !== BackgroundTaskKind.SUBAGENT) {
    if (subagentId !== undefined) {
      throw new BackgroundSubagentCompletionIdentityError(
        "conflicting_identity",
        completion,
        "subagentId requires kind=SUBAGENT"
      )
    }
    return undefined
  }

  if (toolCallId === undefined) {
    throw new BackgroundSubagentCompletionIdentityError(
      "missing_identity",
      completion,
      "kind=SUBAGENT requires toolCallId"
    )
  }
  const agentId = subagentId ?? taskId
  if (agentId === undefined) {
    throw new BackgroundSubagentCompletionIdentityError(
      "missing_identity",
      completion,
      "kind=SUBAGENT requires subagentId or taskId"
    )
  }

  const candidates = pendingRuns.filter(
    (run) => run.parentToolCallId === toolCallId
  )
  if (candidates.length === 0) {
    throw new BackgroundSubagentCompletionIdentityError(
      "missing_identity",
      completion,
      `toolCallId=${toolCallId} did not resolve to a pending run`
    )
  }
  if (candidates.length !== 1) {
    throw new BackgroundSubagentCompletionIdentityError(
      "ambiguous_identity",
      completion,
      `toolCallId=${toolCallId} resolved to ${candidates.length} pending runs`
    )
  }

  const run = candidates[0]!
  if (run.agentId !== agentId) {
    throw new BackgroundSubagentCompletionIdentityError(
      "conflicting_identity",
      completion,
      `toolCallId=${toolCallId} owns agentId=${run.agentId}, not ${agentId}`
    )
  }
  if (threadId !== undefined && run.threadId !== threadId) {
    throw new BackgroundSubagentCompletionIdentityError(
      "conflicting_identity",
      completion,
      `threadId=${threadId} does not match the selected run`
    )
  }

  return { completion, run }
}

/**
 * Resolves terminal completions as explicit completion/run pairs. A completion
 * can appear at most once in the result; callers must use these exact objects
 * for handling rather than independently rematching task or thread ids.
 */
export function resolveBackgroundSubagentCompletionPairs<
  Completion extends BackgroundTaskCompletionIdentity,
>(
  completions: readonly Completion[],
  pendingRuns: readonly SubagentRunRecord[]
): BackgroundSubagentCompletionPair<Completion>[] {
  const pairs: BackgroundSubagentCompletionPair<Completion>[] = []
  for (const completion of completions) {
    const pair = resolveBackgroundSubagentCompletion(completion, pendingRuns)
    if (pair) pairs.push(pair)
  }
  return pairs
}
