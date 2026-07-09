import { HttpException, HttpStatus } from "@nestjs/common"

interface GoogleErrorBody {
  error: {
    code: number
    message: string
    status: string
    details?: unknown[]
  }
}

const STATUS_BY_CODE: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
}

function googleStatusForCode(code: number): string {
  return STATUS_BY_CODE[code] || "UNKNOWN"
}

export function googleErrorBody(
  code: number,
  message: string,
  status = googleStatusForCode(code),
  details?: unknown[]
): GoogleErrorBody {
  return {
    error: {
      code,
      message,
      status,
      ...(details && details.length > 0 ? { details } : {}),
    },
  }
}

export function googleHttpException(
  code: number,
  message: string,
  status = googleStatusForCode(code)
): HttpException {
  return new HttpException(googleErrorBody(code, message, status), code)
}

function extractMessage(response: unknown): string | null {
  if (typeof response === "string") return response
  if (!response || typeof response !== "object") return null

  const body = response as Record<string, unknown>
  const error = body.error
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>
    if (typeof nested.message === "string") return nested.message
  }
  if (typeof body.message === "string") return body.message
  return null
}

function isGoogleErrorBody(value: unknown): value is GoogleErrorBody {
  if (!value || typeof value !== "object") return false
  const error = (value as Record<string, unknown>).error
  if (!error || typeof error !== "object") return false
  return typeof (error as Record<string, unknown>).message === "string"
}

export function renderGoogleError(error: unknown): {
  status: number
  body: GoogleErrorBody
} {
  if (error instanceof HttpException) {
    const status = error.getStatus()
    const response = error.getResponse()
    if (isGoogleErrorBody(response)) {
      return { status, body: response }
    }

    const message = extractMessage(response) || error.message
    return {
      status,
      body: googleErrorBody(status, message, googleStatusForCode(status)),
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: googleErrorBody(
      HttpStatus.INTERNAL_SERVER_ERROR,
      message || "Internal server error",
      "INTERNAL"
    ),
  }
}
