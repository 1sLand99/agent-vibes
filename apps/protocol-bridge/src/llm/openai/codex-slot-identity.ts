import * as crypto from "crypto"

declare const CODEX_SLOT_KEY_BRAND: unique symbol
declare const CODEX_RELOAD_KEY_BRAND: unique symbol

/**
 * Opaque identity for one routable Codex account slot.
 *
 * Slot keys cross the affinity, continuation-cache, and transport-routing
 * boundaries. Keep their representation secret-free, delimiter-safe, and
 * versioned so those owners cannot accidentally receive an ad hoc composite
 * string.
 */
export type CodexSlotKey = string & {
  readonly [CODEX_SLOT_KEY_BRAND]: true
}

/** Process-local reconciliation identity for a configured Codex slot. */
export type CodexReloadKey = string & {
  readonly [CODEX_RELOAD_KEY_BRAND]: true
}

const CODEX_SLOT_KEY_PREFIX = "codex-slot:v1:"
const CODEX_SLOT_KEY_PATTERN = /^codex-slot:v1:[0-9a-f]{64}$/
const CODEX_RELOAD_KEY_PREFIX = "codex-reload:v1:"

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

function encodeCodexSlotKey(
  kind: string,
  identity: string,
  baseUrl: string
): CodexSlotKey {
  const canonicalIdentity = JSON.stringify([kind, identity, baseUrl])
  const digest = crypto
    .createHash("sha256")
    .update(canonicalIdentity)
    .digest("hex")
  return `${CODEX_SLOT_KEY_PREFIX}${digest}` as CodexSlotKey
}

function encodeCodexReloadKey(
  kind: string,
  identity: readonly (string | number)[],
  baseUrl: string
): CodexReloadKey {
  const canonicalIdentity = JSON.stringify([kind, ...identity, baseUrl])
  const digest = crypto
    .createHash("sha256")
    .update(canonicalIdentity)
    .digest("hex")
  return `${CODEX_RELOAD_KEY_PREFIX}${digest}` as CodexReloadKey
}

export function requireCodexSlotKey(
  value: unknown,
  label: string
): CodexSlotKey {
  if (typeof value !== "string" || !CODEX_SLOT_KEY_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical Codex slot key`)
  }
  return value as CodexSlotKey
}

export function buildCodexSlotStickyKey(
  identity: CodexSlotIdentityInput
): CodexSlotKey {
  const baseUrl = identity.baseUrl?.trim() || ""
  const apiKey = identity.apiKey?.trim()
  if (apiKey) {
    return encodeCodexSlotKey("api_key", apiKey, baseUrl)
  }

  const accountId = identity.accountId?.trim()
  if (accountId) {
    return encodeCodexSlotKey("account_id", accountId, baseUrl)
  }

  const email = identity.email?.trim().toLowerCase()
  if (email) {
    return encodeCodexSlotKey("email", email, baseUrl)
  }

  const refreshToken = identity.refreshToken?.trim()
  if (refreshToken) {
    return encodeCodexSlotKey("refresh", refreshToken, baseUrl)
  }

  const accessToken = identity.accessToken?.trim()
  if (accessToken) {
    return encodeCodexSlotKey("access", accessToken, baseUrl)
  }

  return encodeCodexSlotKey("label", identity.label || "", baseUrl)
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

export function buildCodexReloadKey(
  identity: CodexSlotIdentityInput,
  defaultBaseUrl: string
): CodexReloadKey {
  const baseUrl = identity.baseUrl?.trim() || defaultBaseUrl
  const email = identity.email?.trim().toLowerCase() || ""
  const accountId = identity.accountId?.trim() || ""
  const apiKey = identity.apiKey?.trim() || ""
  const refreshToken = identity.refreshToken?.trim() || ""
  const accessToken = identity.accessToken?.trim() || ""

  if (email && accountId) {
    return encodeCodexReloadKey("email_account", [email, accountId], baseUrl)
  }
  if (email && refreshToken) {
    return encodeCodexReloadKey("email_refresh", [email, refreshToken], baseUrl)
  }
  if (email && accessToken) {
    return encodeCodexReloadKey("email_access", [email, accessToken], baseUrl)
  }
  if (email) {
    return encodeCodexReloadKey("email", [email], baseUrl)
  }
  if (apiKey) {
    return encodeCodexReloadKey("api_key", [apiKey], baseUrl)
  }
  if (refreshToken) {
    return encodeCodexReloadKey("refresh", [refreshToken], baseUrl)
  }
  if (accessToken) {
    return encodeCodexReloadKey("access", [accessToken], baseUrl)
  }
  if (accountId) {
    return encodeCodexReloadKey("account_id", [accountId], baseUrl)
  }

  return encodeCodexReloadKey(
    "path",
    [identity.configPath || "", identity.index ?? 0],
    baseUrl
  )
}
