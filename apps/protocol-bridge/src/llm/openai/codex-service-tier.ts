export function normalizeCodexServiceTier(
  rawValue?: string
): string | undefined {
  const normalized = rawValue?.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  switch (normalized) {
    case "priority":
    case "fast":
    case "true":
    case "on":
    case "enabled":
    case "1":
      return "priority"
    default:
      return undefined
  }
}

export function extractCodexServiceTierFromToml(
  rawConfig: string
): string | undefined {
  const match = rawConfig.match(/^\s*service_tier\s*=\s*"([^"]+)"/m)
  return normalizeCodexServiceTier(match?.[1])
}
