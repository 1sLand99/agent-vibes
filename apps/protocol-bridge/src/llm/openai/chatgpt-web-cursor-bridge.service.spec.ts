import { ConfigService } from "@nestjs/config"
import { McpCursorToolsProvider } from "../../protocol/mcp/mcp-cursor-tools.provider"
import { McpService } from "../../protocol/mcp/mcp.service"
import type { ChatGptWebBrowserService } from "./chatgpt-web-browser.service"
import { ChatGptWebCursorBridge } from "./chatgpt-web-cursor-bridge.service"

const CONNECTOR = { CHATGPT_WEB_CONNECTOR_ID: "asdk_app_x" }

const configWith = (env: Record<string, string>) =>
  ({
    get: (key: string, fallback = "") => env[key] ?? fallback,
  }) as unknown as ConfigService

const textFrame = (text: string) =>
  `data: {"p":"","o":"add","c":0,"v":{"message":{"author":{"role":"assistant"},` +
  `"metadata":{"recipient":"all"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]}}}}\n`

/** A browser whose stream the test drives. */
function browserEmitting(
  chunks: string[],
  options: { landsIn?: string } = {}
): {
  browser: ChatGptWebBrowserService
  prompts: string[]
  threads: (string | null | undefined)[]
} {
  const prompts: string[] = []
  const threads: (string | null | undefined)[] = []
  return {
    prompts,
    threads,
    browser: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamTurn(request: {
        prompt: string
        conversationId?: string | null
        onConversationId?: (id: string) => void
      }) {
        prompts.push(request.prompt)
        threads.push(request.conversationId)
        for (const chunk of chunks) yield chunk
        if (options.landsIn) request.onConversationId?.(options.landsIn)
      },
    } as unknown as ChatGptWebBrowserService,
  }
}

function collect(
  frames: string[]
): { event: string; data: Record<string, unknown> }[] {
  return frames.map((raw) => {
    const [eventLine, dataLine] = raw.split("\n")
    return {
      event: eventLine!.replace("event: ", ""),
      data: JSON.parse(dataLine!.replace("data: ", "")) as Record<
        string,
        unknown
      >,
    }
  })
}

