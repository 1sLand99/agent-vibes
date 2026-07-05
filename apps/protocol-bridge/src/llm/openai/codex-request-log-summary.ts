export type CodexHttpRequestLogKind = "non_stream" | "stream"

export interface CodexHttpRequestLogLineOptions {
  kind: CodexHttpRequestLogKind
  modelName: string
  url: string
  codexRequest: Record<string, unknown>
}

export function buildCodexHttpRequestLogLine(
  options: CodexHttpRequestLogLineOptions
): string {
  const requestLabel = options.kind === "non_stream" ? "Non-stream" : "Stream"
  return (
    `[Codex] ${requestLabel} request: ` +
    `model=${options.modelName}, ` +
    `url=${options.url}, ` +
    `reasoning=${JSON.stringify(options.codexRequest.reasoning ?? null)}, ` +
    `service_tier=${JSON.stringify(options.codexRequest.service_tier ?? null)}`
  )
}

export function summarizeCodexRequestForLogs(
  codexRequest: Record<string, unknown>
): string {
  const inputItems = Array.isArray(codexRequest.input)
    ? (codexRequest.input as Array<Record<string, unknown>>)
    : []
  const inputTypeCounts = new Map<string, number>()
  const callIds: string[] = []

  for (const item of inputItems) {
    const type =
      typeof item?.type === "string" && item.type.trim().length > 0
        ? item.type
        : "unknown"
    inputTypeCounts.set(type, (inputTypeCounts.get(type) || 0) + 1)

    const callId = typeof item?.call_id === "string" ? item.call_id.trim() : ""
    if (callId) {
      callIds.push(callId)
    }
  }

  const inputSummary =
    Array.from(inputTypeCounts.entries())
      .map(([type, count]) => `${type}:${count}`)
      .join(", ") || "none"
  const toolsCount = Array.isArray(codexRequest.tools)
    ? codexRequest.tools.length
    : 0
  const previousResponseId =
    typeof codexRequest.previous_response_id === "string" &&
    codexRequest.previous_response_id.trim().length > 0
      ? codexRequest.previous_response_id.trim()
      : ""
  const sampleCallIds = callIds.length > 0 ? callIds.slice(0, 4).join(",") : "-"

  return (
    `previous_response_id=${previousResponseId || "none"} ` +
    `input_items=${inputItems.length} [${inputSummary}] ` +
    `tools=${toolsCount} ` +
    `call_ids=${sampleCallIds}`
  )
}
