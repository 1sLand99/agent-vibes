import { HttpException } from "@nestjs/common"
import type { BackendErrorClass } from "../shared/backend-error-class"

export class CodexApiError extends HttpException {
  public readonly errorClass?: BackendErrorClass

  constructor(
    statusCode: number,
    message: string,
    public readonly retryAfterSeconds?: number,
    /** Stable provider error code decoded from the Codex response body. */
    public readonly providerCode?: string
  ) {
    super(
      {
        type: "error",
        error: {
          type: "api_error",
          message,
          ...(providerCode ? { code: providerCode } : {}),
        },
        message,
        ...(retryAfterSeconds != null
          ? { retry_after: retryAfterSeconds }
          : {}),
      },
      statusCode
    )
    this.name = "CodexApiError"
    this.errorClass =
      providerCode === "context_length_exceeded"
        ? "context_length_exceeded"
        : undefined
  }
}
