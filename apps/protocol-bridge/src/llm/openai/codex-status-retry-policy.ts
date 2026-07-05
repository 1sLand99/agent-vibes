export interface CodexStatusRetryContext {
  statusCode: number
  attempt: number
  emittedEvents?: boolean
}

export interface CodexTokenRefreshRetryContext extends CodexStatusRetryContext {
  isApiKeyMode: boolean
}

export interface CodexAccountFailoverRetryContext extends CodexStatusRetryContext {
  accountCount: number
  includeGatewayTransient?: boolean
}

export function isCodexAuthRetryStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403
}

export function isCodexRateLimitRetryStatus(statusCode: number): boolean {
  return statusCode === 429
}

export function isCodexGatewayTransientStatus(statusCode: number): boolean {
  return statusCode === 502 || statusCode === 503 || statusCode === 504
}

export function shouldRefreshCodexTokenForStatus(
  context: CodexTokenRefreshRetryContext
): boolean {
  return (
    isCodexAuthRetryStatus(context.statusCode) &&
    context.attempt === 1 &&
    !context.emittedEvents &&
    !context.isApiKeyMode
  )
}

export function shouldRetryCodexGatewayTransientOnSameSlot(
  context: CodexStatusRetryContext
): boolean {
  return (
    isCodexGatewayTransientStatus(context.statusCode) &&
    context.attempt === 1 &&
    !context.emittedEvents
  )
}

export function shouldFailOverCodexAccountForStatus(
  context: CodexAccountFailoverRetryContext
): boolean {
  if (context.emittedEvents || context.attempt >= context.accountCount) {
    return false
  }

  return (
    isCodexAuthRetryStatus(context.statusCode) ||
    isCodexRateLimitRetryStatus(context.statusCode) ||
    (context.includeGatewayTransient === true &&
      isCodexGatewayTransientStatus(context.statusCode))
  )
}
