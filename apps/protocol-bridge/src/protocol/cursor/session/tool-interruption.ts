import type { AbortReason } from "./tool-call-ledger.service"

export type ToolInterruptionReason =
  | "parent_turn_superseded"
  | "stream_aborted"
  | "parent_cancelled"

const TOOL_INTERRUPTION_REASONS = new Set<string>([
  "parent_turn_superseded",
  "stream_aborted",
  "parent_cancelled",
])

export function normalizeToolInterruptionReason(
  value: unknown,
  fallback: ToolInterruptionReason = "stream_aborted"
): ToolInterruptionReason {
  return typeof value === "string" && TOOL_INTERRUPTION_REASONS.has(value)
    ? (value as ToolInterruptionReason)
    : fallback
}

export function isToolInterruptionReason(
  value: unknown
): value is ToolInterruptionReason {
  return typeof value === "string" && TOOL_INTERRUPTION_REASONS.has(value)
}

export function mapToolInterruptionAbortReason(
  reason: ToolInterruptionReason
): AbortReason {
  switch (reason) {
    case "parent_turn_superseded":
      return "turn_superseded"
    case "parent_cancelled":
      return "user_cancelled"
    case "stream_aborted":
      return "stream_failed"
  }
}
