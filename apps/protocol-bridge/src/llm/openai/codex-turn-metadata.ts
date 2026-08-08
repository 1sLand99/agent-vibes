import { requireExactDurableIdentifier } from "../../context/durable-identifier"
import {
  assertCodexProviderIdentity,
  type CodexProviderIdentity,
  type CodexSubagentProviderIdentity,
} from "./codex-provider-identity"

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
  identity: CodexProviderIdentity
  turnId: string
  windowId: string
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
): Record<string, string> {
  assertCodexProviderIdentity(input.identity)

  const sessionId = input.identity.sessionId
  const threadId = input.identity.threadId
  const turnId = requireExactDurableIdentifier(
    input.turnId,
    "Codex turn metadata turnId"
  )
  const windowId = requireExactDurableIdentifier(
    input.windowId,
    "Codex turn metadata windowId"
  )
  const requestKind = input.requestKind === "compaction" ? "compaction" : "turn"
  const installationId = requireExactDurableIdentifier(
    input.installationId,
    "Codex installationId"
  )
  const turnMetadata: Record<string, unknown> = {
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: requestKind,
    thread_source: input.identity.threadSource,
    sandbox: "none",
  }

  if (isCodexSubagentIdentity(input.identity)) {
    turnMetadata.parent_thread_id = input.identity.parentThreadId
    turnMetadata.subagent_kind = input.identity.subagentKind
  }

  const startedAt = input.turnStartedAtUnixMs
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    turnMetadata.turn_started_at_unix_ms = Math.trunc(startedAt)
  }

  if (requestKind === "compaction" && input.compaction) {
    turnMetadata.compaction = input.compaction
  }

  const rootPath =
    typeof input.workspaceRootPath === "string" &&
    input.workspaceRootPath.length > 0 &&
    !input.workspaceRootPath.includes("\u0000")
      ? input.workspaceRootPath
      : undefined
  if (rootPath) {
    turnMetadata.workspaces = {
      [rootPath]: {},
    }
  }

  const metadata: Record<string, string> = {
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    "x-codex-window-id": windowId,
    "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    "x-codex-installation-id": installationId,
  }
  if (isCodexSubagentIdentity(input.identity)) {
    metadata["x-codex-parent-thread-id"] = input.identity.parentThreadId
    metadata["x-openai-subagent"] = input.identity.subagentHeader
  }
  return metadata
}

function isCodexSubagentIdentity(
  identity: CodexProviderIdentity
): identity is CodexSubagentProviderIdentity {
  return identity.threadSource === "subagent"
}

export function extractCodexTurnKey(
  codexRequest: Record<string, unknown>
): string {
  const metadata = codexRequest.client_metadata
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Codex request requires canonical client_metadata")
  }

  const record = metadata as Record<string, unknown>
  const rawTurnMetadata = requireExactDurableIdentifier(
    record["x-codex-turn-metadata"],
    "Codex x-codex-turn-metadata"
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(rawTurnMetadata)
  } catch (error) {
    throw new Error(
      `Codex x-codex-turn-metadata must be valid JSON: ${String(error)}`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex x-codex-turn-metadata must be a JSON object")
  }
  const turnMetadata = parsed as Record<string, unknown>
  const turnId = requireExactDurableIdentifier(
    turnMetadata.turn_id,
    "Codex x-codex-turn-metadata turn_id"
  )
  const flatTurnId = requireExactDurableIdentifier(
    record.turn_id,
    "Codex client_metadata turn_id"
  )
  if (flatTurnId !== turnId) {
    throw new Error(
      "Codex client_metadata turn_id does not match x-codex-turn-metadata"
    )
  }
  const windowId = requireExactDurableIdentifier(
    turnMetadata.window_id,
    "Codex x-codex-turn-metadata window_id"
  )
  const flatWindowId = requireExactDurableIdentifier(
    record["x-codex-window-id"],
    "Codex client_metadata x-codex-window-id"
  )
  if (flatWindowId !== windowId) {
    throw new Error(
      "Codex client_metadata x-codex-window-id does not match x-codex-turn-metadata"
    )
  }
  return turnId
}

export function applyCodexTurnStateHeader(
  headers: Record<string, string>,
  turnState: string | undefined
): boolean {
  if (turnState === undefined) {
    return false
  }
  headers[CODEX_TURN_STATE_HEADER] = requireExactDurableIdentifier(
    turnState,
    "Codex turn state"
  )
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
    return value === null
      ? undefined
      : requireExactDurableIdentifier(value, "Codex turn state header")
  }

  let turnState: string | undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== CODEX_TURN_STATE_HEADER) {
      continue
    }
    if (turnState !== undefined) {
      throw new Error("Codex response contains duplicate turn state headers")
    }
    turnState = requireExactDurableIdentifier(value, "Codex turn state header")
  }

  return turnState
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
  if (turnState === undefined) {
    return false
  }
  const exactTurnState = requireExactDurableIdentifier(
    turnState,
    "Codex turn state"
  )
  if (!carrier || carrier.turnState !== undefined) {
    return false
  }
  carrier.turnState = exactTurnState
  return true
}
