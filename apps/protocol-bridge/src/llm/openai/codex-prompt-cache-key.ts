import * as crypto from "crypto"

/** Codex Responses API rejects prompt_cache_key values longer than 64 chars. */
export const CODEX_PROMPT_CACHE_KEY_MAX_LENGTH = 64

const UUID_V5_OID_NAMESPACE = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

export function buildDeterministicCodexPromptCacheKey(name: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.from(UUID_V5_OID_NAMESPACE.replace(/-/g, ""), "hex"))
    .update(name)
    .digest()

  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80

  const hex = hash.toString("hex").slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

export function normalizeCodexPromptCacheKey(cacheId: string): string {
  const trimmed = cacheId.trim()
  if (!trimmed) return ""
  if (trimmed.length <= CODEX_PROMPT_CACHE_KEY_MAX_LENGTH) {
    return trimmed
  }

  return buildDeterministicCodexPromptCacheKey(
    `cli-proxy-api:codex:prompt-cache-key:${trimmed}`
  )
}
