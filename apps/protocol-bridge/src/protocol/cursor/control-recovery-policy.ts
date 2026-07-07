import type { ParsedCursorRequest } from "./tools/cursor-request-parser"

type AgentControlType = ParsedCursorRequest["agentControlType"]

export interface RestartRecoveryControlResolution {
  resolve: boolean
  emitNotice: boolean
  endStream: boolean
}

/**
 * True for Cursor control actions that must settle restartRecovery before the
 * bridge can safely continue the stream. Attach-only is included because it is
 * Cursor's passive reattach path for an already-loading conversation; leaving a
 * recovered interrupted turn open there keeps the UI spinning forever.
 * Heartbeats, provider prewarm, and exec result frames remain passive.
 */
export function shouldResolveRestartRecoveryBeforeControlAction(
  agentControlType: AgentControlType
): boolean {
  return getRestartRecoveryControlResolution(agentControlType).resolve
}

export function getRestartRecoveryControlResolution(
  agentControlType: AgentControlType
): RestartRecoveryControlResolution {
  switch (agentControlType) {
    case "attachOnly":
    case "unknownConversationAction":
      return { resolve: true, emitNotice: true, endStream: true }
    case "cancelAction":
      return { resolve: true, emitNotice: false, endStream: true }
    case "summarizeAction":
    case "shellCommandAction":
    case "startPlanAction":
    case "executePlanAction":
    case "asyncAskQuestionCompletionAction":
    case "cancelSubagentAction":
    case "backgroundTaskCompletionAction":
    case "backgroundShellAction":
    case "backgroundSubagentAction":
      return { resolve: true, emitNotice: false, endStream: false }
    case "heartbeat":
    case "execHeartbeat":
    case "execStreamClose":
    case "execThrow":
    case "prewarm":
    case "streamClose":
    case "other":
    case undefined:
      return { resolve: false, emitNotice: false, endStream: false }
    default:
      return exhaustiveControlResolution(agentControlType)
  }
}

function exhaustiveControlResolution(
  _agentControlType: never
): RestartRecoveryControlResolution {
  return {
    resolve: false,
    emitNotice: false,
    endStream: false,
  }
}
