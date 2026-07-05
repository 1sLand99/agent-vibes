import type { CodexInputItem } from "./codex-native-types"

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
  "context_compaction",
])

export function getCodexApiInputItemType(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ""
  }
  const type = (value as Record<string, unknown>).type
  return typeof type === "string" ? type.trim() : ""
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
