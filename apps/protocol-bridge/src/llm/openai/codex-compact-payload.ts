import type { CodexReplacementHistoryItem } from "../../context"
import { CodexApiError } from "./codex-api-error"
import type { CodexRequest } from "./codex-native-types"

export type CodexCompactRequestPayload = Pick<
  CodexRequest,
  | "model"
  | "input"
  | "instructions"
  | "reasoning"
  | "service_tier"
  | "prompt_cache_key"
  | "text"
> & {
  tools: NonNullable<CodexRequest["tools"]>
  parallel_tool_calls: boolean
}

export function buildCodexCompactRequestPayload(
  codexRequest: Pick<
    CodexRequest,
    | "model"
    | "input"
    | "instructions"
    | "tools"
    | "parallel_tool_calls"
    | "reasoning"
    | "service_tier"
    | "prompt_cache_key"
    | "text"
  >
): CodexCompactRequestPayload {
  const input = Array.isArray(codexRequest.input) ? codexRequest.input : []
  if (input.length === 0) {
    throw new CodexApiError(
      500,
      "Codex compact request did not include input history."
    )
  }

  return {
    model: codexRequest.model,
    input: [...input, { type: "compaction_trigger" }],
    instructions: codexRequest.instructions,
    tools: codexRequest.tools || [],
    parallel_tool_calls: codexRequest.parallel_tool_calls !== false,
    reasoning: codexRequest.reasoning,
    service_tier: codexRequest.service_tier,
    prompt_cache_key: codexRequest.prompt_cache_key,
    text: codexRequest.text,
  }
}

export function parseCodexCompactOutputHistory(
  body: unknown
): CodexReplacementHistoryItem[] {
  const output =
    body && typeof body === "object"
      ? (body as { output?: unknown }).output
      : undefined

  if (!Array.isArray(output)) {
    throw new CodexApiError(
      502,
      "Codex compact response did not include output history."
    )
  }

  return output.flatMap((item) =>
    item && typeof item === "object"
      ? [{ ...(item as Record<string, unknown>) }]
      : []
  )
}

export function summarizeCodexCompactResponseForLogs(body: unknown): string {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  const output = Array.isArray(record.output)
    ? (record.output as unknown[])
    : []
  const typeCounts = new Map<string, number>()

  for (const item of output) {
    const itemRecord =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {}
    const type =
      typeof itemRecord.type === "string" && itemRecord.type.trim().length > 0
        ? itemRecord.type.trim()
        : "unknown"
    const role =
      typeof itemRecord.role === "string" && itemRecord.role.trim().length > 0
        ? itemRecord.role.trim()
        : "none"
    const key = `${type}:${role}`
    typeCounts.set(key, (typeCounts.get(key) || 0) + 1)
  }

  const outputSummary =
    Array.from(typeCounts.entries())
      .map(([type, count]) => `${type}:${count}`)
      .join(", ") || "none"
  const bodyKeys = Object.keys(record).slice(0, 12).join(",") || "none"

  return `output_items=${output.length} [${outputSummary}] body_keys=${bodyKeys}`
}
