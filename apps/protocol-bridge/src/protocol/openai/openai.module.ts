import { ModelModule } from "../../llm/shared/model.module"
import { CodexResponsesService } from "./codex-responses.service"
import { Module } from "@nestjs/common"
import { CodexModule } from "../../llm/openai/codex.module"
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
  imports: [AnthropicModule, CodexModule, ModelModule],
  controllers: [ChatCompletionsController, RealtimeController],
  providers: [
    ChatCompletionsService,
    CodexResponsesService,
    RequiredApiKeyGuard,
  ],
})
export class OpenaiModule {}
