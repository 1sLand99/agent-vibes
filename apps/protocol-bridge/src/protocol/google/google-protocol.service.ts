import { Injectable } from "@nestjs/common"
import { MessagesService } from "../anthropic/messages.service"
import { googleHttpException } from "./google-error"
import {
  bridgeModelsToGoogleModels,
  findGoogleModel,
  GoogleListModelsResponse,
  GoogleModel,
  normalizeGoogleModelId,
} from "./google-models"
import {
  anthropicResponseToGoogleGenerateContent,
  GoogleGenerateContentRequest,
  GoogleStreamTranslator,
  googleCountTokensRequestToAnthropic,
  googleGenerateRequestToAnthropic,
} from "./google-translator"

@Injectable()
export class GoogleProtocolService {
  constructor(private readonly messagesService: MessagesService) {}

  listModels(): GoogleListModelsResponse {
    return bridgeModelsToGoogleModels(this.messagesService.listModels())
  }

  getModel(model: string): GoogleModel {
    const found = findGoogleModel(this.messagesService.listModels(), model)
    if (!found) {
      throw googleHttpException(
        404,
        `Model ${model} was not found`,
        "NOT_FOUND"
      )
    }
    return found
  }

  async generateContent(
    model: string,
    request: GoogleGenerateContentRequest
  ): Promise<Record<string, unknown>> {
    const dto = googleGenerateRequestToAnthropic(model, request, false)
    this.getModel(dto.model)
    const response = await this.messagesService.createMessage(dto)
    return anthropicResponseToGoogleGenerateContent(response, dto.model)
  }

  async *streamGenerateContent(
    model: string,
    request: GoogleGenerateContentRequest
  ): AsyncGenerator<string, void, unknown> {
    const dto = googleGenerateRequestToAnthropic(model, request, true)
    this.getModel(dto.model)
    const translator = new GoogleStreamTranslator(dto.model)
    for await (const chunk of this.messagesService.createMessageStream(dto)) {
      yield* translator.push(chunk)
    }
    yield* translator.finish()
  }

  async countTokens(
    model: string,
    request: GoogleGenerateContentRequest
  ): Promise<Record<string, unknown>> {
    const dto = googleCountTokensRequestToAnthropic(model, request)
    this.getModel(normalizeGoogleModelId(dto.model))
    const result = await this.messagesService.countTokens(dto)
    return { totalTokens: result.input_tokens }
  }
}
