import type {
  CodexRateLimitWindow,
  CodexRateLimitSnapshot,
  CodexRateLimitSource,
} from "../shared/backend-pool-status"

export const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60

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

export function getCodexWeeklyRateLimitWindow(
  snapshot: CodexRateLimitSnapshot | null
): CodexRateLimitWindow | null {
  if (!snapshot) {
    return null
  }

  return (
    [snapshot.primary, snapshot.secondary].find(
      (window) => window?.windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES
    ) || null
  )
}

export function getCodexWeeklyQuotaRemainingPercent(
  snapshot: CodexRateLimitSnapshot | null
): number | null {
  const usedPercent = getCodexWeeklyRateLimitWindow(snapshot)?.usedPercent
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null
  }

  return Math.max(0, 100 - usedPercent)
}

export function getCodexWeeklyQuotaCooldownUntil(
  snapshot: CodexRateLimitSnapshot | null
): number {
  const weekly = getCodexWeeklyRateLimitWindow(snapshot)
  const remainingPercent = getCodexWeeklyQuotaRemainingPercent(snapshot)
  const resetsAt = weekly?.resetsAt

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

export function getCodexWeeklyRateLimitCooldownUntil(
  snapshot: CodexRateLimitSnapshot | null,
  now: number
): number {
  const cooldownUntil = getCodexWeeklyQuotaCooldownUntil(snapshot)
  return cooldownUntil > now ? cooldownUntil : 0
}

export function isCodexRateLimitSnapshotExhausted(
  snapshot: CodexRateLimitSnapshot | null
): boolean {
  const weeklyRemaining = getCodexWeeklyQuotaRemainingPercent(snapshot)
  return weeklyRemaining != null && weeklyRemaining < 1
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
