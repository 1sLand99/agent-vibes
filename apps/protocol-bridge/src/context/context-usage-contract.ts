import type { ContextUsageSnapshot } from "./types"

export type ContextUsageTokenCounts = Pick<
  ContextUsageSnapshot,
  | "inputTokens"
  | "cachedInputTokens"
  | "cacheCreationInputTokens"
  | "outputTokens"
>

export class ContextUsageContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ContextUsageContractError"
  }
}

/**
 * Token accounting is persisted and later reused as a context checkpoint.
 * Keep its numeric domain exact: provider token counts are discrete,
 * non-negative safe integers, never values to floor, round, or coerce.
 */
export function requireNonNegativeSafeIntegerTokenCount(
  value: unknown,
  label: string
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ContextUsageContractError(
      `${label} must be a non-negative safe integer`
    )
  }
  return value
}

export function createContextUsageSnapshot(
  counts: ContextUsageTokenCounts,
  options?: { recordedAt?: number; label?: string }
): ContextUsageSnapshot {
  const label = options?.label || "context usage"
  const inputTokens = requireNonNegativeSafeIntegerTokenCount(
    counts.inputTokens,
    `${label}.inputTokens`
  )
  const cachedInputTokens = requireNonNegativeSafeIntegerTokenCount(
    counts.cachedInputTokens,
    `${label}.cachedInputTokens`
  )
  const cacheCreationInputTokens = requireNonNegativeSafeIntegerTokenCount(
    counts.cacheCreationInputTokens,
    `${label}.cacheCreationInputTokens`
  )
  const outputTokens = requireNonNegativeSafeIntegerTokenCount(
    counts.outputTokens,
    `${label}.outputTokens`
  )
  const totalTokens =
    inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens
  if (!Number.isSafeInteger(totalTokens)) {
    throw new ContextUsageContractError(
      `${label}.totalTokens must be a non-negative safe integer`
    )
  }
  const recordedAt = requireNonNegativeSafeIntegerTokenCount(
    options?.recordedAt ?? Date.now(),
    `${label}.recordedAt`
  )
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    totalTokens,
    recordedAt,
  }
}

export function assertContextUsageSnapshot(
  value: ContextUsageSnapshot,
  label: string = "context usage"
): ContextUsageSnapshot {
  const normalized = createContextUsageSnapshot(value, {
    recordedAt: value.recordedAt,
    label,
  })
  const totalTokens = requireNonNegativeSafeIntegerTokenCount(
    value.totalTokens,
    `${label}.totalTokens`
  )
  if (totalTokens !== normalized.totalTokens) {
    throw new ContextUsageContractError(
      `${label}.totalTokens must equal the exact component sum`
    )
  }
  return normalized
}

export function contextUsageInputTokenCount(
  usage: ContextUsageSnapshot,
  label: string = "context usage"
): number {
  const normalized = assertContextUsageSnapshot(usage, label)
  const inputTokenCount =
    normalized.inputTokens +
    normalized.cachedInputTokens +
    normalized.cacheCreationInputTokens
  if (!Number.isSafeInteger(inputTokenCount)) {
    throw new ContextUsageContractError(
      `${label}.inputContextTokens must be a non-negative safe integer`
    )
  }
  return inputTokenCount
}
