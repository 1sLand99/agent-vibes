import * as crypto from "crypto"

export interface CodexSlotIdentityInput {
  apiKey?: string
  email?: string
  accountId?: string
  refreshToken?: string
  accessToken?: string
  label?: string
  baseUrl?: string
  configPath?: string
  index?: number
}

export function hashCodexIdentityPart(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
}

export function buildCodexSlotStickyKey(
  identity: CodexSlotIdentityInput
): string {
  const baseUrl = identity.baseUrl?.trim() || ""
  const apiKey = identity.apiKey?.trim()
  if (apiKey) {
    return `api_key:${apiKey}\0base:${baseUrl}`
  }

  const accountId = identity.accountId?.trim()
  if (accountId) {
    return `account_id:${accountId}\0base:${baseUrl}`
  }

  const email = identity.email?.trim().toLowerCase()
  if (email) {
    return `email:${email}\0base:${baseUrl}`
  }

  const refreshToken = identity.refreshToken?.trim()
  if (refreshToken) {
    return `refresh:${hashCodexIdentityPart(refreshToken)}\0base:${baseUrl}`
  }

  const accessToken = identity.accessToken?.trim()
  if (accessToken) {
    return `access:${hashCodexIdentityPart(accessToken)}\0base:${baseUrl}`
  }

  return `label:${identity.label || ""}\0base:${baseUrl}`
}

export function buildCodexSlotStateKey(
  identity: CodexSlotIdentityInput,
  defaultBaseUrl: string
): string {
  const email = identity.email?.trim().toLowerCase() || ""
  const accountId = identity.accountId?.trim() || ""
  const apiKey = identity.apiKey?.trim() || ""
  const baseUrl = identity.baseUrl?.trim() || defaultBaseUrl

  if (email && accountId) {
    return hashCodexIdentityPart(`codex:${email}:${accountId}`)
  }
  if (email) {
    return hashCodexIdentityPart(`codex:${email}`)
  }
  if (apiKey) {
    return hashCodexIdentityPart(`codex:apikey:${apiKey}`)
  }
  return hashCodexIdentityPart(`codex:base:${baseUrl}`)
}

export function buildCodexOAuthCacheIdentity(input: {
  slotKey: string
  model: string
  conversationId?: string
  includeConversationId?: boolean
}): string {
  const conversationId = input.conversationId?.trim()
  if ((input.includeConversationId ?? true) && conversationId) {
    return `oauth:${input.slotKey}:conversation:${conversationId}:model:${input.model}`
  }
  return `oauth:${input.slotKey}:model:${input.model}`
}

export function buildCodexNormalizedReloadKey(
  identity: CodexSlotIdentityInput,
  defaultBaseUrl: string
): string {
  const baseUrl = identity.baseUrl?.trim() || defaultBaseUrl
  const email = identity.email?.trim().toLowerCase() || ""
  const accountId = identity.accountId?.trim() || ""
  const apiKey = identity.apiKey?.trim() || ""
  const refreshToken = identity.refreshToken?.trim() || ""
  const accessToken = identity.accessToken?.trim() || ""

  if (email && accountId) {
    return `email:${email}:${accountId}\0base:${baseUrl}`
  }
  if (email && refreshToken) {
    return `email_refresh:${email}:${hashCodexIdentityPart(refreshToken)}\0base:${baseUrl}`
  }
  if (email && accessToken) {
    return `email_access:${email}:${hashCodexIdentityPart(accessToken)}\0base:${baseUrl}`
  }
  if (email) {
    return `email:${email}\0base:${baseUrl}`
  }
  if (apiKey) {
    return `api_key:${apiKey}\0base:${baseUrl}`
  }
  if (refreshToken) {
    return `refresh:${hashCodexIdentityPart(refreshToken)}\0base:${baseUrl}`
  }
  if (accessToken) {
    return `access:${hashCodexIdentityPart(accessToken)}\0base:${baseUrl}`
  }
  if (accountId) {
    return `account_id:${accountId}\0base:${baseUrl}`
  }

  return `path:${identity.configPath || ""}:${identity.index ?? 0}\0base:${baseUrl}`
}
