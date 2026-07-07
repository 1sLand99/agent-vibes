import { normalizeCodexPromptCacheKey } from "./codex-prompt-cache-key"

/**
 * Mirrors upstream Codex ModelClient::prepare_response_items_for_request().
 *
 * Codex CLI clears Responses item ids before sending when item ids are not
 * explicitly enabled and the request is not persisted with `store=true`.
 * The bridge never enables item ids, so request payloads sent to Codex should
 * not carry historical response-item `id` values. Tool `call_id` values are
 * semantic linkage and must be preserved.
 */
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
      if (!Object.prototype.hasOwnProperty.call(item, "id")) {
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
