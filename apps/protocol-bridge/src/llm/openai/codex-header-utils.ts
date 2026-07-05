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

interface BuildCodexHttpHeadersParams {
  token: string
  isApiKey: boolean
  stream: boolean
  identity: CodexClientIdentity
  conversationId?: string
  clientMetadata?: CodexForwardHeaders
  accountId?: string
  workspaceId?: string
  forwardHeaders?: CodexForwardHeaders
  omitAccountId?: boolean
  useResponsesLite?: boolean
  includeInstallationIdHeader?: boolean
}

interface BuildCodexWebSocketHeadersParams {
  token: string
  isApiKey: boolean
  identity: CodexClientIdentity
  conversationId?: string
  clientMetadata?: CodexForwardHeaders
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

function ensureCompatibilityHeader(
  target: Record<string, string>,
  forwardHeaders: CodexForwardHeaders | undefined,
  clientMetadata: CodexForwardHeaders | undefined,
  key: string,
  aliases: string[] = []
): void {
  const sourceValue =
    getForwardHeader(forwardHeaders, key, ...aliases) ||
    getForwardHeader(clientMetadata, key, ...aliases)
  if (sourceValue) {
    target[key] = sourceValue
    return
  }

  if (getExistingHeader(target, key, ...aliases)) {
    return
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

function resolveCodexIdentityHeaders(
  forwardHeaders: CodexForwardHeaders | undefined,
  clientMetadata: CodexForwardHeaders | undefined,
  defaultConversationId: string
): { sessionId: string; threadId: string } {
  const sessionId =
    getForwardHeader(forwardHeaders, "session-id", "session_id") ||
    getForwardHeader(clientMetadata, "session_id", "session-id") ||
    defaultConversationId.trim()
  const threadId =
    getForwardHeader(forwardHeaders, "thread-id", "thread_id") ||
    getForwardHeader(clientMetadata, "thread_id", "thread-id") ||
    sessionId

  return {
    sessionId,
    threadId,
  }
}

function ensureCodexSessionHeaders(
  target: Record<string, string>,
  identity: { sessionId: string; threadId: string }
): void {
  if (!getExistingHeader(target, "session-id")) {
    const sessionId = identity.sessionId.trim()
    if (sessionId) {
      target["session-id"] = sessionId
    }
  }
  if (!getExistingHeader(target, "thread-id")) {
    const threadId = identity.threadId.trim()
    if (threadId) {
      target["thread-id"] = threadId
    }
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

export function buildCodexHttpHeaders(
  params: BuildCodexHttpHeadersParams
): Record<string, string> {
  const normalizedConversationId = params.conversationId?.trim() || ""
  const codexIdentity = resolveCodexIdentityHeaders(
    params.forwardHeaders,
    params.clientMetadata,
    normalizedConversationId
  )
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
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-codex-window-id"
  )
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-codex-turn-metadata",
    ["X-Codex-Turn-Metadata"]
  )
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-codex-parent-thread-id"
  )
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-openai-subagent"
  )
  if (params.includeInstallationIdHeader) {
    ensureCompatibilityHeader(
      headers,
      params.forwardHeaders,
      params.clientMetadata,
      "x-codex-installation-id"
    )
  }
  ensureHeader(
    headers,
    params.forwardHeaders,
    "X-Client-Request-Id",
    codexIdentity.threadId || normalizedConversationId,
    ["x-client-request-id"]
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "User-Agent",
    params.identity.userAgent,
    ["user-agent"]
  )
  ensureCodexSessionHeaders(headers, codexIdentity)

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

export function buildCodexWebSocketHeaders(
  params: BuildCodexWebSocketHeadersParams
): Record<string, string> {
  const normalizedConversationId = params.conversationId?.trim() || ""
  const codexIdentity = resolveCodexIdentityHeaders(
    params.forwardHeaders,
    params.clientMetadata,
    normalizedConversationId
  )
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
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-codex-window-id"
  )
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-codex-turn-metadata"
  )
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-codex-parent-thread-id"
  )
  ensureCompatibilityHeader(
    headers,
    params.forwardHeaders,
    params.clientMetadata,
    "x-openai-subagent"
  )
  ensureHeader(
    headers,
    params.forwardHeaders,
    "x-client-request-id",
    codexIdentity.threadId || normalizedConversationId,
    ["x-client-request-id"]
  )
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

  ensureCodexSessionHeaders(headers, codexIdentity)

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
  const turnState = options.turnState?.trim()
  if (turnState) {
    websocketMetadata[CODEX_TURN_STATE_HEADER] = turnState
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
