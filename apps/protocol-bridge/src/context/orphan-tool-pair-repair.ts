import {
  ContentBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  UnifiedMessage,
  isToolResultBlock,
  isToolUseBlock,
} from "./types"

/**
 * Defensive send-time repair for legacy compacted states or external
 * truncation paths that already contain split tool_use ↔ tool_result pairs.
 * New compaction candidates must choose a tool-safe durable boundary before
 * records are installed; this transform is kept as a migration guard over the
 * projected message list.
 *
 * Two symmetric orphan kinds are repaired:
 *
 * 1. Orphaned tool_result — its tool_use was archived behind the boundary.
 *    Rewritten into a text block preserving the result body so the request
 *    stays protocol-valid without the tool_use.
 *
 * 2. Orphaned tool_use — its tool_result was archived/lost. Left untouched it
 *    reaches the Kiro translator, which closes it with a `status:"error"`
 *    "interrupted or result was lost due to context truncation" placeholder
 *    (llm/aws/translator.ts). That misleads the model into thinking the tool
 *    failed (a successful grep_search looks like it errored). Repaired by
 *    appending a neutral, non-error synthetic tool_result.
 *
 * CRITICAL: a tool_use whose id is in `pendingToolUseIds` is genuinely
 * in-flight (its result has not arrived yet) and MUST be left untouched —
 * synthesising a result for it would corrupt an active tool call.
 */
export function repairOrphanedToolPairs(
  messages: UnifiedMessage[],
  options?: { pendingToolUseIds?: Iterable<string> }
): UnifiedMessage[] {
  const toolUseIds = new Set<string>()
  const answeredToolUseIds = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isToolUseBlock(block)) {
        toolUseIds.add(block.id)
      } else if (isToolResultBlock(block)) {
        answeredToolUseIds.add(block.tool_use_id)
      }
    }
  }

  const resultRepaired = repairOrphanedToolResults(messages, toolUseIds)
  return repairOrphanedToolUses(
    resultRepaired,
    answeredToolUseIds,
    new Set(options?.pendingToolUseIds ?? [])
  )
}

function repairOrphanedToolResults(
  messages: UnifiedMessage[],
  toolUseIds: ReadonlySet<string>
): UnifiedMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((block) => {
      if (isToolResultBlock(block) && !toolUseIds.has(block.tool_use_id)) {
        changed = true
        return {
          type: "text",
          text: renderOrphanedToolResultText(block),
        } as TextBlock
      }
      return block
    })
    return changed ? { ...message, content } : message
  })
}

function repairOrphanedToolUses(
  messages: UnifiedMessage[],
  answeredToolUseIds: ReadonlySet<string>,
  pendingToolUseIds: ReadonlySet<string>
): UnifiedMessage[] {
  const out: UnifiedMessage[] = []
  for (const message of messages) {
    out.push(message)
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }
    const orphans: ToolUseBlock[] = []
    for (const block of message.content) {
      if (
        isToolUseBlock(block) &&
        !answeredToolUseIds.has(block.id) &&
        !pendingToolUseIds.has(block.id)
      ) {
        orphans.push(block)
      }
    }
    if (orphans.length === 0) continue
    out.push({
      role: "user",
      content: orphans.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: renderOrphanedToolUseText(block),
      })) as ContentBlock[],
    })
  }
  return out
}

function renderOrphanedToolResultText(block: ToolResultBlock): string {
  const body = extractOrphanedToolResultBody(block)
  if (!body.trim()) {
    // No body survived (already-cleared / empty structured result). Only in
    // this case is the result genuinely unavailable — say so explicitly and
    // allow a re-run.
    return (
      `[The request for this earlier tool call was compacted into the ` +
      `summary above and its result body is no longer available. Re-run the ` +
      `tool if you need the result again.]`
    )
  }
  // The body IS still present here — only the originating tool_use was
  // archived behind the compaction boundary. The previous framing ("now
  // summarized into the compaction summary above") made the model treat a
  // still-present result as gone and re-run it (observed: repeated
  // grep_search re-runs / fallback to run_terminal_command after compaction).
  // Present the result as authoritative so the model uses it directly.
  return (
    `[Result of an earlier tool call whose request was compacted into the ` +
    `summary above. The result below is complete and current — use it ` +
    `directly; do not re-run the tool just to reproduce it.]\n${body}`
  )
}

/**
 * Robustly extract the textual body of a (possibly orphaned) tool_result so
 * the orphan repair never silently drops a structured search/read result.
 * Falls back to JSON for non-text content parts and to `structuredContent`
 * when the primary content is empty.
 */
function extractOrphanedToolResultBody(block: ToolResultBlock): string {
  const parts: string[] = []
  if (typeof block.content === "string") {
    if (block.content.length > 0) parts.push(block.content)
  } else if (Array.isArray(block.content)) {
    for (const inner of block.content) {
      if (inner.type === "text") {
        if (inner.text.length > 0) parts.push(inner.text)
      } else {
        try {
          parts.push(JSON.stringify(inner))
        } catch {
          // skip unserializable parts
        }
      }
    }
  }
  if (parts.length === 0 && block.structuredContent) {
    try {
      parts.push(JSON.stringify(block.structuredContent))
    } catch {
      // skip unserializable structured content
    }
  }
  return parts.join("\n")
}

function renderOrphanedToolUseText(block: ToolUseBlock): string {
  return (
    `[The result of this earlier ${block.name} call was archived during ` +
    `context compaction and is no longer available verbatim. The call ` +
    `itself completed; this is not an error. Re-run the tool if you need ` +
    `the result again.]`
  )
}
