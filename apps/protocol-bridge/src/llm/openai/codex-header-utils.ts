import {
  assertCodexProviderIdentity,
  type CodexProviderIdentity,
  type CodexSubagentProviderIdentity,
} from "./codex-provider-identity"
import {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "../../context/durable-identifier"

export type CodexForwardHeaders = Record<string, string>

/**
 * Identity values mirroring what the upstream openai/codex CLI sends. Use
 * `CodexClientIdentityService` to resolve a fresh instance at boot and pass
 * it to the header builders below — there is no module-level fallback here
 * by design, so missing wiring fails loudly at the type checker rather than
 * silently spoofing a stale version.
 */
export interface CodexClientIdentity {
  /** Sent in the `version` header (and `Version` alias). */
  version: string
  /** Full User-Agent string. */
  userAgent: string
  /** Codex originator identity sent in the `originator` header. */
  originator: string
}

export const CODEX_DEFAULT_ORIGINATOR = "codex_cli_rs"
export const CODEX_WS_BETA_HEADER = "responses_websockets=2026-02-06"
export const CODEX_RESPONSES_LITE_HEADER =
  "x-openai-internal-codex-responses-lite"
export const CODEX_RESPONSES_LITE_WS_METADATA_KEY =
  "ws_request_header_x_openai_internal_codex_responses_lite"
export const CODEX_WS_TRACEPARENT_METADATA_KEY = "ws_request_header_traceparent"
export const CODEX_WS_TRACESTATE_METADATA_KEY = "ws_request_header_tracestate"
export const CODEX_WS_STREAM_REQUEST_START_MS_METADATA_KEY =
  "x-codex-ws-stream-request-start-ms"
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state"

/**
 * Requests that do not create or continue an upstream Codex turn. Keep their
 * header shape separate so they cannot become a way around the typed
 * bridge-native transport scope below.
 */
interface BuildCodexNonTurnHttpHeadersParams {
  token: string
  isApiKey: boolean
  identity: CodexClientIdentity
  accountId?: string
  workspaceId?: string
  accept: "application/json" | "text/event-stream"
}

/**
 * Bridge-native transport scope. Local continuation state and the upstream
 * Responses identity are both required, so no header can silently promote a
 * local projection key into a Codex session or thread id.
 */
export interface CodexBridgeNativeTransportScope {
  localProjectionKey: string
  upstreamIdentity: CodexProviderIdentity
  clientMetadata: CodexForwardHeaders
}

export interface BuildCodexBridgeNativeHttpHeadersParams extends CodexBridgeNativeTransportScope {
  token: string
  isApiKey: boolean
  stream: boolean
  identity: CodexClientIdentity
  accountId?: string
  workspaceId?: string
  forwardHeaders?: CodexForwardHeaders
  omitAccountId?: boolean
  useResponsesLite?: boolean
  includeInstallationIdHeader?: boolean
}

export interface BuildCodexBridgeNativeWebSocketHeadersParams extends CodexBridgeNativeTransportScope {
  token: string
  isApiKey: boolean
  identity: CodexClientIdentity
  accountId?: string
  workspaceId?: string
  forwardHeaders?: CodexForwardHeaders
  omitAccountId?: boolean
  useResponsesLite?: boolean
}

function normalizeHeaderKey(key: string): string {
  return key.trim().toLowerCase()
}

function getForwardHeader(
  headers: CodexForwardHeaders | undefined,
  ...keys: string[]
): string {
  if (!headers) {
    return ""
  }

  const normalizedEntries: Array<[string, string]> = Object.entries(
    headers
  ).map(([key, value]) => [normalizeHeaderKey(key), value])

  for (const key of keys) {
    const normalizedKey = normalizeHeaderKey(key)
    const match = normalizedEntries.find(
      ([candidateKey]) => candidateKey === normalizedKey
    )
    if (match && match[1].trim() !== "") {
      return match[1].trim()
    }
  }

  return ""
}

function getExistingHeader(
  headers: Record<string, string>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const normalizedKey = normalizeHeaderKey(key)
    for (const [candidateKey, candidateValue] of Object.entries(headers)) {
      if (
        normalizeHeaderKey(candidateKey) === normalizedKey &&
        candidateValue.trim() !== ""
      ) {
        return candidateValue.trim()
      }
    }
  }

  return ""
}

