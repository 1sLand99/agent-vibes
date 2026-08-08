import { Module } from "@nestjs/common"
import { ChatGptRealtimeCompanionService } from "../../llm/openai/chatgpt-realtime-companion.service"
import { RequiredApiKeyGuard } from "../../shared/required-api-key.guard"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { ChatCompletionsController } from "./chat-completions.controller"
import { ChatCompletionsService } from "./chat-completions.service"
import { RealtimeController } from "./realtime.controller"

/**
 * OpenAiModule — inbound OpenAI-compatible protocol surface.
 *
 * Reuses AnthropicModule's MessagesService (the canonical backend router)
 * so model routing, account pooling, error taxonomy, and usage accounting
 * are shared across the Anthropic and OpenAI surfaces. Only the wire
 * translation lives here.
 */
@Module({
  imports: [AnthropicModule],
  controllers: [ChatCompletionsController, RealtimeController],
  providers: [
    ChatCompletionsService,
    ChatGptRealtimeCompanionService,
    RequiredApiKeyGuard,
  ],
})
export class OpenaiModule {}
