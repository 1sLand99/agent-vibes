import type {
  CodexRateLimitSnapshot,
  CodexRateLimitSource,
} from "../shared/backend-pool-status"

export type CodexRateLimitTier = "primary" | "secondary"

export function getEffectiveCodexRateLimitSnapshot(
  snapshots?: Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
): CodexRateLimitSnapshot | null {
  if (!snapshots) {
    return null
  }

  if (snapshots.request) {
    return snapshots.request
  }

  return snapshots.probe || null
}

export function getCodexQuotaRemainingPercent(
  snapshot: CodexRateLimitSnapshot | null,
  tier: CodexRateLimitTier
): number | null {
  const usedPercent = snapshot?.[tier]?.usedPercent
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null
  }

  return Math.max(0, 100 - usedPercent)
}

export function getCodexQuotaCooldownUntil(
  snapshot: CodexRateLimitSnapshot | null,
  tier: CodexRateLimitTier
): number {
  const remainingPercent = getCodexQuotaRemainingPercent(snapshot, tier)
  const resetsAt = snapshot?.[tier]?.resetsAt

  if (
    remainingPercent === null ||
    remainingPercent >= 1 ||
    typeof resetsAt !== "number" ||
    !Number.isFinite(resetsAt)
  ) {
    return 0
  }

  return resetsAt * 1000
}

export function getCodexRateLimitQuotaCooldownUntil(
  snapshot: CodexRateLimitSnapshot | null,
  now: number
): number {
  if (!snapshot) {
    return 0
  }

  const activeResets = [
    getCodexQuotaCooldownUntil(snapshot, "primary"),
    getCodexQuotaCooldownUntil(snapshot, "secondary"),
  ].filter((cooldownUntil) => cooldownUntil > now)

  return activeResets.length > 0 ? Math.max(...activeResets) : 0
}

export function isCodexRateLimitSnapshotExhausted(
  snapshot: CodexRateLimitSnapshot | null
): boolean {
  const primaryRemaining = getCodexQuotaRemainingPercent(snapshot, "primary")
  if (primaryRemaining != null && primaryRemaining < 1) {
    return true
  }

  const secondaryRemaining = getCodexQuotaRemainingPercent(
    snapshot,
    "secondary"
  )
  return secondaryRemaining != null && secondaryRemaining < 1
}

export function getAllCodexAccountsRateLimitedRetrySeconds(
  recoveryTimes: ReadonlyArray<number | null | undefined>,
  now: number,
  fallbackSeconds = 60
): number {
  let earliestRecovery = Infinity

  for (const recoveryTime of recoveryTimes) {
    if (typeof recoveryTime === "number" && Number.isFinite(recoveryTime)) {
      earliestRecovery = Math.min(earliestRecovery, recoveryTime)
    }
  }

  const retryAfterMs = Number.isFinite(earliestRecovery)
    ? Math.max(0, earliestRecovery - now)
    : 0
  return retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : fallbackSeconds
}

export interface CodexAllAccountsRateLimitRetryContext {
  statusCode: number
  retryAfterSeconds?: number
  retryAttempt: number
  maxRetries: number
  maxWaitSeconds: number
}

export function getCodexAllAccountsRateLimitRetryDelayMs(
  context: CodexAllAccountsRateLimitRetryContext
): number | null {
  if (context.statusCode !== 429) {
    return null
  }
  if (context.retryAttempt >= Math.max(0, context.maxRetries)) {
    return null
  }

  const retryAfterSeconds = context.retryAfterSeconds
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds < 0
  ) {
    return null
  }

  const delayMs = Math.ceil(retryAfterSeconds * 1000)
  const maxWaitMs = Math.max(0, context.maxWaitSeconds) * 1000
  return delayMs <= maxWaitMs ? delayMs : null
}