function ensureHeader(
  target: Record<string, string>,
  source: CodexForwardHeaders | undefined,
  key: string,
  defaultValue: string,
  aliases: string[] = []
): void {
  const sourceValue = getForwardHeader(source, key, ...aliases)
  if (sourceValue) {
    target[key] = sourceValue
    return
  }

  if (getExistingHeader(target, key, ...aliases)) {
    return
  }

  const trimmedDefault = defaultValue.trim()
  if (trimmedDefault) {
    target[key] = trimmedDefault
  }
}

function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => typeof value === "string" && value.trim() !== ""
    )
  )
}

function assertBridgeNativeTransportScope(
  scope: CodexBridgeNativeTransportScope
): void {
  requireExactDurableIdentifier(
    scope.localProjectionKey,
    "Codex bridge-native localProjectionKey"
  )
  assertCodexProviderIdentity(scope.upstreamIdentity)

  const metadataSessionId = requireExactDurableIdentifier(
    scope.clientMetadata.session_id,
    "Codex client_metadata session_id"
  )
  const metadataThreadId = requireExactDurableIdentifier(
    scope.clientMetadata.thread_id,
    "Codex client_metadata thread_id"
  )
  const metadataTurnId = requireExactDurableIdentifier(
    scope.clientMetadata.turn_id,
    "Codex client_metadata turn_id"
  )
  const metadataWindowId = requireExactDurableIdentifier(
    scope.clientMetadata["x-codex-window-id"],
    "Codex client_metadata x-codex-window-id"
  )
  const turnMetadata = requireExactDurableIdentifier(
    scope.clientMetadata["x-codex-turn-metadata"],
    "Codex client_metadata x-codex-turn-metadata"
  )
  requireExactDurableIdentifier(
    scope.clientMetadata["x-codex-installation-id"],
    "Codex client_metadata x-codex-installation-id"
  )
  if (
    metadataSessionId !== scope.upstreamIdentity.sessionId ||
    metadataThreadId !== scope.upstreamIdentity.threadId
  ) {
    throw new Error(
      "Codex bridge-native client metadata does not match upstream identity"
    )
  }

  let parsedTurnMetadata: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(turnMetadata)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object")
    }
    parsedTurnMetadata = parsed as Record<string, unknown>
  } catch {
    throw new Error(
      "Codex bridge-native client metadata must contain valid turn metadata"
    )
  }
  if (
    parsedTurnMetadata.session_id !== scope.upstreamIdentity.sessionId ||
    parsedTurnMetadata.thread_id !== scope.upstreamIdentity.threadId ||
    parsedTurnMetadata.thread_source !== scope.upstreamIdentity.threadSource ||
    parsedTurnMetadata.turn_id !== metadataTurnId ||
    parsedTurnMetadata.window_id !== metadataWindowId
  ) {
    throw new Error(
      "Codex bridge-native turn metadata does not match upstream identity"
    )
  }

  if (isSubagentIdentity(scope.upstreamIdentity)) {
    const parentThreadId = requireExactDurableIdentifier(
      scope.clientMetadata["x-codex-parent-thread-id"],
      "Codex client_metadata x-codex-parent-thread-id"
    )
    const subagentHeader = requireExactDurableIdentifier(
      scope.clientMetadata["x-openai-subagent"],
      "Codex client_metadata x-openai-subagent"
    )
    if (
      parentThreadId !== scope.upstreamIdentity.parentThreadId ||
      subagentHeader !== scope.upstreamIdentity.subagentHeader ||
      parsedTurnMetadata.parent_thread_id !==
        scope.upstreamIdentity.parentThreadId ||
      parsedTurnMetadata.subagent_kind !== scope.upstreamIdentity.subagentKind
    ) {
      throw new Error(
        "Codex bridge-native subagent metadata does not match upstream identity"
      )
    }
    return
  }

  if (
    requireOptionalExactDurableIdentifier(
      scope.clientMetadata["x-codex-parent-thread-id"],
      "Codex client_metadata x-codex-parent-thread-id"
    ) !== undefined ||
    requireOptionalExactDurableIdentifier(
      scope.clientMetadata["x-openai-subagent"],
      "Codex client_metadata x-openai-subagent"
    ) !== undefined ||
    parsedTurnMetadata.parent_thread_id !== undefined ||
    parsedTurnMetadata.subagent_kind !== undefined
  ) {
    throw new Error(
      "Codex bridge-native root metadata cannot declare a subagent lineage"
    )
  }
}

