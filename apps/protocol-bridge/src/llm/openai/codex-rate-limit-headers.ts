import type { CodexRateLimitWindow } from "../shared/backend-pool-status"

export type CodexRateLimitTier = "primary" | "secondary"

export interface CodexRateLimitHeaderWindows {
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
}

export function parseCodexRateLimitHeaders(
  headers: Pick<Headers, "get">
): CodexRateLimitHeaderWindows {
  return {
    primary: parseCodexRateLimitWindow(headers, "primary"),
    secondary: parseCodexRateLimitWindow(headers, "secondary"),
  }
}

export function parseCodexRateLimitWindow(
  headers: Pick<Headers, "get">,
  tier: CodexRateLimitTier
): CodexRateLimitWindow | null {
  const usedPercentStr = headers.get(`x-codex-${tier}-used-percent`)
  if (!usedPercentStr) {
    return null
  }

  const usedPercent = parseFloat(usedPercentStr)
  if (!Number.isFinite(usedPercent)) {
    return null
  }

  const windowMinutesStr = headers.get(`x-codex-${tier}-window-minutes`)
  const windowMinutes = windowMinutesStr ? parseInt(windowMinutesStr, 10) : null

  const resetsAtStr = headers.get(`x-codex-${tier}-reset-at`)
  const resetsAt = resetsAtStr ? parseInt(resetsAtStr, 10) : null

  return {
    usedPercent,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  }
}

export function formatCodexRateLimitWindow(
  tier: CodexRateLimitTier,
  window: CodexRateLimitWindow
): string {
  const left = Math.max(0, 100 - window.usedPercent).toFixed(0)
  const windowMinutes =
    typeof window.windowMinutes === "number" &&
    Number.isFinite(window.windowMinutes)
      ? `${window.windowMinutes}m`
      : "unknown"
  const resetAt =
    typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt)
      ? new Date(window.resetsAt * 1000).toISOString()
      : "unknown"

  return `${tier}=${left}% left (window=${windowMinutes}, resetAt=${resetAt})`
}
