import type { CodexTokenData } from "./codex-auth.service"
import { buildCodexNormalizedReloadKey } from "./codex-slot-identity"
import {
  type CodexModelTier,
  normalizeCodexModelTier,
} from "../shared/model-registry"

export interface PersistedCodexAccountRecord {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: string
  expire?: string
  baseUrl?: string
  proxyUrl?: string
}

export interface LoadedCodexAccountRecord extends PersistedCodexAccountRecord {
  configPath: string
}

export interface CodexLoadedAccountIdentity {
  email?: string
  accountId?: string
  apiKey?: string
  refreshToken?: string
  accessToken?: string
  baseUrl?: string
  configPath: string
}

export interface CodexFileSlotReloadIdentity {
  email?: string
  accountId?: string
  apiKey?: string
  refreshToken?: string
  accessToken?: string
  baseUrl?: string
  configPath?: string
  tokenData?: Pick<CodexTokenData, "refreshToken" | "accessToken"> | null
}

export interface CodexTokenHydrationExtractors {
  getAccountIdFromIdToken: (idToken: string) => string
  getWorkspaceIdFromIdToken: (idToken: string) => string
  getTokenExpiryFromJwt: (token: string) => string | null
  now?: () => number
}

export interface CodexFileSlotRecordFields {
  label?: string
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: CodexModelTier
  baseUrl: string
  proxyUrl?: string
  configPath: string
  persistedMatch: {
    apiKey?: string
    email?: string
    accountId?: string
    accessToken?: string
    refreshToken?: string
  }
}

export interface CodexFileSlotMetadataTarget {
  label?: string
  apiKey?: string
  accountId?: string
  workspaceId?: string
  email?: string
  planType?: CodexModelTier
  baseUrl: string
  proxyUrl?: string
  configPath?: string
  persistedMatch?: CodexFileSlotRecordFields["persistedMatch"]
}

export interface CodexPersistedAccountSlotInput {
  label?: string
  apiKey?: string
  email?: string
  accountId?: string
  baseUrl?: string
  proxyUrl?: string
  persistedMatch?: {
    apiKey?: string
    email?: string
    accountId?: string
    accessToken?: string
    refreshToken?: string
  }
}

export interface UpsertCodexPersistedAccountRecordOptions {
  accounts: readonly PersistedCodexAccountRecord[]
  account: CodexPersistedAccountSlotInput
  tokenData: Pick<
    CodexTokenData,
    "accessToken" | "refreshToken" | "idToken" | "workspaceId" | "expire"
  >
  accountId?: string
  workspaceId?: string
  planType?: string | null
}

export function mergeCodexLoadedAccountRecords<
  TRecord extends CodexLoadedAccountIdentity,
>(records: readonly TRecord[]): TRecord[] {
  const merged = new Map<string, TRecord>()

  records.forEach((record, index) => {
    const key = getCodexLoadedAccountOverrideKey(record, index)
    if (merged.has(key)) {
      merged.delete(key)
    }
    merged.set(key, record)
  })

  return Array.from(merged.values())
}

export function buildCodexFileSlotRecordFields(
  record: LoadedCodexAccountRecord,
  fallbackBaseUrl: string,
  fallbackProxyUrl: string
): CodexFileSlotRecordFields {
  return {
    label: record.label || record.email || undefined,
    apiKey: record.apiKey || undefined,
    accessToken: record.accessToken || undefined,
    refreshToken: record.refreshToken || undefined,
    accountId: record.accountId || undefined,
    workspaceId: record.workspaceId || undefined,
    email: record.email || undefined,
    planType: normalizeCodexModelTier(record.planType) || undefined,
    baseUrl: record.baseUrl || fallbackBaseUrl,
    proxyUrl: record.proxyUrl || fallbackProxyUrl || undefined,
    configPath: record.configPath,
    persistedMatch: {
      apiKey: record.apiKey || undefined,
      email: record.email || undefined,
      accountId: record.accountId || undefined,
      accessToken: record.accessToken || undefined,
      refreshToken: record.refreshToken || undefined,
    },
  }
}

export function applyCodexFileSlotRecordMetadata(
  target: CodexFileSlotMetadataTarget,
  fields: CodexFileSlotRecordFields
): void {
  target.label = fields.label
  target.apiKey = fields.apiKey
  target.accountId = fields.accountId
  target.workspaceId = fields.workspaceId
  target.email = fields.email
  target.planType = fields.planType
  target.baseUrl = fields.baseUrl
  target.proxyUrl = fields.proxyUrl
  target.configPath = fields.configPath
  target.persistedMatch = fields.persistedMatch
}

export function buildCodexLoadedAccountTokenSeed(
  record: LoadedCodexAccountRecord
): Partial<CodexTokenData> | null {
  if (!record.accessToken && !record.refreshToken && !record.idToken) {
    return null
  }

  return {
    idToken: record.idToken || "",
    accessToken: record.accessToken || "",
    refreshToken: record.refreshToken || "",
    accountId: record.accountId || "",
    workspaceId: record.workspaceId || "",
    email: record.email || "",
    expire: record.expire || "",
  }
}

