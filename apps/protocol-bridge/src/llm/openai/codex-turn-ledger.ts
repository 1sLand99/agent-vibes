import {
  canonicalizeCodexInputItemsForContinuation,
  prepareCodexContinuationRequest,
  type CodexContinuationDecision,
  type CodexContinuationState,
  type CodexLastResponseSnapshot,
} from "./codex-incremental"
import { cloneCodexApiVisibleInputItem } from "./codex-response-items"
import type {
  CodexCustomToolCall,
  CodexFunctionCall,
  CodexInputItem,
  CodexInputMessage,
} from "./codex-native-types"

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

export function codexResponseOutputItemToInputItem(
  item: Record<string, unknown> | undefined
): CodexInputItem | undefined {
  if (!item) return undefined

  if (item.type === "function_call") {
    return {
      ...item,
      type: "function_call",
      call_id: typeof item.call_id === "string" ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      arguments:
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}),
    } satisfies CodexFunctionCall
  }

  if (item.type === "custom_tool_call") {
    return {
      ...item,
      type: "custom_tool_call",
      call_id: typeof item.call_id === "string" ? item.call_id : "",
      name: typeof item.name === "string" ? item.name : "",
      input:
        typeof item.input === "string"
          ? item.input
          : JSON.stringify(item.input ?? ""),
    } satisfies CodexCustomToolCall
  }

  if (item.type === "message") {
    const rawContent = item.content
    const content = Array.isArray(rawContent)
      ? (rawContent as Array<Record<string, unknown>>)
      : typeof rawContent === "string"
        ? [{ type: "output_text", text: rawContent }]
        : []

    return {
      ...item,
      type: "message",
      role: typeof item.role === "string" ? item.role : "assistant",
      content,
    } satisfies CodexInputMessage
  }

  return cloneCodexApiVisibleInputItem(item)
}
