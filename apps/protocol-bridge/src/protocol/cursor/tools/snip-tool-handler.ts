/**
 * `snip_messages` — bridge-internal tool that lets the model free up context
 * window space by snipping (summarizing away) large tool outputs it has
 * already extracted the useful information from.
 *
 * Modeled after Claude Code's `Snip` tool
 * (packages/builtin-tools/src/tools/SnipTool/SnipTool.ts): the model selects
 * specific items by id (NOT a blind `keep_recent` tail-cut), and the snipped
 * content is REPLACED WITH A SHORT SUMMARY rather than hard-deleted — so the
 * model retains awareness and the conversation structure stays intact.
 *
 * Bridge realization: Cursor's protocol regenerates per-message uuids and
 * merges content when projecting history for the backend, so cc's per-message
 * `[id:]` tags are not stable here. The stable, model-visible id that survives
 * projection is the `tool_use_id`. So the model references the tool calls
 * whose outputs to snip; the bridge replaces each named `tool_result`'s
 * content with the `reason` summary via the existing tool-result replacement
 * machinery (`prepareToolResultReplacement` / Claude projection mutation).
 * This keeps the `tool_use`/`tool_result` pair intact (zero orphan risk) and
 * structurally cannot touch the user's task-anchor messages.
 *
 * The user-invoked `/force-snip` route is the remove-everything counterpart
 * (mirrors cc's `/force-snip` slash command) and keeps using the boundary
 * removal path in `context-state.service.ts`.
 */

import type { ToolDefinition } from "./cursor-tool-mapper"

export const SNIP_MESSAGES_TOOL_NAME = "snip_messages"

/**
 * Anthropic-style tool definition. Shape matches what `buildToolsForApi()`
 * returns so it can be appended to the tools array directly.
 */
export const SNIP_MESSAGES_TOOL_DEFINITION: ToolDefinition = {
  type: "function",
  name: SNIP_MESSAGES_TOOL_NAME,
  description:
    "Free up context window space by snipping large tool outputs you have " +
    "already extracted what you need from. You reference the outputs by their " +
    "tool call id; each output is replaced in-place with a short summary you " +
    "provide, so the conversation structure and your current task stay " +
    "intact. This only affects tool OUTPUTS — it never removes your task, the " +
    "user's messages, or your own reasoning.\n\n" +
    "Use this when earlier tool calls (file reads, searches, command output) " +
    "returned large results you have already used and no longer need verbatim.\n\n" +
    "Guidelines:\n" +
    "- `tool_use_ids`: the `tooluse_...` ids of the tool calls whose outputs " +
    "to snip (shown on each tool call/result in this conversation). Only snip " +
    "outputs you are confident you will not need verbatim again.\n" +
    "- `reason`: a short summary that PRESERVES THE KEY FACTS from those " +
    "outputs (file paths, key values, decisions, errors found). It becomes the " +
    "replacement placeholder, so capture what you will need to remember.\n" +
    "- You cannot un-snip: the original output is gone from your context for " +
    "the rest of this conversation, leaving only your summary.",
  input_schema: {
    type: "object",
    properties: {
      tool_use_ids: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description:
          "Tool call ids (tooluse_...) whose outputs are no longer needed " +
          "verbatim. Each matching tool result is replaced with the `reason` " +
          "summary.",
      },
      reason: {
        type: "string",
        description:
          "Short summary that replaces the snipped outputs. Capture the key " +
          "facts (file paths, values, decisions, errors) so you retain " +
          "awareness of what those outputs contained.",
      },
    },
    required: ["tool_use_ids"],
  },
}

export interface SnipMessagesSuccess {
  status: "success"
  snipped_count: number
  requested_count: number
  not_found: string[]
  reason?: string
  next_step: string
}

export interface SnipMessagesError {
  status: "error"
  error: string
}

export type SnipMessagesResult = SnipMessagesSuccess | SnipMessagesError

export function formatSnipMessagesResultText(
  result: SnipMessagesResult
): string {
  if (result.status === "success") {
    const body = {
      snipped_count: result.snipped_count,
      requested_count: result.requested_count,
      not_found: result.not_found,
      reason: result.reason,
      next_step: result.next_step,
    }
    return `[snip_messages success]\n${JSON.stringify(body, null, 2)}`
  }
  return `[snip_messages error]\n${JSON.stringify({ error: result.error }, null, 2)}`
}

/** Validate and normalize tool input. Pure: no I/O, no mutation. */
export function parseSnipMessagesInput(
  input: Record<string, unknown>
): { toolUseIds: string[]; reason?: string } | { error: string } {
  const raw = input.tool_use_ids
  if (!Array.isArray(raw)) {
    return {
      error:
        "Missing or invalid `tool_use_ids`. Provide an array of tool call " +
        "ids (tooluse_...) whose outputs to snip.",
    }
  }
  const toolUseIds = Array.from(
    new Set(
      raw
        .filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0
        )
        .map((id) => id.trim())
    )
  )
  if (toolUseIds.length === 0) {
    return {
      error:
        "`tool_use_ids` must contain at least one tool call id (tooluse_...).",
    }
  }
  const reason =
    typeof input.reason === "string" && input.reason.trim().length > 0
      ? input.reason.trim().slice(0, 500)
      : undefined
  return { toolUseIds, reason }
}