export function upsertCodexPersistedAccountRecord(
  options: UpsertCodexPersistedAccountRecordOptions
): PersistedCodexAccountRecord[] {
  const accounts = [...options.accounts]
  const { account, tokenData } = options
  const existingIndex = accounts.findIndex((candidate) =>
    isMatchingPersistedCodexAccountRecord(candidate, account)
  )
  const currentRecord = pruneEmptyCodexPersistedAccountRecord({
    ...(existingIndex >= 0 ? accounts[existingIndex] : {}),
    ...(account.label ? { label: account.label } : {}),
    ...(account.apiKey ? { apiKey: account.apiKey } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(account.proxyUrl ? { proxyUrl: account.proxyUrl } : {}),
    accessToken: tokenData.accessToken,
    refreshToken: tokenData.refreshToken,
    idToken: tokenData.idToken,
    accountId: options.accountId || undefined,
    workspaceId: options.workspaceId || tokenData.workspaceId || undefined,
    planType: options.planType || undefined,
    expire: tokenData.expire || undefined,
  })

  if (existingIndex >= 0) {
    accounts[existingIndex] = currentRecord
  } else {
    accounts.push(currentRecord)
  }

  return accounts
}

function isMatchingPersistedCodexAccountRecord(
  candidate: PersistedCodexAccountRecord,
  account: CodexPersistedAccountSlotInput
): boolean {
  if (
    account.persistedMatch?.apiKey &&
    candidate.apiKey === account.persistedMatch.apiKey
  ) {
    return true
  }
  if (
    account.persistedMatch?.refreshToken &&
    candidate.refreshToken === account.persistedMatch.refreshToken
  ) {
    return true
  }
  if (
    account.persistedMatch?.accessToken &&
    candidate.accessToken === account.persistedMatch.accessToken
  ) {
    return true
  }

  const matchEmail = account.persistedMatch?.email || account.email || ""
  const matchAccountId =
    account.persistedMatch?.accountId || account.accountId || ""
  return (
    (candidate.email || "") === matchEmail &&
    (candidate.accountId || "") === matchAccountId
  )
}

function pruneEmptyCodexPersistedAccountRecord(
  record: PersistedCodexAccountRecord
): PersistedCodexAccountRecord {
  const pruned = { ...record }

  Object.keys(pruned).forEach((key) => {
    const typedKey = key as keyof PersistedCodexAccountRecord
    if (!pruned[typedKey]) {
      delete pruned[typedKey]
    }
  })

  return pruned
}

export function getCodexLoadedAccountOverrideKey(
  account: CodexLoadedAccountIdentity,
  index: number
): string {
  const email = account.email?.trim().toLowerCase()
  const accountId = account.accountId?.trim()
  if (email && accountId) {
    return `email:${email}:${accountId}`
  }
  if (email) {
    return `email:${email}`
  }

  const apiKey = account.apiKey?.trim()
  if (apiKey) {
    return `api_key:${apiKey}`
  }

  const refreshToken = account.refreshToken?.trim()
  if (refreshToken) {
    return `refresh_token:${refreshToken}`
  }

  const accessToken = account.accessToken?.trim()
  if (accessToken) {
    return `access_token:${accessToken}`
  }

  if (accountId) {
    return `account_id:${accountId}`
  }

  return `path:${account.configPath}:${index}`
}

export function buildCodexLoadedRecordReloadKey(
  account: CodexLoadedAccountIdentity,
  fallbackBaseUrl: string,
  defaultBaseUrl: string,
  index: number
): string {
  const baseUrl = (account.baseUrl || fallbackBaseUrl).trim() || defaultBaseUrl
  return buildCodexNormalizedReloadKey(
    {
      apiKey: account.apiKey,
      email: account.email,
      accountId: account.accountId,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      baseUrl,
      configPath: account.configPath,
      index,
    },
    defaultBaseUrl
  )
}

export function buildCodexFileSlotReloadKey(
  slot: CodexFileSlotReloadIdentity,
  defaultBaseUrl: string
): string {
  return buildCodexNormalizedReloadKey(
    {
      apiKey: slot.apiKey,
      email: slot.email,
      accountId: slot.accountId,
      refreshToken: slot.refreshToken || slot.tokenData?.refreshToken,
      accessToken: slot.accessToken || slot.tokenData?.accessToken,
      baseUrl: slot.baseUrl,
      configPath: slot.configPath,
      index: 0,
    },
    defaultBaseUrl
  )
}

export function hydrateCodexTokenData(
  tokenData: Partial<CodexTokenData>,
  extractors: CodexTokenHydrationExtractors
): CodexTokenData {
  const idToken = tokenData.idToken?.trim() || ""
  const accessToken = tokenData.accessToken?.trim() || ""

  return {
    idToken,
    accessToken,
    refreshToken: tokenData.refreshToken?.trim() || "",
    accountId:
      tokenData.accountId?.trim() ||
      extractors.getAccountIdFromIdToken(idToken),
    workspaceId:
      tokenData.workspaceId?.trim() ||
      extractors.getWorkspaceIdFromIdToken(idToken),
    email: tokenData.email?.trim() || "",
    expire:
      tokenData.expire?.trim() ||
      inferCodexTokenExpiry([accessToken, idToken], extractors),
  }
}

export function inferCodexTokenExpiry(
  tokens: ReadonlyArray<string | undefined>,
  extractors: Pick<
    CodexTokenHydrationExtractors,
    "getTokenExpiryFromJwt" | "now"
  >
): string {
  for (const token of tokens) {
    if (!token) continue
    const expire = extractors.getTokenExpiryFromJwt(token)
    if (expire) {
      return expire
    }
  }

  return new Date(
    (extractors.now?.() ?? Date.now()) + 3600 * 1000
  ).toISOString()
}
