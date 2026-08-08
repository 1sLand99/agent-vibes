import type { ContextCompactRunnerSummaryRequest } from "../../context"
import { CreateMessageDto } from "../anthropic/dto/create-message.dto"

export function buildNoToolsCompactSummaryDto(input: {
  model: string
  conversationId?: string
  request: Pick<
    ContextCompactRunnerSummaryRequest,
    "messages" | "prompt" | "maxTokens"
  >
}): CreateMessageDto {
  const dto: CreateMessageDto = {
    model: input.model,
    max_tokens: input.request.maxTokens,
    system:
      "You are a helpful AI assistant tasked with summarizing conversations.",
    messages: [
      ...input.request.messages.map((message) => ({
        role: message.role,
        content: structuredClone(message.content),
        ...(message.messageId ? { messageId: message.messageId } : {}),
        ...(message.isMeta ? { isMeta: true } : {}),
      })),
      {
        role: "user",
        content: input.request.prompt,
      },
    ] as CreateMessageDto["messages"],
    tools: [],
    thinking: { type: "disabled" },
    _thinkingIntent: { mode: "disabled" },
    stream: false,
  }
  if (input.conversationId) {
    dto._conversationId = `${input.conversationId}:compact`
  }
  return dto
}
