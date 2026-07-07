export type CodexHttpRequestLogKind = "non_stream" | "stream"

type JsonLogValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[]

export interface CodexHttpRequestLogLineOptions {
  kind: CodexHttpRequestLogKind
  modelName: string
  url: string
  codexRequest: Record<string, unknown>
}

function stringifyLogValue(value: JsonLogValue | undefined): string {
  return JSON.stringify(value ?? null)
}

function getStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === "string" ? value : ""
}

function getObjectField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = record[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function buildCodexHttpRequestLogLine(
  options: CodexHttpRequestLogLineOptions
): string {
  const requestLabel = options.kind === "non_stream" ? "Non-stream" : "Stream"
  return (
    `[Codex] ${requestLabel} request: ` +
    `model=${options.modelName}, ` +
    `url=${options.url}, ` +
    `reasoning=${stringifyLogValue(options.codexRequest.reasoning as JsonLogValue)}, ` +
    `service_tier=${stringifyLogValue(options.codexRequest.service_tier as JsonLogValue)}`
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
  const previousResponseId = getStringField(
    codexRequest,
    "previous_response_id"
  ).trim()
  const sampleCallIds = callIds.length > 0 ? callIds.slice(0, 4).join(",") : "-"
  const clientMetadata = getObjectField(codexRequest, "client_metadata")
  const windowId = clientMetadata
    ? getStringField(clientMetadata, "x-codex-window-id").trim()
    : ""

  return (
    `type=${getStringField(codexRequest, "type") || "none"} ` +
    `model=${stringifyLogValue(getStringField(codexRequest, "model") || null)} ` +
    `reasoning=${stringifyLogValue(codexRequest.reasoning as JsonLogValue)} ` +
    `service_tier=${stringifyLogValue(codexRequest.service_tier as JsonLogValue)} ` +
    `include=${stringifyLogValue(codexRequest.include as JsonLogValue)} ` +
    `text=${stringifyLogValue(codexRequest.text as JsonLogValue)} ` +
    `previous_response_id=${previousResponseId || "none"} ` +
    `window_id=${windowId || "none"} ` +
    `input_items=${inputItems.length} [${inputSummary}] ` +
    `tools=${toolsCount} ` +
    `call_ids=${sampleCallIds}`
  )
}

export function summarizeCodexCompletedResponseForLogs(
  event: Record<string, unknown>
): string {
  const response = getObjectField(event, "response") || {}
  const usage =
    getObjectField(response, "usage") || getObjectField(event, "usage")
  const output = Array.isArray(response.output) ? response.output : []

  return (
    `event_type=${getStringField(event, "type") || "none"} ` +
    `response_id=${stringifyLogValue(getStringField(response, "id") || null)} ` +
    `model=${stringifyLogValue(getStringField(response, "model") || null)} ` +
    `status=${stringifyLogValue(getStringField(response, "status") || null)} ` +
    `stop_reason=${stringifyLogValue(getStringField(response, "stop_reason") || null)} ` +
    `output_items=${output.length} ` +
    `usage=${stringifyLogValue(usage as JsonLogValue)}`
  )
}
