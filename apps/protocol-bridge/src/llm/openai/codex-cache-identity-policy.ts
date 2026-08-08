import { requireExactDurableIdentifier } from "../../context/durable-identifier"

/**
 * The native Codex client scopes prompt caching to Responses metadata's
 * session id. A bridge-local projection key, user id, account id, or OAuth
 * identity is not an interchangeable cache namespace.
 */
export function resolveCodexPromptCacheKey(sessionId: string): string {
  return requireExactDurableIdentifier(
    sessionId,
    "Codex prompt cache upstream sessionId"
  )
}
