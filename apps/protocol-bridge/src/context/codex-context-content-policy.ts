import type { CodexTruncationPolicy, LooseMessageContent } from "./types"

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

export function truncateCodexTextByTokens(
  text: string,
  maxTokens: number
): string {
  const limit = Math.max(0, Math.floor(maxTokens * 4))
  return truncateTextWithByteEstimate(text, limit, true)
}

export function truncateCodexTextByBytes(
  text: string,
  maxBytes: number
): string {
  return truncateTextWithByteEstimate(
    text,
    Math.max(0, Math.floor(maxBytes)),
    false
  )
}

function truncateTextWithByteEstimate(
  text: string,
  maxBytes: number,
  useTokens: boolean
): string {
  if (!text) return ""
  const totalBytes = Buffer.byteLength(text, "utf8")
  const totalChars = Array.from(text).length
  if (maxBytes > 0 && totalBytes <= maxBytes) return text
  if (maxBytes === 0) {
    return formatTruncationMarker(
      useTokens,
      removedUnits(useTokens, totalBytes, totalChars)
    )
  }

  const leftBudget = Math.floor(maxBytes / 2)
  const rightBudget = maxBytes - leftBudget
  const { removedChars, prefix, suffix } = splitStringByUtf8Budget(
    text,
    leftBudget,
    rightBudget
  )
  const marker = formatTruncationMarker(
    useTokens,
    removedUnits(useTokens, Math.max(0, totalBytes - maxBytes), removedChars)
  )
  return `${prefix}${marker}${suffix}`
}

function splitStringByUtf8Budget(
  text: string,
  beginningBytes: number,
  endBytes: number
): { removedChars: number; prefix: string; suffix: string } {
  if (!text) return { removedChars: 0, prefix: "", suffix: "" }
  const totalBytes = Buffer.byteLength(text, "utf8")
  const tailStartTarget = Math.max(0, totalBytes - endBytes)
  let prefixEnd = 0
  let suffixStart = text.length
  let removedChars = 0
  let suffixStarted = false
  let byteOffset = 0
  let codeUnitOffset = 0

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8")
    const charStart = byteOffset
    const charEnd = byteOffset + charBytes
    const nextCodeUnitOffset = codeUnitOffset + char.length
    if (charEnd <= beginningBytes) {
      prefixEnd = nextCodeUnitOffset
    } else if (charStart >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = codeUnitOffset
        suffixStarted = true
      }
    } else {
      removedChars++
    }
    byteOffset = charEnd
    codeUnitOffset = nextCodeUnitOffset
  }

  if (suffixStart < prefixEnd) {
    suffixStart = prefixEnd
  }
  return {
    removedChars,
    prefix: text.slice(0, prefixEnd),
    suffix: text.slice(suffixStart),
  }
}

function formatTruncationMarker(
  useTokens: boolean,
  removedCount: number
): string {
  return useTokens
    ? `…${removedCount} tokens truncated…`
    : `…${removedCount} chars truncated…`
}

function removedUnits(
  useTokens: boolean,
  removedBytes: number,
  removedChars: number
): number {
  return useTokens ? Math.ceil(removedBytes / 4) : removedChars
}
