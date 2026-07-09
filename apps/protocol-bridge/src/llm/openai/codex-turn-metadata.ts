import { normalizeCodexPromptCacheKey } from "./codex-prompt-cache-key"

export interface CodexTurnStateCarrier {
  turnState: string | undefined
}

export type CodexResponsesRequestKind = "turn" | "compaction"

export type CodexCompactionTrigger = "manual" | "auto"
export type CodexCompactionReason =
  | "user_requested"
  | "context_limit"
  | "model_downshift"
  | "comp_hash_changed"
export type CodexCompactionImplementation =
  | "responses"
  | "responses_compaction_v2"
  | "responses_compact"
export type CodexCompactionPhase = "standalone_turn" | "pre_turn" | "mid_turn"
export type CodexCompactionStrategy = "memento" | "prefix_compaction"

export interface CodexTurnCompactionMetadata {
  trigger: CodexCompactionTrigger
  reason: CodexCompactionReason
  implementation: CodexCompactionImplementation
  phase: CodexCompactionPhase
  strategy: CodexCompactionStrategy
}

export interface CodexClientMetadataInput {
  conversationId?: string
  requestOrdinal?: number
  turnId?: string
  windowId?: string
  requestKind?: CodexResponsesRequestKind
  installationId: string
  workspaceRootPath?: string
  turnStartedAtUnixMs?: number
  compaction?: CodexTurnCompactionMetadata
}

export interface CodexCompactionMetadataInput {
  strategy?: "auto" | "manual" | "reactive"
  injectionMode?: "pre_turn" | "mid_turn"
}

const CODEX_TURN_STATE_HEADER = "x-codex-turn-state"

export function buildCodexCompactionMetadata(
  input: CodexCompactionMetadataInput = {}
): CodexTurnCompactionMetadata {
  const isManual = input.strategy === "manual"
  return {
    trigger: isManual ? "manual" : "auto",
    reason: isManual ? "user_requested" : "context_limit",
    implementation: "responses_compact",
    phase: input.injectionMode === "mid_turn" ? "mid_turn" : "pre_turn",
    strategy: "memento",
  }
}

export function buildCodexClientMetadata(
  input: CodexClientMetadataInput
): Record<string, string> | undefined {
  const conversationId = input.conversationId?.trim()
  if (!conversationId) {
    return undefined
  }

  const requestOrdinal = Math.max(1, Math.floor(input.requestOrdinal || 1))
  const sessionId = normalizeCodexPromptCacheKey(conversationId)
  const threadId = sessionId
  const turnId = normalizeCodexPromptCacheKey(
    input.turnId?.trim() || `${sessionId}:${requestOrdinal}`
  )
  const windowId = normalizeCodexPromptCacheKey(
    input.windowId?.trim() || `${threadId}:0`
  )
  const requestKind = input.requestKind === "compaction" ? "compaction" : "turn"
  const installationId = input.installationId.trim()
  const turnMetadata: Record<string, unknown> = {
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: requestKind,
    thread_source: "user",
    sandbox: "none",
  }

  const startedAt = input.turnStartedAtUnixMs
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    turnMetadata.turn_started_at_unix_ms = Math.trunc(startedAt)
  }

  if (requestKind === "compaction" && input.compaction) {
    turnMetadata.compaction = input.compaction
  }

  const rootPath = input.workspaceRootPath?.trim()
  if (rootPath) {
    turnMetadata.workspaces = {
      [rootPath]: {},
    }
  }

  return {
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    "x-codex-window-id": windowId,
    "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    "x-codex-installation-id": installationId,
  }
}

export function extractCodexTurnKey(
  codexRequest: Record<string, unknown>
): string {
  const metadata = codexRequest.client_metadata
  if (!metadata || typeof metadata !== "object") {
    return ""
  }

  const record = metadata as Record<string, unknown>
  const rawTurnMetadata = record["x-codex-turn-metadata"]
  if (typeof rawTurnMetadata === "string" && rawTurnMetadata.trim()) {
    const trimmedTurnMetadata = rawTurnMetadata.trim()
    try {
      const parsed = JSON.parse(trimmedTurnMetadata) as Record<string, unknown>
      const turnId = parsed?.turn_id
      if (typeof turnId === "string" && turnId.trim()) {
        return turnId.trim()
      }
    } catch {
      return trimmedTurnMetadata
    }
    return trimmedTurnMetadata
  }

  const windowId = record["x-codex-window-id"]
  return typeof windowId === "string" ? windowId.trim() : ""
}

export function applyCodexTurnStateHeader(
  headers: Record<string, string>,
  turnState: string | undefined
): boolean {
  const normalizedTurnState = turnState?.trim()
  if (!normalizedTurnState) {
    return false
  }
  headers[CODEX_TURN_STATE_HEADER] = normalizedTurnState
  return true
}

export function readCodexTurnStateFromHeaders(
  headers: Pick<Headers, "get"> | Record<string, unknown> | null | undefined
): string | undefined {
  if (!headers) {
    return undefined
  }

  if (typeof (headers as Pick<Headers, "get">).get === "function") {
    const value = (headers as Pick<Headers, "get">).get(CODEX_TURN_STATE_HEADER)
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() !== CODEX_TURN_STATE_HEADER) {
      continue
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }

  return undefined
}

export function extractCodexTurnStateFromMetadataEvent(
  event: Record<string, unknown> | null | undefined
): string | undefined {
  if (!event || event.type !== "response.metadata") {
    return undefined
  }

  const headers = event.headers
  return headers && typeof headers === "object" && !Array.isArray(headers)
    ? readCodexTurnStateFromHeaders(headers as Record<string, unknown>)
    : undefined
}

export function captureCodexTurnState(
  carrier: CodexTurnStateCarrier | undefined,
  turnState: string | undefined
): boolean {
  const normalizedTurnState = turnState?.trim()
  if (!carrier || !normalizedTurnState || carrier.turnState) {
    return false
  }
  carrier.turnState = normalizedTurnState
  return true
}
