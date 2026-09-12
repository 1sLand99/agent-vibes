import type { ChatGptWebConversationService } from "../../llm/openai/chatgpt-web-conversation.service"
import { ChatGptWebProtocolService } from "./chatgpt-web.service"
import type { ChatGptWebTransportSelector } from "./chatgpt-web-transport.selector"
import { ChatGptWebTransportSelector as Selector } from "./chatgpt-web-transport.selector"

/**
 * The depth a caller asked for has to survive the trip to chatgpt.com, and it
 * reaches this surface in three spellings: OpenAI's `reasoning_effort`, the
 * Responses API's `reasoning.effort`, and the `model(level)` suffix this
 * bridge accepts everywhere else.
 */

function harness() {
  const seen: { model?: string; thinkingEffort?: string | null }[] = []
  const conversation = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(request: { model: string; thinkingEffort?: string | null }) {
      seen.push({
        model: request.model,
        thinkingEffort: request.thinkingEffort,
      })
      yield { kind: "text" as const, delta: "ok" }
    },
  } as unknown as ChatGptWebConversationService
  const transports = {
    resolve: () => "http" as const,
  } as unknown as ChatGptWebTransportSelector
  return {
    seen,
    service: new ChatGptWebProtocolService(conversation, transports),
  }
}

const ask = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  messages: [{ role: "user" as const, content: "hi" }],
  ...extra,
})

describe("depth on the /v1/web-gpt surface", () => {
  it("takes OpenAI's reasoning_effort", async () => {
    const { service, seen } = harness()
    await service.createChatCompletion(
      ask("gpt-5-6-thinking", { reasoning_effort: "high" })
    )
    expect(seen).toEqual([
      { model: "gpt-5-6-thinking", thinkingEffort: "extended" },
    ])
  })

  it("takes the Responses API's reasoning.effort", async () => {
    const { service, seen } = harness()
    await service.createResponse({
      model: "gpt-5-6-thinking",
      input: "hi",
      reasoning: { effort: "low" },
    })
    expect(seen[0]!.thinkingEffort).toBe("min")
  })

  it("takes the model suffix, and does not send it upstream", async () => {
    const { service, seen } = harness()
    await service.createChatCompletion(ask("gpt-5-6-thinking(xhigh)"))
    expect(seen).toEqual([{ model: "gpt-5-6-thinking", thinkingEffort: "max" }])
  })

  it("takes ChatGPT's own word for it", async () => {
    // A caller who knows the web app should not have to translate into
    // Cursor's ladder first.
    const { service, seen } = harness()
    await service.createChatCompletion(
      ask("gpt-5-6-thinking", { reasoning_effort: "extended" })
    )
    expect(seen[0]!.thinkingEffort).toBe("extended")
  })

  it("says nothing when the caller asked for nothing", async () => {
    const { service, seen } = harness()
    await service.createChatCompletion(ask("gpt-5-6-thinking"))
    expect(seen[0]!.thinkingEffort).toBeNull()
  })

  it("says nothing for a model with no depths to choose from", async () => {
    const { service, seen } = harness()
    await service.createChatCompletion(
      ask("gpt-5-6", { reasoning_effort: "high" })
    )
    expect(seen[0]!.thinkingEffort).toBeNull()
  })

  it("keeps the transport prefix and the depth out of the slug", () => {
    expect(Selector.stripPrefix("browser/gpt-5-6-thinking(high)")).toBe(
      "gpt-5-6-thinking"
    )
    expect(Selector.stripPrefix(" gpt-5-6-thinking ")).toBe("gpt-5-6-thinking")
  })
})
