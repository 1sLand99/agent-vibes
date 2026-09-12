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

interface SeenTurn {
  model?: string
  thinkingEffort?: string | null
  conversationId?: string | null
  parentMessageId?: string | null
  messages?: { role: string; content: string }[]
}

function harness(options: { landsIn?: string; head?: string | null } = {}) {
  const seen: SeenTurn[] = []
  const headReads: string[] = []
  const conversation = {
    currentNode: (conversationId: string) => {
      headReads.push(conversationId)
      return Promise.resolve(options.head ?? null)
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(request: SeenTurn) {
      seen.push({
        model: request.model,
        thinkingEffort: request.thinkingEffort,
        conversationId: request.conversationId,
        parentMessageId: request.parentMessageId,
        messages: request.messages?.map((m) => ({ ...m })),
      })
      yield { kind: "text" as const, delta: "ok" }
      yield {
        kind: "done" as const,
        conversationId: options.landsIn,
        messageId: "msg-1",
      }
    },
  } as unknown as ChatGptWebConversationService
  const transports = {
    resolve: () => "http" as const,
  } as unknown as ChatGptWebTransportSelector
  return {
    seen,
    headReads,
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
    expect(seen[0]).toMatchObject({
      model: "gpt-5-6-thinking",
      thinkingEffort: "extended",
    })
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
    expect(seen[0]).toMatchObject({
      model: "gpt-5-6-thinking",
      thinkingEffort: "max",
    })
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

  it("goes as deep as the model allows when the caller asked for nothing", async () => {
    // The web quota is the reason to be on this surface at all; naming a
    // shallower depth is how you spend less of it.
    const { service, seen } = harness()
    await service.createChatCompletion(ask("gpt-5-6-thinking"))
    expect(seen[0]!.thinkingEffort).toBe("max")
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

describe("continuing a ChatGPT conversation from /v1/web-gpt", () => {
  const hello = (extra: Record<string, unknown> = {}) => ({
    model: "gpt-5-6-thinking",
    messages: [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "second" },
    ],
    ...extra,
  })

  it("starts a new conversation when the caller names none", async () => {
    const { service, seen, headReads } = harness({ landsIn: "conv-1" })
    await service.createChatCompletion(hello())
    expect(headReads).toEqual([])
    expect(seen[0]!.conversationId).toBeUndefined()
    expect(seen[0]!.messages).toHaveLength(3)
  })

  it("hands back the conversation it landed in", async () => {
    // A chat-completions caller has nowhere else to learn it.
    const { service } = harness({ landsIn: "conv-1" })
    const answer = (await service.createChatCompletion(hello())) as unknown as {
      conversation?: string
    }
    expect(answer.conversation).toBe("conv-1")
  })

  it("continues a named conversation with only what is new", async () => {
    // Upstream already holds the history; sending it again says it twice.
    const { service, seen, headReads } = harness({
      landsIn: "conv-1",
      head: "msg-head",
    })
    await service.createChatCompletion(hello({ conversation: "conv-1" }))
    expect(headReads).toEqual(["conv-1"])
    expect(seen[0]!.conversationId).toBe("conv-1")
    expect(seen[0]!.parentMessageId).toBe("msg-head")
    expect(seen[0]!.messages).toEqual([{ role: "user", content: "second" }])
  })

  it("follows the thread as it stands, not as it was last seen here", async () => {
    // The point of reading the head: someone may have carried the
    // conversation on by hand in the web UI since the last turn.
    const { service, seen } = harness({
      landsIn: "conv-1",
      head: "typed-by-hand",
    })
    await service.createChatCompletion(hello({ conversation: "conv-1" }))
    expect(seen[0]!.parentMessageId).toBe("typed-by-hand")
  })

  it("starts fresh when the named conversation cannot be read", async () => {
    // Deleted, or belonging to another account. Grafting a turn onto a branch
    // nobody asked for is worse than starting over.
    const { service, seen } = harness({ landsIn: "conv-2", head: null })
    await service.createChatCompletion(hello({ conversation: "gone" }))
    expect(seen[0]!.conversationId).toBeUndefined()
    expect(seen[0]!.messages).toHaveLength(3)
  })

  it("continues from a previous response id", async () => {
    const { service, seen } = harness({ landsIn: "conv-1", head: "msg-head" })
    const first = (await service.createChatCompletion(hello())) as unknown as {
      id: string
    }
    await service.createChatCompletion(
      hello({ previous_response_id: first.id })
    )
    expect(seen[1]!.conversationId).toBe("conv-1")
    expect(seen[1]!.parentMessageId).toBe("msg-head")
  })
})
