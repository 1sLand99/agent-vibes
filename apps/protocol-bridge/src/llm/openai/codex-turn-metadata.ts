export interface CodexTurnStateCarrier {
  turnState: string | undefined
}

const CODEX_TURN_STATE_HEADER = "x-codex-turn-state"

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
  if (
    !carrier ||
    !normalizedTurnState ||
    carrier.turnState === normalizedTurnState
  ) {
    return false
  }
  carrier.turnState = normalizedTurnState
  return true
}
