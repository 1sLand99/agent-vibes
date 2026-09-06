import { getCodexModelProfile } from "../llm/openai/codex-model-catalog"
export interface ContextAutoCompactInput {
  backend: string
  model?: string
  maxTokens: number
  maxOutputTokens?: number
  requestedServiceTier?: string
}

const COMPACT_SUMMARY_OUTPUT_RESERVE_TOKENS = 20_000
const DEFAULT_TURN_OUTPUT_RESERVE_TOKENS = 8_192
// Reserve enough room for the synchronous pre-request compact transaction and
// the next provider turn. Compaction is never speculated from stale history.
const BASE_AUTOCOMPACT_BUFFER_TOKENS = 13_000
const MEDIUM_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS = 30_000
const LARGE_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS = 50_000
const TOOL_RESULT_TURN_GROWTH_ESTIMATE_TOKENS = 15_000

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/**
 * Returns an automatic compaction trigger, not a smaller context window.
 *
 * Codex core derives the default auto-compaction limit from context_window at
 * 90%. Claude Code reserves room for compact output plus turn growth before
 * the next model call. The bridge mirrors those trigger shapes while still
 * keeping the hard request budget unchanged.
 */
export function resolveAutoCompactTokenLimit(
  input: ContextAutoCompactInput
): number | undefined {
  const maxTokens = normalizePositiveInteger(input.maxTokens)
  if (!maxTokens) {
    return undefined
  }

  if (input.backend === "codex") {
    const configured = input.model
      ? normalizePositiveInteger(
          getCodexModelProfile(input.model)?.auto_compact_token_limit
        )
      : undefined
    return Math.min(configured ?? Infinity, Math.floor(maxTokens * 0.9))
  }

  const outputReserve = Math.min(
    normalizePositiveInteger(input.maxOutputTokens) ??
      DEFAULT_TURN_OUTPUT_RESERVE_TOKENS,
    COMPACT_SUMMARY_OUTPUT_RESERVE_TOKENS
  )
  const buffer =
    maxTokens >= 800_000
      ? LARGE_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS
      : maxTokens >= 400_000
        ? MEDIUM_CONTEXT_AUTOCOMPACT_BUFFER_TOKENS
        : BASE_AUTOCOMPACT_BUFFER_TOKENS
  const limit = maxTokens - outputReserve - buffer

  if (limit <= 0 || limit >= maxTokens) {
    return undefined
  }

  return limit
}

/**
 * Predictive threshold used before the request is sent.
 *
 * Claude Code runs the normal auto-compact check first, then a predictive
 * pass that asks: "will one more model output plus typical tool results push
 * this turn over the context window?"  This trigger is deliberately separate
 * from the hard window. It only starts compaction earlier; it never reduces
 * the actual backend request budget.
 */
export function resolvePredictiveCompactTokenLimit(
  input: ContextAutoCompactInput
): number | undefined {
  const maxTokens = normalizePositiveInteger(input.maxTokens)
  if (!maxTokens) {
    return undefined
  }

  if (input.backend === "codex") {
    // Codex core defines one native 90% auto-compact threshold. A second
    // Claude-style growth estimate would diverge from its runtime contract.
    return undefined
  }

  const outputReserve = Math.min(
    normalizePositiveInteger(input.maxOutputTokens) ??
      DEFAULT_TURN_OUTPUT_RESERVE_TOKENS,
    COMPACT_SUMMARY_OUTPUT_RESERVE_TOKENS
  )
  const estimatedTurnGrowth =
    outputReserve + TOOL_RESULT_TURN_GROWTH_ESTIMATE_TOKENS
  const limit = maxTokens - outputReserve - estimatedTurnGrowth

  if (limit <= 0 || limit >= maxTokens) {
    return undefined
  }

  return limit
}