function isSubagentIdentity(
  identity: CodexProviderIdentity
): identity is CodexSubagentProviderIdentity {
  return identity.threadSource === "subagent"
}

function installBridgeNativeIdentityHeaders(
  target: Record<string, string>,
  identity: CodexProviderIdentity
): void {
  target["session-id"] = identity.sessionId
  target["thread-id"] = identity.threadId
  target["x-client-request-id"] = identity.threadId
  if (isSubagentIdentity(identity)) {
    target["x-codex-parent-thread-id"] = identity.parentThreadId
    target["x-openai-subagent"] = identity.subagentHeader
  }
}

function installBridgeNativeMetadataHeaders(
  target: Record<string, string>,
  clientMetadata: CodexForwardHeaders,
  options: { includeInstallationIdHeader: boolean }
): void {
  for (const header of [
    "x-codex-window-id",
    "x-codex-turn-metadata",
  ] as const) {
    target[header] = requireExactDurableIdentifier(
      clientMetadata[header],
      `Codex client_metadata ${header}`
    )
  }
  if (options.includeInstallationIdHeader) {
    const installationId = requireExactDurableIdentifier(
      clientMetadata["x-codex-installation-id"],
      "Codex client_metadata x-codex-installation-id"
    )
    target["x-codex-installation-id"] = installationId
  }
}

function ensureCodexOriginatorHeader(
  target: Record<string, string>,
  forwardHeaders: CodexForwardHeaders | undefined,
  identityOriginator: string
): void {
  if (getExistingHeader(target, "Originator", "originator")) {
    return
  }

  const originator =
    getForwardHeader(forwardHeaders, "Originator", "originator") ||
    identityOriginator
  const normalizedOriginator = originator.trim()
  if (normalizedOriginator) {
    target.originator = normalizedOriginator
  }
}

export function buildCodexNonTurnHttpHeaders(
  params: BuildCodexNonTurnHttpHeadersParams
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${params.token}`,
    Accept: params.accept,
    Connection: "Keep-Alive",
  }

  ensureHeader(headers, undefined, "version", params.identity.version, [
    "Version",
  ])
  ensureHeader(headers, undefined, "User-Agent", params.identity.userAgent, [
    "user-agent",
  ])

  if (!params.isApiKey) {
    ensureCodexOriginatorHeader(headers, undefined, params.identity.originator)
    const accountId = params.accountId?.trim() || ""
    if (accountId) {
      headers["Chatgpt-Account-Id"] = accountId
    }
    const workspaceId = params.workspaceId?.trim() || ""
    if (workspaceId) {
      headers["OpenAI-Organization"] = workspaceId
    }
  }

  return sanitizeHeaders(headers)
}

/**
 * Header builder for requests assembled by the bridge's native Codex path.
 * It never consults forward headers or client metadata for identity values:
 * `localProjectionKey` remains local, while session/thread/request ids are
 * emitted only from the typed upstream identity.
 */
export function buildCodexBridgeNativeHttpHeaders(
  params: BuildCodexBridgeNativeHttpHeadersParams
): Record<string, string> {
  assertBridgeNativeTransportScope(params)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${params.token}`,
    Accept: params.stream ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive",
  }

  const betaFeatures = getForwardHeader(
    params.forwardHeaders,
    "x-codex-beta-features"
  )
  if (betaFeatures) {
    headers["X-Codex-Beta-Features"] = betaFeatures
  }
  if (params.useResponsesLite) {
    headers[CODEX_RESPONSES_LITE_HEADER] = "true"
  }

  ensureHeader(
    headers,
    params.forwardHeaders,
    "version",
    params.identity.version,
    ["Version"]
  )
  installBridgeNativeMetadataHeaders(headers, params.clientMetadata, {
    includeInstallationIdHeader: params.includeInstallationIdHeader === true,
  })
  ensureHeader(
    headers,
    params.forwardHeaders,
    "User-Agent",
    params.identity.userAgent,
    ["user-agent"]
  )
  installBridgeNativeIdentityHeaders(headers, params.upstreamIdentity)

  if (!params.isApiKey) {
    ensureCodexOriginatorHeader(
      headers,
      params.forwardHeaders,
      params.identity.originator
    )
    const accountId = params.omitAccountId ? "" : params.accountId?.trim() || ""
    if (accountId) {
      headers["Chatgpt-Account-Id"] = accountId
    }
    const workspaceId = params.workspaceId?.trim() || ""
    if (workspaceId) {
      headers["OpenAI-Organization"] = workspaceId
    }
  }

  return sanitizeHeaders(headers)
}

