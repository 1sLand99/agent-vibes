/**
 * Local-only key for a child context projection. A child keeps one continuous
 * provider history and one local projection namespace across its requests.
 */
export function buildSubagentProjectionKey(localThreadId: string): string {
  const thread = requireLocalThreadKey(localThreadId)
  return `${thread}:projection:child`
}

function requireLocalThreadKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) {
    throw new Error(
      "Subagent projection key requires a non-empty whitespace-free localThreadId"
    )
  }
  return value
}
