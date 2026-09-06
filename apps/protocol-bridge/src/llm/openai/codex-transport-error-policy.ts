import { CodexApiError } from "./codex-api-error"
import { isCodexDeactivatedWorkspaceError } from "./codex-api-error-response"
import { CodexWebSocketUpgradeError } from "./codex-websocket.service"

const STALE_PREVIOUS_RESPONSE_PATTERN = /previous.response.*not found/i

export function shouldRetryCodexSessionWebSocketError(error: unknown): boolean {
  if (error instanceof CodexWebSocketUpgradeError) {
    return false
  }

  const message = getErrorMessage(error)
  return (
    message.includes("websocket is not open") ||
    message.includes("readystate") ||
    message.includes("socket has been closed") ||
    message.includes("websocket closed before response.completed") ||
    message.includes("codex websocket idle timeout")
  )
}

export function isCodexStaleResponseIdError(error: unknown): boolean {
  if (error instanceof CodexWebSocketUpgradeError) {
    return (
      error.statusCode === 400 &&
      STALE_PREVIOUS_RESPONSE_PATTERN.test(error.body)
    )
  }
  if (error instanceof CodexApiError) {
    return (
      error.getStatus() === 400 &&
      STALE_PREVIOUS_RESPONSE_PATTERN.test(error.message)
    )
  }
  return false
}

export function shouldFallbackToHttpAfterCodexWebSocketError(
  error: unknown
): boolean {
  if (error instanceof CodexWebSocketUpgradeError) {
    return error.shouldFallbackToHttp()
  }

  if (shouldRetryCodexSessionWebSocketError(error)) {
    return true
  }

  const message = getErrorMessage(error)
  return (
    message.includes("handshake timeout") ||
    message.includes("unexpected server response") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("ehostunreach") ||
    message.includes("enotfound") ||
    message.includes("proxy") ||
    message.includes("tls") ||
    message.includes("certificate")
  )
}

export interface ShouldRetryCodexWebSocketBeforeHttpFallbackOptions {
  emittedEvents: boolean
  retryCount: number
  maxRetries: number
}

export function shouldRetryCodexWebSocketBeforeHttpFallback(
  error: unknown,
  options: ShouldRetryCodexWebSocketBeforeHttpFallbackOptions
): boolean {
  if (options.emittedEvents) {
    return false
  }
  if (options.retryCount >= Math.max(0, options.maxRetries)) {
    return false
  }
  if (error instanceof CodexWebSocketUpgradeError) {
    return false
  }

  return (
    shouldRetryCodexSessionWebSocketError(error) ||
    shouldFallbackToHttpAfterCodexWebSocketError(error)
  )
}

export type CodexWebSocketFailureAction =
  | {
      kind: "retry_http_without_account"
      statusCode: number
      body: string
    }
  | {
      kind: "fallback_http"
      reason: "upgrade_rejected" | "transport_unavailable"
    }
  | {
      kind: "throw_codex_api_error"
      statusCode: number
      body: string
    }
  | {
      kind: "throw_original"
    }

export interface ResolveCodexWebSocketFailureOptions {
  isApiKeyMode: boolean
}

export function resolveCodexWebSocketFailure(
  error: unknown,
  options: ResolveCodexWebSocketFailureOptions
): CodexWebSocketFailureAction {
  if (error instanceof CodexWebSocketUpgradeError) {
    const statusCode = error.statusCode || 502
    const body = error.body || error.message

    if (!options.isApiKeyMode && isCodexDeactivatedWorkspaceError(error.body)) {
      return {
        kind: "retry_http_without_account",
        statusCode,
        body,
      }
    }

    if (error.shouldFallbackToHttp()) {
      return {
        kind: "fallback_http",
        reason: "upgrade_rejected",
      }
    }

    return {
      kind: "throw_codex_api_error",
      statusCode,
      body,
    }
  }

  if (shouldFallbackToHttpAfterCodexWebSocketError(error)) {
    return {
      kind: "fallback_http",
      reason: "transport_unavailable",
    }
  }

  return {
    kind: "throw_original",
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase()
}
