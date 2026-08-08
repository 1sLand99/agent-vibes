import type { ParsedCursorRequest } from "./tools/cursor-request-parser"

type AgentControlType = ParsedCursorRequest["agentControlType"]

export interface PendingToolRecoveryControlPolicy {
  blocksContinuation: boolean
}

/**
 * Control actions that must wait while a durable client-owned tool remains
 * unresolved. Cursor's terminal exec frames stay passive so they can provide
 * the fact that releases the pending edge.
 */
export function getPendingToolRecoveryControlPolicy(
  agentControlType: AgentControlType
): PendingToolRecoveryControlPolicy {
  switch (agentControlType) {
    case "attachOnly":
    case "unknownConversationAction":
      return { blocksContinuation: true }
    case "cancelAction":
      return { blocksContinuation: true }
    case "summarizeAction":
    case "shellCommandAction":
    case "startPlanAction":
    case "executePlanAction":
    case "asyncAskQuestionCompletionAction":
    case "cancelSubagentAction":
    case "backgroundTaskCompletionAction":
    case "backgroundShellAction":
    case "backgroundSubagentAction":
    case "goalContinuationAction":
    case "injectContextAction":
      return { blocksContinuation: true }
    case "heartbeat":
    case "execHeartbeat":
    case "execStreamClose":
    case "execThrow":
    case "prewarm":
    case "streamClose":
    case "other":
    case undefined:
      return { blocksContinuation: false }
    default:
      return exhaustiveControlPolicy(agentControlType)
  }
}

function exhaustiveControlPolicy(
  _agentControlType: never
): PendingToolRecoveryControlPolicy {
  return { blocksContinuation: false }
}