describe("ChatGptWebCursorBridge", () => {
  it("refuses to start without a connector to carry the tools", async () => {
    const { browser } = browserEmitting([])
    const bridge = new ChatGptWebCursorBridge(
      configWith({}),
      browser,
      new McpCursorToolsProvider(new McpService())
    )
    const stream = bridge.stream({
      conversationId: "c1",
      model: "gpt-5-6-thinking",
      prompt: "hi",
      toolResults: [],
    })
    await expect(stream.next()).rejects.toThrow(/CHATGPT_WEB_CONNECTOR_ID/)
  })

  it("claims the tool sink for the life of the turn and gives it back", async () => {
    const tools = new McpCursorToolsProvider(new McpService())
    const { browser } = browserEmitting([textFrame("done"), "data: [DONE]\n"])
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      tools
    )
    expect(tools.attached).toBe(false)
    const frames: string[] = []
    for await (const frame of bridge.stream({
      conversationId: "c1",
      model: "gpt-5-6-thinking",
      prompt: "hi",
      toolResults: [],
    })) {
      frames.push(frame)
    }
    // The turn finished, so nothing should still be holding the sink — a stuck
    // sink would route the next conversation's tool calls into a dead session.
    expect(tools.attached).toBe(false)
    expect(collect(frames).at(-1)!.event).toBe("message_stop")
  })

  it("continues one browser turn across two provider requests", async () => {
    const tools = new McpCursorToolsProvider(new McpService())
    const { browser, prompts } = browserEmitting([
      textFrame("after the tool"),
      "data: [DONE]\n",
    ])
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      tools
    )

    // ChatGPT reaches the connector only once the turn is under way, so the
    // call has to race the segment rather than precede it — before the sink is
    // claimed there is deliberately nothing to dispatch to.
    const first: string[] = []
    const reading = (async () => {
      for await (const frame of bridge.stream({
        conversationId: "c1",
        model: "gpt-5-6-thinking",
        prompt: "read it",
        toolResults: [],
      })) {
        first.push(frame)
      }
    })()
    while (!tools.attached) await new Promise((r) => setTimeout(r, 1))
    const pending = tools.callTool("read_file", { target_file: "a.ts" })
    await reading
    const toolStart = collect(first).find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as { type?: string })?.type === "tool_use"
    )!
    expect(toolStart.data.content_block).toMatchObject({ name: "read_file" })
    const toolCallId = (toolStart.data.content_block as { id: string }).id

    // Cursor ran it; the second request carries the result.
    const second: string[] = []
    for await (const frame of bridge.stream({
      conversationId: "c1",
      model: "gpt-5-6-thinking",
      prompt: "ignored on resume",
      toolResults: [
        { toolCallId, result: { content: [{ type: "text", text: "body" }] } },
      ],
    })) {
      second.push(frame)
    }
    await expect(pending).resolves.toMatchObject({
      content: [{ type: "text", text: "body" }],
    })

    // One browser turn, not two: resuming must not re-prompt ChatGPT.
    expect(prompts).toEqual(["read it"])
    const text = collect(second)
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data.delta as { text?: string }).text ?? "")
      .join("")
    expect(text).toContain("after the tool")
  })

  it("gives the tab to a different conversation rather than interleaving", async () => {
    const tools = new McpCursorToolsProvider(new McpService())
    const { browser, prompts } = browserEmitting([
      textFrame("x"),
      "data: [DONE]\n",
    ])
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      tools
    )
    for await (const _ of bridge.stream({
      conversationId: "c1",
      model: "gpt-5-6-thinking",
      prompt: "first",
      toolResults: [],
    })) {
      // drain
    }
    for await (const _ of bridge.stream({
      conversationId: "c2",
      model: "gpt-5-6-thinking",
      prompt: "second",
      toolResults: [],
    })) {
      // drain
    }
    expect(prompts).toEqual(["first", "second"])
  })

  it("ignores a replayed tool result instead of failing the turn", async () => {
    const tools = new McpCursorToolsProvider(new McpService())
    const { browser } = browserEmitting([textFrame("ok"), "data: [DONE]\n"])
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      tools
    )
    // Cursor replays results during recovery; a duplicate must not tear down a
    // healthy turn.
    const frames: string[] = []
    for await (const frame of bridge.stream({
      conversationId: "c1",
      model: "gpt-5-6-thinking",
      prompt: "hi",
      toolResults: [{ toolCallId: "toolu_stale", result: { content: [] } }],
    })) {
      frames.push(frame)
    }
    expect(collect(frames).at(-1)!.event).toBe("message_stop")
  })

  describe("the tool host", () => {
    /**
     * A conversation started in ChatGPT's own UI has no Cursor turn behind it,
     * and a Cursor tool can only run inside one. The host turn is that turn.
     */
    const hostBridge = () => {
      const tools = new McpCursorToolsProvider(new McpService())
      const { browser, prompts } = browserEmitting([])
      return {
        tools,
        prompts,
        bridge: new ChatGptWebCursorBridge(configWith({}), browser, tools),
      }
    }

    it("parks instead of answering, and drives no browser", async () => {
      const { bridge, prompts, tools } = hostBridge()
      const controller = new AbortController()
      const frames: string[] = []
      const parked = (async () => {
        for await (const frame of bridge.stream({
          conversationId: "host",
          model: "tool-host",
          prompt: "host",
          toolResults: [],
          signal: controller.signal,
        })) {
          frames.push(frame)
        }
      })()

      // Give the segment a moment to open and then sit there.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(prompts).toEqual([])
      expect(tools.attached).toBe(true)
      expect(collect(frames).map((f) => f.event)).toEqual(["message_start"])

      controller.abort()
      await parked
      expect(collect(frames).at(-1)!.event).toBe("message_stop")
    })

    it("needs no connector, because the ChatGPT side already carries one", async () => {
      // The browser path refuses without CHATGPT_WEB_CONNECTOR_ID; a host turn
      // opens no conversation of its own, so it has nothing to attach.
      const { bridge } = hostBridge()
      const controller = new AbortController()
      const first = bridge.stream({
        conversationId: "host",
        model: "tool-host",
        prompt: "host",
        toolResults: [],
        signal: controller.signal,
      })
      await expect(first.next()).resolves.toMatchObject({ done: false })
      controller.abort()
      await first.return(undefined)
    })

    it("hands a call arriving from ChatGPT to the editor", async () => {
      const { bridge, tools } = hostBridge()
      const controller = new AbortController()
      const frames: string[] = []
      const parked = (async () => {
        for await (const frame of bridge.stream({
          conversationId: "host",
          model: "tool-host",
          prompt: "host",
          toolResults: [],
          signal: controller.signal,
        })) {
          frames.push(frame)
        }
      })()
      await new Promise((resolve) => setTimeout(resolve, 20))

      const call = tools.callTool("read_file", { target_file: "a.ts" })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await parked

      const events = collect(frames)
      const start = events.find(
        (f) =>
          f.event === "content_block_start" &&
          (f.data.content_block as { type?: string } | undefined)?.type ===
            "tool_use"
      )
      expect(start).toBeDefined()
      expect((start!.data.content_block as { name: string }).name).toBe(
        "read_file"
      )

      // The segment ended at the call; the MCP request is still waiting for
      // the editor, which is what keeps ChatGPT's connector call open. Ending
      // the host turn is what finally releases it.
      bridge.release("host", "test over")
      await expect(call).rejects.toThrow("test over")
      controller.abort()
    })
  })
})

describe("pairing a Cursor conversation with a ChatGPT thread", () => {
  const done = () => [textFrame("ok"), "data: [DONE]\n"]

  const run = async (
    bridge: ChatGptWebCursorBridge,
    conversationId: string
  ) => {
    for await (const _ of bridge.stream({
      conversationId,
      model: "gpt-5-6-thinking",
      prompt: "hi",
      toolResults: [],
    })) {
      // drain
    }
  }

  it("starts a new thread for a conversation it has not seen", async () => {
    const { browser, threads } = browserEmitting(done(), { landsIn: "abc-123" })
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      new McpCursorToolsProvider(new McpService())
    )
    await run(bridge, "c1")
    expect(threads).toEqual([null])
  })

  it("goes back to the same thread on the next turn", async () => {
    // The tab is shared. Without this the turn lands wherever the last one
    // left it, which braids two chats together.
    const { browser, threads } = browserEmitting(done(), { landsIn: "abc-123" })
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      new McpCursorToolsProvider(new McpService())
    )
    await run(bridge, "c1")
    await run(bridge, "c1")
    expect(threads).toEqual([null, "abc-123"])
  })

  it("keeps a different conversation in a thread of its own", async () => {
    const { browser, threads } = browserEmitting(done(), { landsIn: "abc-123" })
    const bridge = new ChatGptWebCursorBridge(
      configWith(CONNECTOR),
      browser,
      new McpCursorToolsProvider(new McpService())
    )
    await run(bridge, "c1")
    await run(bridge, "c2")
    expect(threads).toEqual([null, null])
  })
})
