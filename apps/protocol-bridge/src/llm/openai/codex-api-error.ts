import { HttpException } from "@nestjs/common"

export class CodexApiError extends HttpException {
  constructor(
    statusCode: number,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(
      {
        type: "error",
        error: {
          type: "api_error",
          message,
        },
        message,
        ...(retryAfterSeconds != null
          ? { retry_after: retryAfterSeconds }
          : {}),
      },
      statusCode
    )
    this.name = "CodexApiError"
  }
}
