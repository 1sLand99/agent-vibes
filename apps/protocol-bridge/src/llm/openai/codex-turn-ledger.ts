import {
  canonicalizeCodexInputItemsForContinuation,
  prepareCodexContinuationRequest,
  type CodexContinuationDecision,
  type CodexContinuationState,
  type CodexLastResponseSnapshot,
} from "./codex-incremental"
import { codexResponseOutputItemToInputItem } from "./codex-response-items"
import type { CodexInputItem } from "./codex-native-types"

export type CodexTurnLedgerState = CodexContinuationState
export type CodexTurnLedgerResponse = CodexLastResponseSnapshot
export type { CodexContinuationDecision }

export function prepareCodexTurnLedgerRequest(
  request: Record<string, unknown>,
  state: CodexTurnLedgerState,
  allowEmptyDelta: boolean
): CodexContinuationDecision {
  return prepareCodexContinuationRequest(request, state, allowEmptyDelta)
}

export function appendCodexResponseOutputItemToLedger(
  itemsAdded: CodexInputItem[],
  item: Record<string, unknown> | undefined
): void {
  const inputItem = codexResponseOutputItemToInputItem(item)
  if (!inputItem) {
    return
  }
  itemsAdded.push(...canonicalizeCodexInputItemsForContinuation([inputItem]))
}

export function getCodexCompletedResponseId(
  event: Record<string, unknown> | undefined
): string {
  if (!event || event.type !== "response.completed") {
    return ""
  }
  const response = event.response as Record<string, unknown> | undefined
  return typeof response?.id === "string" ? response.id : ""
}
