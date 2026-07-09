import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger"
import type { FastifyReply } from "fastify"
import { ApiKeyGuard } from "../../shared/api-key.guard"
import { googleHttpException, renderGoogleError } from "./google-error"
import { GoogleProtocolService } from "./google-protocol.service"
import type { GoogleGenerateContentRequest } from "./google-translator"

@ApiTags("Google Generative Language API")
@Controller()
@UseGuards(ApiKeyGuard)
@ApiSecurity("api-key")
export class GoogleController {
  constructor(private readonly googleProtocolService: GoogleProtocolService) {}

  @Get("v1beta/models")
  @ApiOperation({ summary: "List models (Google API)" })
  listModels() {
    return this.googleProtocolService.listModels()
  }

  @Get(["v1beta/models/:model", "v1/models/:model"])
  @ApiOperation({ summary: "Get model metadata (Google API)" })
  getModel(@Param("model") model: string) {
    return this.googleProtocolService.getModel(model)
  }

  @Post(["v1beta/models/:modelAndMethod", "v1/models/:modelAndMethod"])
  @HttpCode(200)
  @ApiOperation({ summary: "Run a model method (Google API)" })
  async runModelMethod(
    @Param("modelAndMethod") modelAndMethod: string,
    @Body() body: GoogleGenerateContentRequest,
    @Res({ passthrough: true }) res?: FastifyReply
  ) {
    const separator = modelAndMethod.lastIndexOf(":")
    if (separator === -1) {
      throw googleHttpException(
        404,
        `Unknown Google model method: ${modelAndMethod}`,
        "NOT_FOUND"
      )
    }

    const model = modelAndMethod.slice(0, separator)
    const method = modelAndMethod.slice(separator + 1)

    try {
      switch (method) {
        case "generateContent":
          return await this.googleProtocolService.generateContent(model, body)
        case "countTokens":
          return await this.googleProtocolService.countTokens(model, body)
        case "streamGenerateContent":
          if (!res) return undefined
          return await this.streamGenerateContent(model, body, res)
        case "embedContent":
        case "batchEmbedContents":
          throw googleHttpException(
            501,
            `${method} requires an embeddings backend, which is not implemented by this bridge`,
            "UNIMPLEMENTED"
          )
        default:
          throw googleHttpException(
            404,
            `Unknown Google model method: ${method}`,
            "NOT_FOUND"
          )
      }
    } catch (error) {
      const rendered = renderGoogleError(error)
      throw googleHttpException(
        rendered.status,
        rendered.body.error.message,
        rendered.body.error.status
      )
    }
  }

  private async streamGenerateContent(
    model: string,
    body: GoogleGenerateContentRequest,
    res: FastifyReply
  ) {
    let headersWritten = false
    const ensureHeaders = () => {
      if (headersWritten) return
      res.header("Content-Type", "text/event-stream")
      res.header("Cache-Control", "no-cache")
      res.header("Connection", "keep-alive")
      headersWritten = true
    }

    try {
      for await (const chunk of this.googleProtocolService.streamGenerateContent(
        model,
        body
      )) {
        ensureHeaders()
        res.raw.write(chunk)
      }
    } catch (error) {
      const rendered = renderGoogleError(error)
      if (!headersWritten) {
        res.status(rendered.status)
        res.send(rendered.body)
        return
      }
      ensureHeaders()
      res.raw.write(`event: error\ndata: ${JSON.stringify(rendered.body)}\n\n`)
    } finally {
      if (headersWritten) res.raw.end()
    }
  }
}
