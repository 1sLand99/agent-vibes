import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger"
import type { FastifyReply } from "fastify"
import { ApiKeyGuard } from "../../shared/api-key.guard"
import { ChatCompletionsService } from "./chat-completions.service"
import { renderOpenAiError } from "./openai-error"
import type {
  OpenAiChatCompletionRequest,
  OpenAiCompletionRequest,
  OpenAiResponsesRequest,
} from "./openai-types"

/**
 * OpenAI-compatible inbound endpoints.
 *
 * Exposes the standard OpenAI surface so any OpenAI SDK pointed at this
 * bridge (baseURL = http://host:port/v1) works unchanged:
 *   - POST /v1/chat/completions
 *   - POST /v1/responses
 *   - POST /v1/completions      (legacy text completion)
 *
 * Model listing (GET /v1/models) is served by the Anthropic MessagesController
 * which already registers that route; its payload carries OpenAI-compatible
 * `object`/`created`/`owned_by` fields, so a single endpoint satisfies both
 * protocol surfaces and avoids a Fastify duplicate-route error.
 *
 * Auth reuses ApiKeyGuard: `Authorization: Bearer <PROXY_API_KEY>` (the OpenAI
 * SDK default) or `x-api-key`. When PROXY_API_KEY is unset, all requests pass
 * (local development).
 */
@ApiTags("OpenAI API")
@Controller("v1")
@UseGuards(ApiKeyGuard)
@ApiSecurity("api-key")
export class ChatCompletionsController {
  constructor(
    private readonly chatCompletionsService: ChatCompletionsService
  ) {}

  private buildMissingModelError(): HttpException {
    return new HttpException(
      {
        error: {
          message: "you must provide a model parameter",
          type: "invalid_request_error",
          param: "model",
          code: null,
        },
      },
      400
    )
  }

  @Post("chat/completions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a chat completion (OpenAI API)" })
  async createChatCompletion(
    // Accept the raw plain body: the SEA esbuild bundle does not preserve the
    // reflect-metadata that ValidationPipe needs, so DTO transforms would
    // strip every field. Required fields are validated downstream. This
    // matches the Anthropic MessagesController approach.
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    const req = body as unknown as OpenAiChatCompletionRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatCompletionsService.createChatCompletionStream(req)
      )
      return
    }

    try {
      return await this.chatCompletionsService.createChatCompletion(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Post("responses")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a response (OpenAI Responses API)" })
  async createResponse(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    const req = body as unknown as OpenAiResponsesRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }
    if (req.input == null) {
      throw new HttpException(
        {
          error: {
            message: "you must provide an input parameter",
            type: "invalid_request_error",
            param: "input",
            code: null,
          },
        },
        400
      )
    }

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatCompletionsService.createResponseStream(req)
      )
      return
    }

    try {
      return await this.chatCompletionsService.createResponse(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  @Post("completions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a completion (OpenAI legacy API)" })
  async createCompletion(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    const req = body as unknown as OpenAiCompletionRequest
    if (typeof req?.model !== "string" || req.model.trim() === "") {
      throw this.buildMissingModelError()
    }
    if (req.prompt == null) {
      throw new HttpException(
        {
          error: {
            message: "you must provide a prompt parameter",
            type: "invalid_request_error",
            param: "prompt",
            code: null,
          },
        },
        400
      )
    }

    if (req.stream && res) {
      await this.streamResponse(
        res,
        this.chatCompletionsService.createCompletionStream(req)
      )
      return
    }

    try {
      return await this.chatCompletionsService.createCompletion(req)
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (res && rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      throw new HttpException(rendered.body, rendered.status)
    }
  }

  /**
   * Pump an OpenAI SSE generator to the client. Mirrors the streaming error
   * contract of the Anthropic controller: pre-stream failures set the HTTP
   * status, mid-stream failures emit a terminal SSE error frame.
   */
  private async streamResponse(
    res: FastifyReply,
    stream: AsyncGenerator<string, void, unknown>
  ): Promise<void> {
    let headersWritten = false
    const ensureHeaders = () => {
      if (headersWritten) return
      res.header("Content-Type", "text/event-stream")
      res.header("Cache-Control", "no-cache")
      res.header("Connection", "keep-alive")
      headersWritten = true
    }

    try {
      for await (const chunk of stream) {
        ensureHeaders()
        res.raw.write(chunk)
      }
    } catch (error) {
      const rendered = renderOpenAiError(error)
      if (!headersWritten) {
        res.status(rendered.status)
      }
      if (rendered.retryAfterSeconds != null) {
        res.header("Retry-After", String(rendered.retryAfterSeconds))
      }
      ensureHeaders()
      res.raw.write(`data: ${JSON.stringify(rendered.body)}\n\n`)
    } finally {
      ensureHeaders()
      res.raw.end()
    }
  }
}
