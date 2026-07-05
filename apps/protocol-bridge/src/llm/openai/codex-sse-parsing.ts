export interface CodexUsageMetrics {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  webSearchRequests: number
}

export function parseCodexSsePayload(
  line: string
): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return null
  }

  const jsonStr = trimmed.slice(5).trim()
  if (!jsonStr || jsonStr === "[DONE]") {
    return null
  }

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function extractCodexCompletedUsage(
  event: Record<string, unknown> | null
): CodexUsageMetrics | null {
  if (!event || event.type !== "response.completed") {
    return null
  }

  const response =
    event.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>)
      : null
  const usage =
    response?.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : null

  const totalInputTokens = readCodexNumber(usage?.input_tokens)
  const outputTokens = readCodexNumber(usage?.output_tokens)
  const cachedInputTokens =
    usage?.input_tokens_details &&
    typeof usage.input_tokens_details === "object"
      ? readCodexNumber(
          (usage.input_tokens_details as Record<string, unknown>).cached_tokens
        )
      : 0
  const cacheCreationInputTokens =
    typeof usage?.cache_creation_input_tokens === "number"
      ? readCodexNumber(usage.cache_creation_input_tokens)
      : 0
  const webSearchRequests =
    usage?.server_tool_use &&
    typeof usage.server_tool_use === "object" &&
    typeof (usage.server_tool_use as Record<string, unknown>)
      .web_search_requests === "number"
      ? readCodexNumber(
          (usage.server_tool_use as Record<string, unknown>).web_search_requests
        )
      : 0

  return {
    inputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    webSearchRequests,
  }
}

function readCodexNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
