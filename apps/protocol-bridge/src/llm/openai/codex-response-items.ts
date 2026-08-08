import type {
  CodexCustomToolCall,
  CodexFunctionCall,
  CodexInputItem,
  CodexInputMessage,
} from "./codex-native-types"
import { requireExactDurableIdentifier } from "../../context/durable-identifier"

const CODEX_API_VISIBLE_INPUT_ITEM_TYPES = new Set([
  "additional_tools",
  "message",
  "agent_message",
  "reasoning",
  "local_shell_call",
  "function_call",
  "tool_search_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_output",
  "web_search_call",
  "image_generation_call",
  "compaction",
  "compaction_trigger",
  "context_compaction",
])

export function getCodexApiInputItemType(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ""
  }
  const type = (value as Record<string, unknown>).type
  return typeof type === "string" ? type : ""
}

export function isCodexApiVisibleInputItem(
  value: unknown
): value is CodexInputItem {
  const type = getCodexApiInputItemType(value)
  if (!CODEX_API_VISIBLE_INPUT_ITEM_TYPES.has(type)) {
    return false
  }

  if (type === "message") {
    const role = (value as Record<string, unknown>).role
    return role !== "system"
  }

  return true
}

export function cloneCodexApiVisibleInputItem(
  value: unknown
): CodexInputItem | undefined {
  if (!isCodexApiVisibleInputItem(value)) {
    return undefined
  }
  return { ...(value as Record<string, unknown>) } as CodexInputItem
}

export function codexResponseOutputItemToInputItem(
  item: Record<string, unknown> | undefined
): CodexInputItem | undefined {
  if (!item) return undefined

  if (item.type === "function_call") {
    return {
      ...item,
      type: "function_call",
      call_id: requireExactDurableIdentifier(
        item.call_id,
        "Codex function-call response call_id"
      ),
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
      call_id: requireExactDurableIdentifier(
        item.call_id,
        "Codex custom-tool-call response call_id"
      ),
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
