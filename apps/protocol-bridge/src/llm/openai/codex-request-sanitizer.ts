import { normalizeCodexPromptCacheKey } from "./codex-prompt-cache-key"

/** Keep current prefixed Responses IDs; discard only unprefixed transient IDs. */
export function isPrefixedCodexItemId(value: unknown): value is string {
  return typeof value === "string" && /^[^_]+_.+$/s.test(value)
}

export function prepareCodexRequestForSend<T extends Record<string, unknown>>(
  request: T
): T {
  let changed = false
  let input = request.input

  const promptCacheKey = normalizeRequestPromptCacheKey(request)
  if (promptCacheKey !== request.prompt_cache_key) {
    changed = true
  }

  const rawInput = request.input
  if (request.store !== true && Array.isArray(rawInput)) {
    input = (rawInput as unknown[]).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item
      }
      if (
        !Object.prototype.hasOwnProperty.call(item, "id") ||
        isPrefixedCodexItemId((item as Record<string, unknown>).id)
      ) {
        return item
      }
      const next = { ...(item as Record<string, unknown>) }
      delete next.id
      changed = true
      return next
    })
  }

  if (!changed) return request

  const next = { ...request, input } as Record<string, unknown>
  if (promptCacheKey) {
    next.prompt_cache_key = promptCacheKey
  } else {
    delete next.prompt_cache_key
  }
  return next as T
}

function normalizeRequestPromptCacheKey(
  request: Record<string, unknown>
): string | undefined {
  const value = request.prompt_cache_key
  if (value === undefined) return undefined
  if (typeof value !== "string") return undefined
  return normalizeCodexPromptCacheKey(value) || undefined
}
