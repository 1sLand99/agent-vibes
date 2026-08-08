import { CodexApiError } from "./codex-api-error"

export interface CreateCodexApiErrorOptions {
  nowSeconds?: number
  maxDetailsLength?: number
}

export function parseCodexRetryAfter(
  statusCode: number,
  errorBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number | null {
  if (statusCode !== 429) {
    return null
  }

  const parsed = parseJsonObject(errorBody)
  const error = readObject(parsed?.error)
  if (!error || error.type !== "usage_limit_reached") {
    return null
  }

  const resetsAt = readPositiveNumber(error.resets_at)
  if (resetsAt != null && resetsAt > nowSeconds) {
    return resetsAt - nowSeconds
  }

  const resetsInSeconds = readPositiveNumber(error.resets_in_seconds)
  return resetsInSeconds
}

export function summarizeCodexErrorBody(
  errorBody: string,
  maxLength = 200
): string {
  const trimmed = errorBody.trim()
  if (!trimmed) {
    return ""
  }

  const parsed = parseJsonObject(trimmed)
  if (!parsed) {
    return trimmed.slice(0, maxLength)
  }

  const error = readObject(parsed.error)
  const errorMessage =
    typeof error?.message === "string" ? error.message.trim() : ""
  const parsedMessage =
    typeof parsed.message === "string" ? parsed.message.trim() : ""
  const message = errorMessage || parsedMessage || trimmed

  return message.slice(0, maxLength)
}

export function extractCodexErrorCode(errorBody: string): string | null {
  const trimmed = errorBody.trim()
  if (!trimmed) {
    return null
  }

  const parsed = parseJsonObject(trimmed)
  if (!parsed) {
    return null
  }

  const detail = readObject(parsed.detail)
  const error = readObject(parsed.error)
  const code = detail?.code ?? error?.code
  return typeof code === "string" && code.trim() ? code.trim() : null
}

export function isCodexDeactivatedWorkspaceError(errorBody: string): boolean {
  return extractCodexErrorCode(errorBody) === "deactivated_workspace"
}

export type CodexHttpErrorResponseAction =
  | {
      kind: "retry_http_without_account"
    }
  | {
      kind: "throw_codex_api_error"
      statusCode: number
      body: string
    }

export interface ResolveCodexHttpErrorResponseOptions {
  omitAccountId: boolean
  isApiKeyMode: boolean
}

export function resolveCodexHttpErrorResponse(
  statusCode: number,
  errorBody: string,
  options: ResolveCodexHttpErrorResponseOptions
): CodexHttpErrorResponseAction {
  if (
    !options.omitAccountId &&
    !options.isApiKeyMode &&
    isCodexDeactivatedWorkspaceError(errorBody)
  ) {
    return {
      kind: "retry_http_without_account",
    }
  }

  return {
    kind: "throw_codex_api_error",
    statusCode,
    body: errorBody,
  }
}

export function createCodexApiErrorFromBody(
  statusCode: number,
  errorBody: string,
  options: CreateCodexApiErrorOptions = {}
): CodexApiError {
  const retryAfter = parseCodexRetryAfter(
    statusCode,
    errorBody,
    options.nowSeconds
  )
  const details = summarizeCodexErrorBody(errorBody, options.maxDetailsLength)
  const providerCode = extractCodexErrorCode(errorBody) ?? undefined

  if (retryAfter != null) {
    const suffix = details ? ` ${details}` : ""
    return new CodexApiError(
      statusCode,
      `Codex rate limited. Retry after ${retryAfter} seconds.${suffix}`,
      retryAfter,
      providerCode
    )
  }

  const message = details
    ? `Codex API error ${statusCode}: ${details}`
    : `Codex API error ${statusCode}`

  return new CodexApiError(statusCode, message, undefined, providerCode)
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return readObject(JSON.parse(value))
  } catch {
    return null
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

function readPositiveNumber(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}
