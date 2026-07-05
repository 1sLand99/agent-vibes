const CODEX_REFRESH_TOKEN_INVALIDATION_PATTERNS = [
  "already been used",
  "refresh_token_reused",
  "token_invalidated",
  "token has been invalidated",
]

export function isCodexRefreshTokenInvalidationError(error: unknown): boolean {
  if (error instanceof Error) {
    return isCodexRefreshTokenInvalidationMessage(error.message)
  }

  if (typeof error === "string") {
    return isCodexRefreshTokenInvalidationMessage(error)
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return isCodexRefreshTokenInvalidationMessage(error.message)
  }

  return false
}

export function isCodexRefreshTokenInvalidationMessage(
  message: string
): boolean {
  const normalized = message.toLowerCase()
  return CODEX_REFRESH_TOKEN_INVALIDATION_PATTERNS.some((pattern) =>
    normalized.includes(pattern)
  )
}
