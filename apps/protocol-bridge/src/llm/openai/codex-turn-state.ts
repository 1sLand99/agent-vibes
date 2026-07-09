import type { CodexInputItem } from "./codex-native-types"
import {
  prepareCodexTurnLedgerRequest,
  type CodexContinuationDecision,
  type CodexInputMismatchItemDetail,
  type CodexTurnLedgerResponse,
} from "./codex-turn-ledger"

export interface CodexTurnContinuationState {
  lastResponse: CodexTurnLedgerResponse | undefined
  lastRequest: Record<string, unknown> | undefined
}

export interface CodexPreparedTurnRequest {
  request: Record<string, unknown>
  decision: CodexContinuationDecision
}

export function prepareCodexTurnStateRequest(
  request: Record<string, unknown>,
  state: CodexTurnContinuationState,
  allowEmptyDelta: boolean
): CodexPreparedTurnRequest {
  const decision = prepareCodexTurnLedgerRequest(
    request,
    {
      lastRequest: state.lastRequest,
      lastResponse: state.lastResponse,
    },
    allowEmptyDelta
  )
  state.lastRequest = decision.nextState.lastRequest
  state.lastResponse = decision.nextState.lastResponse
  return {
    request: decision.request,
    decision,
  }
}

export function buildCodexContinuationDecisionLogLine(
  conversationId: string,
  decision: CodexContinuationDecision
): string {
  if (decision.mode === "full") {
    return `[Codex][TurnContext] Starting full response chain for ${conversationId}: ${decision.reason}`
  }

  if (decision.mode === "full_reset") {
    const detail =
      decision.reason === "static_fields_changed"
        ? ` keys=${decision.changedStaticKeys.join(",") || "unknown"}`
        : ` baseline=${decision.inputMismatch.baselineLength} request=${decision.inputMismatch.requestLength}` +
          (typeof decision.inputMismatch.mismatchIndex === "number"
            ? ` mismatch_index=${decision.inputMismatch.mismatchIndex}` +
              ` baseline_type=${decision.inputMismatch.baselineType || "unknown"}` +
              ` request_type=${decision.inputMismatch.requestType || "unknown"}` +
              formatCodexInputMismatchDetail(
                "baseline",
                decision.inputMismatch.baselineDetail
              ) +
              formatCodexInputMismatchDetail(
                "request",
                decision.inputMismatch.requestDetail
              )
            : "")
    return (
      `[Codex][TurnContext] Incremental request unavailable: ${decision.reason}${detail}; ` +
      `resetting response chain for ${conversationId}`
    )
  }

  return (
    `[Codex][TurnContext] Injected previous_response_id=${decision.previousResponseId} ` +
    `for conversation=${conversationId}; incremental_items=${decision.incrementalItemCount}`
  )
}

export function startCodexFullResponseChain(
  state: CodexTurnContinuationState,
  request: Record<string, unknown>
): string | undefined {
  const previousResponseId = state.lastResponse?.responseId
  state.lastRequest = request
  state.lastResponse = undefined
  return previousResponseId
}

export function captureCodexTurnResponse(
  state: CodexTurnContinuationState,
  responseId: string,
  itemsAdded: CodexInputItem[]
): void {
  state.lastResponse = { responseId, itemsAdded }
}

export function resetCodexTurnContinuationState(
  state: CodexTurnContinuationState
): string | undefined {
  const previousResponseId = state.lastResponse?.responseId
  state.lastRequest = undefined
  state.lastResponse = undefined
  return previousResponseId
}

export function hasCodexTurnContinuationState(
  state: CodexTurnContinuationState | null | undefined
): boolean {
  return !!state?.lastResponse?.responseId
}

function formatCodexInputMismatchDetail(
  label: "baseline" | "request",
  detail: CodexInputMismatchItemDetail | undefined
): string {
  if (!detail) {
    return ""
  }
  const parts = [
    `${label}_sig=${detail.signature}`,
    `${label}_json_len=${detail.jsonLength}`,
  ]
  if (detail.role) {
    parts.push(`${label}_role=${detail.role}`)
  }
  if (detail.preview) {
    parts.push(`${label}_preview=${JSON.stringify(detail.preview)}`)
  }
  return ` ${parts.join(" ")}`
}
