import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common"
import {
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger"
import type { FastifyReply, FastifyRequest } from "fastify"
import {
  ChatGptWebRealtimeService,
  ChatGptWebRealtimeServiceError,
} from "../../llm/openai/chatgpt-web-realtime.service"
import {
  ChatGptWebRealtimeRequestError,
  parseChatGptWebRealtimeCallRequest,
} from "../../llm/openai/chatgpt-web-realtime"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"

function openAiError(
  status: number,
  message: string,
  code: string | null,
  param: string | null = null
): HttpException {
  return new HttpException(
    {
      error: {
        message,
        type: status === 400 ? "invalid_request_error" : "api_error",
        param,
        code,
      },
    },
    status
  )
}

@ApiTags("OpenAI API")
@Controller("v1/realtime")
@UseGuards(RequiredApiKeyGuard)
@ApiSecurity("api-key")
export class RealtimeController {
  constructor(private readonly realtime: ChatGptWebRealtimeService) {}

  @Post("calls")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data", "application/sdp", "application/json")
  @ApiProduces("application/sdp")
  @ApiOperation({
    summary: "Create a ChatGPT Web-backed Realtime WebRTC call",
  })
  async createCall(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply
  ): Promise<void> {
    try {
      const contentType = String(request.headers["content-type"] || "")
      const normalized = parseChatGptWebRealtimeCallRequest(body, contentType)
      const result = await this.realtime.createCall(normalized)

      response.code(201)
      response.header("Content-Type", "application/sdp")
      response.header("Cache-Control", "no-store")
      response.header("Location", `/v1/realtime/calls/${result.callId}`)
      response.send(result.sdp)
    } catch (error) {
      if (error instanceof ChatGptWebRealtimeRequestError) {
        throw openAiError(400, error.message, null, error.param)
      }
      if (error instanceof ChatGptWebRealtimeServiceError) {
        throw openAiError(error.statusCode, error.message, error.code)
      }
      throw error
    }
  }
}
