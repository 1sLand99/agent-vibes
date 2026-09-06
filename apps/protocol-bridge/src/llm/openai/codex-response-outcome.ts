import { CodexApiError } from "./codex-api-error"
import { createCodexApiErrorFromBody } from "./codex-api-error-response"

export interface CodexResponseOutcome {
  status: "completed" | "incomplete"
  responseId: string
  incompleteReason?: "max_output_tokens"
  endTurn?: boolean
  usage?: Record<string, unknown>
  usageMetadata?: Record<string, unknown>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Aggregation requires completion; streams may preserve recoverable truncation. */
export function readCodexResponseOutcome(
  event: Record<string, unknown>,
  options: { allowMaxOutputIncomplete?: boolean } = {}
): CodexResponseOutcome | undefined {
  const response = object(event.response)
  if (event.type === "response.failed") {
    const error = object(response?.error) ?? {
      code: "response_failed",
      message: "Codex response failed",
    }
    const code =
      typeof error.code === "string"
        ? error.code
        : typeof error.type === "string"
          ? error.type
          : "response_failed"
    const status = [
      "rate_limit_exceeded",
      "usage_limit_reached",
      "insufficient_quota",
      "usage_not_included",
    ].includes(code)
      ? 429
      : [
            "context_length_exceeded",
            "invalid_prompt",
            "bio_policy",
            "cyber_policy",
            "misalignment_policy_violation",
          ].includes(code)
        ? 400
        : 502
    throw createCodexApiErrorFromBody(
      status,
      JSON.stringify({ error, response_id: response?.id, event })
    )
  }
  let incompleteReason: "max_output_tokens" | undefined
  if (event.type === "response.incomplete") {
    const value = object(response?.incomplete_details)?.reason
    const reason = typeof value === "string" ? value : "unknown"
    if (reason === "max_output_tokens" && options.allowMaxOutputIncomplete) {
      incompleteReason = reason
    } else {
      throw new CodexApiError(
        502,
        `Codex response incomplete: ${String(reason)}`,
        undefined,
        "response_incomplete",
        {
          event,
          response_id: response?.id,
          incomplete_details: response?.incomplete_details,
          usage: response?.usage,
          usage_metadata: response?.usage_metadata,
        }
      )
    }
  }
  if (event.type !== "response.completed" && !incompleteReason) return undefined
  if (
    typeof response?.id !== "string" ||
    !response.id ||
    response.id.trim() !== response.id
  ) {
    throw new CodexApiError(
      502,
      "Codex terminal response is missing its response id",
      undefined,
      "invalid_response"
    )
  }
  if (
    response.end_turn !== undefined &&
    response.end_turn !== null &&
    typeof response.end_turn !== "boolean"
  ) {
    throw new CodexApiError(
      502,
      "Codex terminal response has an invalid end_turn",
      undefined,
      "invalid_response"
    )
  }
  return {
    status: incompleteReason ? "incomplete" : "completed",
    responseId: response.id,
    ...(incompleteReason ? { incompleteReason } : {}),
    ...(typeof response.end_turn === "boolean"
      ? { endTurn: response.end_turn }
      : {}),
    ...(object(response.usage) ? { usage: object(response.usage)! } : {}),
    ...(object(response.usage_metadata)
      ? { usageMetadata: object(response.usage_metadata)! }
      : {}),
  }
}