/**
 * WebSocket equivalent of `buildCodexBridgeNativeHttpHeaders`. The physical
 * socket remains keyed by the local projection scope, but all upstream
 * identity headers are written from the typed native identity.
 */
export function buildCodexBridgeNativeWebSocketHeaders(
  params: BuildCodexBridgeNativeWebSocketHeadersParams
): Record<string, string> {
  assertBridgeNativeTransportScope(params)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.token}`,
  }

  const betaFeatures = getForwardHeader(
    params.forwardHeaders,
    "x-codex-beta-features"
  )
  if (betaFeatures) {
    headers["x-codex-beta-features"] = betaFeatures
  }
  ensureHeader(headers, params.forwardHeaders, "x-codex-turn-state", "", [
    "x-codex-turn-state",
  ])
  installBridgeNativeMetadataHeaders(headers, params.clientMetadata, {
    includeInstallationIdHeader: false,
  })
  ensureHeader(
    headers,
    params.forwardHeaders,
    "x-responsesapi-include-timing-metrics",
    "",
    ["x-responsesapi-include-timing-metrics"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "version",
    params.identity.version,
    ["Version"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "User-Agent",
    params.identity.userAgent,
    ["user-agent"]
  )

  const openAiBeta = getForwardHeader(params.forwardHeaders, "openai-beta")
  headers["OpenAI-Beta"] =
    openAiBeta && openAiBeta.includes("responses_websockets=")
      ? openAiBeta
      : CODEX_WS_BETA_HEADER
  installBridgeNativeIdentityHeaders(headers, params.upstreamIdentity)

  if (!params.isApiKey) {
    ensureCodexOriginatorHeader(
      headers,
      params.forwardHeaders,
      params.identity.originator
    )
    const accountId = params.omitAccountId ? "" : params.accountId?.trim() || ""
    if (accountId) {
      headers["Chatgpt-Account-Id"] = accountId
    }
    const workspaceId = params.workspaceId?.trim() || ""
    if (workspaceId) {
      headers["OpenAI-Organization"] = workspaceId
    }
  }

  return sanitizeHeaders(headers)
}

export function buildCodexWebSocketRequestBody(
  body: Record<string, unknown>,
  options: {
    useResponsesLite?: boolean
    warmup?: boolean
    forwardHeaders?: CodexForwardHeaders
    streamRequestStartMs?: number
    turnState?: string
  } = {}
): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    ...body,
    type: "response.create",
  }
  if (options.warmup) {
    requestBody.generate = false
  }

  const existingMetadata =
    requestBody.client_metadata &&
    typeof requestBody.client_metadata === "object" &&
    !Array.isArray(requestBody.client_metadata)
      ? (requestBody.client_metadata as Record<string, unknown>)
      : {}

  const websocketMetadata: Record<string, string> = {}
  if (options.useResponsesLite) {
    websocketMetadata[CODEX_RESPONSES_LITE_WS_METADATA_KEY] = "true"
  }
  if (typeof options.streamRequestStartMs === "number") {
    websocketMetadata[CODEX_WS_STREAM_REQUEST_START_MS_METADATA_KEY] = String(
      Math.trunc(options.streamRequestStartMs)
    )
  }
  if (options.turnState !== undefined) {
    websocketMetadata[CODEX_TURN_STATE_HEADER] = requireExactDurableIdentifier(
      options.turnState,
      "Codex turn state"
    )
  }

  const traceparent = getForwardHeader(options.forwardHeaders, "traceparent")
  if (traceparent) {
    websocketMetadata[CODEX_WS_TRACEPARENT_METADATA_KEY] = traceparent
  }
  const tracestate = getForwardHeader(options.forwardHeaders, "tracestate")
  if (tracestate) {
    websocketMetadata[CODEX_WS_TRACESTATE_METADATA_KEY] = tracestate
  }

  if (Object.keys(websocketMetadata).length === 0) {
    return requestBody
  }

  return {
    ...requestBody,
    client_metadata: {
      ...existingMetadata,
      ...websocketMetadata,
    },
  }
}
