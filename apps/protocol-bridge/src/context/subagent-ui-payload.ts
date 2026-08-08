import type { LooseMessageContent } from "./types"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * A sub-agent (`task`) tool_result carries Cursor-only presentation data in
 * `structuredContent.taskSuccess`, including the full child-session
 * transcript, diagnostic paths, and replay metadata. It belongs exclusively
 * to the IDE transcript UI and is never part of a provider request.
 *
 * The token counter charges a tool_result block for
 * `max(textTokens, structuredContentTokens)`
 * (token-counter.service.ts countContentBlock), so a sub-agent result
 * whose conversationSteps serialise to ~1 MB makes that single record
 * cost ~300K tokens. The moment the sub-agent result is folded back into
 * the parent conversation the projected context blows the request budget
 * and `ContextCompactionService.ensureWithinBudget` throws
 * `ContextProjectionBudgetExceededError` — record-granularity compaction
 * cannot shrink a single oversized record, so the parent turn dies.
 *
 * The fix is to never let this UI-only payload enter the backend projection
 * in the first place: ContextProjectionService removes the whole
 * `taskSuccess` member at the authoritative `state.records → provider`
 * boundary. If that was the only structured member, it removes
 * `structuredContent` too, so providers consume the semantic tool-result
 * text. This is a pure projection transform — the durable transcript record
 * keeps the full Cursor UI payload for replay.
 *
 * Returns the same `content` reference when nothing changed so callers
 * can cheaply detect no-ops.
 */
export function stripCursorUiTaskSuccessFromProviderContent(
  content: LooseMessageContent
): LooseMessageContent {
  if (!Array.isArray(content)) {
    return content
  }

  let changed = false
  const next = content.map((block) => {
    if (!isPlainObject(block) || block.type !== "tool_result") {
      return block
    }
    const structured = block.structuredContent
    if (!isPlainObject(structured)) {
      return block
    }
    if (!Object.prototype.hasOwnProperty.call(structured, "taskSuccess")) {
      return block
    }

    changed = true
    const { taskSuccess: _taskSuccess, ...providerStructuredContent } =
      structured
    if (Object.keys(providerStructuredContent).length === 0) {
      const { structuredContent: _structuredContent, ...providerBlock } = block
      return providerBlock
    }

    return {
      ...block,
      structuredContent: providerStructuredContent,
    }
  })

  return changed ? (next as LooseMessageContent) : content
}
