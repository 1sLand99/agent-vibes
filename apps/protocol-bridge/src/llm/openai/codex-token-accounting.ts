import type { CodexInputItem } from "./codex-native-types"

const CODEX_TOKEN_BYTES = 4
const CODEX_ENCRYPTED_REASONING_HEADER_BYTES = 650
const CODEX_RESIZED_IMAGE_BYTES = 7_373
export const CODEX_CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated"

export interface CodexCompactionInputTrimResult {
  readonly input: readonly CodexInputItem[]
  readonly rewrittenOutputs: number
  readonly estimatedTokensBefore: number
  readonly estimatedTokensAfter: number
}

/**
 * Mirrors Codex core's model-visible byte accounting for an installed native
 * Responses window. Opaque reasoning and compaction ciphertext is decoded-size
 * context, not ordinary JSON text.
 */
export function estimateCodexNativeInputTokens(
  input: readonly CodexInputItem[]
): number {
  return input.reduce(
    (total, item) => total + estimateCodexInputItemTokens(item),
    0
  )
}

export function estimateCodexInputItemTokens(item: CodexInputItem): number {
  return tokensFromBytes(estimateCodexInputItemVisibleBytes(item))
}

/**
 * Mirrors Codex core's Remote Compaction V2 overflow preparation. Only the
 * contiguous tool-output suffix is rewritten, newest first, until the
 * complete compaction request fits. Calls and output identities are retained,
 * so tool-pair structure and rollout source bindings remain exact.
 */
export function trimCodexFunctionCallOutputsToContextWindow(input: {
  readonly items: readonly CodexInputItem[]
  readonly contextWindowTokens: number
  readonly requestOverheadTokens: number
}): CodexCompactionInputTrimResult {
  if (
    !Number.isFinite(input.contextWindowTokens) ||
    input.contextWindowTokens <= 0 ||
    !Number.isFinite(input.requestOverheadTokens) ||
    input.requestOverheadTokens < 0
  ) {
    throw new Error(
      "Codex compaction trimming requires a positive window and non-negative request overhead"
    )
  }

  const items = input.items.map((item) => structuredClone(item))
  let estimatedTokens =
    estimateCodexNativeInputTokens(items) + input.requestOverheadTokens
  const estimatedTokensBefore = estimatedTokens
  let rewrittenOutputs = 0

  for (let index = items.length - 1; index >= 0; index--) {
    if (estimatedTokens <= input.contextWindowTokens) break
    const current = items[index]!
    const rewritten = rewriteCodexToolOutputForContextWindow(current)
    if (!rewritten) break
    estimatedTokens =
      estimatedTokens -
      estimateCodexInputItemTokens(current) +
      estimateCodexInputItemTokens(rewritten)
    items[index] = rewritten
    rewrittenOutputs += 1
  }

  return Object.freeze({
    input: Object.freeze(items),
    rewrittenOutputs,
    estimatedTokensBefore,
    estimatedTokensAfter: estimatedTokens,
  })
}

function rewriteCodexToolOutputForContextWindow(
  item: CodexInputItem
): CodexInputItem | undefined {
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    return {
      ...structuredClone(item),
      output: CODEX_CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
    }
  }
  if (item.type === "tool_search_output") {
    return {
      ...structuredClone(item),
      tools: [],
    }
  }
  return undefined
}

function estimateCodexInputItemVisibleBytes(item: CodexInputItem): number {
  if (
    (item.type === "reasoning" ||
      item.type === "compaction" ||
      item.type === "context_compaction") &&
    typeof item.encrypted_content === "string"
  ) {
    return Math.max(
      0,
      Math.floor((item.encrypted_content.length * 3) / 4) -
        CODEX_ENCRYPTED_REASONING_HEADER_BYTES
    )
  }

  const serializedBytes = Buffer.byteLength(JSON.stringify(item), "utf8")
  const imageAdjustment = estimateImagePayloadAdjustment(item)
  const encryptedOutputAdjustment =
    estimateEncryptedFunctionOutputAdjustment(item)
  return Math.max(
    0,
    serializedBytes -
      imageAdjustment.payloadBytes +
      imageAdjustment.replacementBytes -
      encryptedOutputAdjustment.payloadBytes +
      encryptedOutputAdjustment.replacementBytes
  )
}

function estimateImagePayloadAdjustment(item: CodexInputItem): {
  payloadBytes: number
  replacementBytes: number
} {
  const contentItems: unknown[] = []
  if (item.type === "message") {
    contentItems.push(...item.content)
  } else if (
    (item.type === "function_call_output" ||
      item.type === "custom_tool_call_output") &&
    Array.isArray(item.output)
  ) {
    contentItems.push(...item.output)
  }

  let payloadBytes = 0
  let replacementBytes = 0
  for (const content of contentItems) {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      continue
    }
    const block = content as Record<string, unknown>
    if (block.type !== "input_image" || typeof block.image_url !== "string") {
      continue
    }
    const payload = parseBase64ImagePayload(block.image_url)
    if (payload === undefined) continue
    payloadBytes += Buffer.byteLength(payload, "utf8")
    replacementBytes += CODEX_RESIZED_IMAGE_BYTES
  }
  return { payloadBytes, replacementBytes }
}

function parseBase64ImagePayload(imageUrl: string): string | undefined {
  const comma = imageUrl.indexOf(",")
  if (comma < 0) return undefined
  const metadata = imageUrl.slice(0, comma)
  if (!metadata.toLowerCase().startsWith("data:image/")) return undefined
  if (
    !metadata
      .slice("data:".length)
      .split(";")
      .some((part) => part.toLowerCase() === "base64")
  ) {
    return undefined
  }
  return imageUrl.slice(comma + 1)
}

function estimateEncryptedFunctionOutputAdjustment(item: CodexInputItem): {
  payloadBytes: number
  replacementBytes: number
} {
  if (item.type !== "function_call_output" || !Array.isArray(item.output)) {
    return { payloadBytes: 0, replacementBytes: 0 }
  }
  let payloadBytes = 0
  let replacementBytes = 0
  for (const content of item.output) {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      continue
    }
    const encryptedContent = content.encrypted_content
    if (typeof encryptedContent !== "string") continue
    payloadBytes += Buffer.byteLength(encryptedContent, "utf8")
    replacementBytes += Math.ceil((encryptedContent.length * 9) / 16)
  }
  return { payloadBytes, replacementBytes }
}

function tokensFromBytes(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / CODEX_TOKEN_BYTES)
}
