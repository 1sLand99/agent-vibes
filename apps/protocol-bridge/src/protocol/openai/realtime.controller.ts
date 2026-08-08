import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
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
  type ChatGptRealtimeCompanionCompletion,
  ChatGptRealtimeCompanionProtocolError,
  ChatGptRealtimeCompanionService,
  ChatGptRealtimeCompanionTimeoutError,
  ChatGptRealtimeCompanionUnavailableError,
} from "../../llm/openai/chatgpt-realtime-companion.service"
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
  constructor(private readonly companion: ChatGptRealtimeCompanionService) {}

  @Post("calls")
  @HttpCode(201)
  @ApiConsumes("multipart/form-data", "application/sdp", "application/json")
  @ApiProduces("application/sdp")
  @ApiOperation({
    summary: "Create a ChatGPT Web-backed Realtime WebRTC relay",
  })
  async createCall(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply
  ): Promise<void> {
    try {
      const contentType = String(request.headers["content-type"] || "")
      const normalized = parseChatGptWebRealtimeCallRequest(body, contentType)
      const result = await this.companion.createCall(normalized)

      response.code(201)
      response.header("Content-Type", "application/sdp")
      response.header("Cache-Control", "no-store")
      response.header("Location", `/v1/realtime/calls/${result.callId}`)
      response.send(result.sdp)
    } catch (error) {
      if (error instanceof ChatGptWebRealtimeRequestError) {
        throw openAiError(400, error.message, null, error.param)
      }
      if (error instanceof ChatGptRealtimeCompanionUnavailableError) {
        throw openAiError(503, error.message, error.code)
      }
      if (error instanceof ChatGptRealtimeCompanionTimeoutError) {
        throw openAiError(504, error.message, error.code)
      }
      if (error instanceof ChatGptRealtimeCompanionProtocolError) {
        throw openAiError(502, error.message, error.code)
      }
      throw error
    }
  }

  @Post("companion/jobs/next")
  @HttpCode(200)
  @ApiOperation({ summary: "Wait for the next browser companion relay job" })
  async nextCompanionJob(@Res() response: FastifyReply): Promise<void> {
    const job = await this.companion.nextJob()
    if (!job) {
      response.code(204).send()
      return
    }
    response.header("Cache-Control", "no-store")
    response.send(job)
  }

  @Post("companion/jobs/:jobId/complete")
  @HttpCode(202)
  @ApiOperation({ summary: "Complete a browser companion relay job" })
  completeCompanionJob(
    @Param("jobId") jobId: string,
    @Body() completion: ChatGptRealtimeCompanionCompletion
  ): { accepted: boolean } {
    const accepted = this.companion.completeJob(jobId, completion)
    if (!accepted) {
      throw openAiError(
        404,
        "Realtime companion job was not found or has expired",
        "realtime_companion_job_not_found"
      )
    }
    return { accepted: true }
  }

  @Get("companion/status")
  @ApiOperation({ summary: "Read browser companion connection status" })
  getCompanionStatus(): { connected: boolean; pendingCalls: number } {
    return this.companion.status
  }
}
