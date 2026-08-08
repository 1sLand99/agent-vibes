import type { CodexTruncationPolicy, LooseMessageContent } from "./types"
import {
  truncateCodexTextByBytes,
  truncateCodexTextByTokens,
} from "../llm/openai/codex-text-truncation"

export { truncateCodexTextByBytes, truncateCodexTextByTokens }

export function processCodexMessageContent(
  content: LooseMessageContent,
  policy: CodexTruncationPolicy
): LooseMessageContent {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return content
  }

  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return []
    if (block.type !== "tool_result") {
      return [{ ...block }]
    }

    const nextBlock = { ...block } as Record<string, unknown>
    nextBlock.content = truncateCodexToolResultContent(
      nextBlock.content,
      policy
    )
    return [nextBlock]
  }) as LooseMessageContent
}

export function truncateCodexToolResultContent(
  content: unknown,
  policy: CodexTruncationPolicy
): unknown {
  if (typeof content === "string") {
    return truncateCodexTextWithMarker(content, policy)
  }
  if (!Array.isArray(content)) {
    return content
  }
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return []
    const record = { ...(part as Record<string, unknown>) }
    if (record.type === "image") return []
    if (record.type === "text" && typeof record.text === "string") {
      record.text = truncateCodexTextWithMarker(record.text, policy)
    }
    return [record]
  })
}

export function truncateCodexTextWithMarker(
  text: string,
  policy: CodexTruncationPolicy
): string {
  return policy.mode === "tokens"
    ? truncateCodexTextByTokens(text, policy.limit)
    : truncateCodexTextByBytes(text, policy.limit)
}
