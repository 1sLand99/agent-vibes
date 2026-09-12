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
function browserEmitting(chunks: string[]): {
  browser: ChatGptWebBrowserService
  prompts: string[]
} {
  const prompts: string[] = []
  return {
    prompts,
    browser: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *streamTurn(request: { prompt: string }) {
        prompts.push(request.prompt)
        for (const chunk of chunks) yield chunk
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
      prompt: "first",
      toolResults: [],
    })) {
      // drain
    }
    for await (const _ of bridge.stream({
      conversationId: "c2",
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
      prompt: "hi",
      toolResults: [{ toolCallId: "toolu_stale", result: { content: [] } }],
    })) {
      frames.push(frame)
    }
    expect(collect(frames).at(-1)!.event).toBe("message_stop")
  })
})
