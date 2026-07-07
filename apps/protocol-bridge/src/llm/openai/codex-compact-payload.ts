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
