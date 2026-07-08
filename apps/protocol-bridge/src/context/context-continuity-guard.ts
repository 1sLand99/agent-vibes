import {
  ContextConversationState,
  extractText,
  isToolResultBlock,
  normalizeContent,
  type LooseMessageContent,
} from "./types"

const DEFAULT_MAX_QUOTED_USER_CHARS = 480
const CODEX_SUMMARY_PREFIX_START =
  "Another language model started to solve this problem"

/**
 * Pull the latest real user-authored message from the live transcript.
 * Synthetic user-role records such as compact summaries, attachments, hook
 * output, and tool results are not the user's current request.
 */
export function extractLatestUserUtterance(
  state: ContextConversationState,
  maxChars = DEFAULT_MAX_QUOTED_USER_CHARS
): string | undefined {
  const records = state.records
  if (!records || records.length === 0) return undefined
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (!record) continue
    if (record.role !== "user") continue
    if (record.kind && record.kind !== "message") continue
    const text =
      typeof record.content === "string"
        ? record.content
        : extractText(record.content)
    const trimmed = text?.trim()
    if (!trimmed) continue
    if (containsToolResult(record.content)) continue
    if (isSyntheticUserContextText(trimmed)) continue
    return trimmed.length > maxChars
      ? `${trimmed.slice(0, maxChars)}...`
      : trimmed
  }
  return undefined
}

function containsToolResult(content: LooseMessageContent): boolean {
  if (typeof content === "string") return false
  try {
    return normalizeContent(content).some(isToolResultBlock)
  } catch {
    return false
  }
}

function isSyntheticUserContextText(text: string): boolean {
  const normalized = text.trimStart()
  return (
    normalized.startsWith("Current Codex turn context:") ||
    normalized.startsWith(CODEX_SUMMARY_PREFIX_START) ||
    normalized.startsWith("This is compressed historical context") ||
    /^(?:\[Context (?:attachment|summary|collapse|boundary|attachment removed)|\[Result of an earlier tool call|\[tool_result stored\])/i.test(
      normalized
    ) ||
    /^# AGENTS\.md instructions\b/i.test(normalized) ||
    /^<environment_context>/i.test(normalized) ||
    /^<turn_aborted>/i.test(normalized) ||
    /\bDocumentId:\s*tool_result:/i.test(normalized) ||
    /\/\.agent-vibes\/tool-results\//i.test(normalized)
  )
}

/**
 * Hard topic-continuity guard injected as a transient synthetic user message
 * immediately after compaction. It keeps the next model turn anchored to the
 * latest real user request instead of letting older compacted topics compete
 * with the retained recent transcript.
 */
export function buildTopicContinuityGuard(
  latestUserUtterance: string | undefined
): string | undefined {
  if (!latestUserUtterance) return undefined
  return [
    "[context-compact] Topic continuity guard:",
    "- The conversation above was just compacted. The summary captures the full prior history; do not re-derive or restate it.",
    "- Resume work on the user's MOST RECENT request, quoted below. Do not pivot back to earlier tasks that were already answered or set aside, even if the summary mentions them.",
    "- If the most recent request is unclear or already resolved, ask the user before starting new work; do not invent next steps from older threads.",
    "",
    "Most recent user request (verbatim):",
    `"""${latestUserUtterance}"""`,
  ].join("\n")
}

export function composeCompactHookMessage(
  hookMessage: string | undefined,
  continuityGuard: string | undefined
): string | undefined {
  const composed = [hookMessage, continuityGuard]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n\n")
    .trim()
  return composed || undefined
}
