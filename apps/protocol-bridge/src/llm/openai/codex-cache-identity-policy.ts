import { buildCodexOAuthCacheIdentity } from "./codex-slot-identity"

export type CodexPromptCacheIdentityDecision =
  | {
      kind: "conversation"
      cacheId: string
    }
  | {
      kind: "user"
      model: string
      userId: string
    }
  | {
      kind: "api_key"
      apiKey: string
    }
  | {
      kind: "oauth"
      identity: string
    }

export interface ResolveCodexPromptCacheIdentityOptions {
  model: string
  conversationId?: string
  cacheUserId?: string
  apiKey?: string
  slotKey: string
}

export function resolveCodexPromptCacheIdentity(
  options: ResolveCodexPromptCacheIdentityOptions
): CodexPromptCacheIdentityDecision {
  const conversationId = options.conversationId?.trim() || ""
  if (conversationId) {
    return {
      kind: "conversation",
      cacheId: conversationId,
    }
  }

  const userId = options.cacheUserId?.trim()
  if (userId) {
    return {
      kind: "user",
      model: options.model,
      userId,
    }
  }

  const apiKey = options.apiKey
  if (apiKey) {
    return {
      kind: "api_key",
      apiKey,
    }
  }

  return {
    kind: "oauth",
    identity: buildCodexOAuthCacheIdentity({
      slotKey: options.slotKey,
      model: options.model,
      conversationId,
      includeConversationId: false,
    }),
  }
}
