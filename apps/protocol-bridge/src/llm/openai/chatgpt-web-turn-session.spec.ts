import { ChatGptWebTurnSession } from "./chatgpt-web-turn-session"

/** A browser stream the test can feed and close by hand. */
function controllable(): {
  source: AsyncIterable<string>
  emit: (chunk: string) => void
  close: () => void
} {
  const chunks: string[] = []
  let wake: (() => void) | null = null
  let closed = false
  return {
    source: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (chunks.length) yield chunks.shift()!
          if (closed) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    },
    emit: (chunk) => {
      chunks.push(chunk)
      wake?.()
      wake = null
    },
    close: () => {
      closed = true
      wake?.()
      wake = null
    },
  }
}

const textFrame = (text: string) =>
  `data: {"p":"","o":"add","c":0,"v":{"message":{"author":{"role":"assistant"},` +
  `"metadata":{"recipient":"all"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]}}}}\n`

function parse(
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

describe("ChatGptWebTurnSession", () => {
  it("hands a plain answer back as one Anthropic segment", async () => {
    const stream = controllable()
    const session = new ChatGptWebTurnSession({ source: stream.source })
    stream.emit(textFrame("hello"))
    stream.emit("data: [DONE]\n")
    stream.close()

    const frames: string[] = []
    for await (const frame of session.segment()) frames.push(frame)
    const events = parse(frames)
    expect(events[0]!.event).toBe("message_start")
    expect(events.map((e) => e.event)).toContain("content_block_delta")
    expect(events.at(-1)!.event).toBe("message_stop")
    const delta = events.find((e) => e.event === "content_block_delta")!
    expect(delta.data.delta).toMatchObject({
      type: "text_delta",
      text: "hello",
    })
  })

  it("ends the segment at a tool call, because that is where Cursor's turn ends", async () => {
    const stream = controllable()
    const session = new ChatGptWebTurnSession({ source: stream.source })

    // ChatGPT reaches the connector over HTTP, not over the browser stream.
    const pending = session.dispatchTool("read_file", { target_file: "a.ts" })

    const frames: string[] = []
    for await (const frame of session.segment()) frames.push(frame)
    const events = parse(frames)

    const start = events.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as { type?: string })?.type === "tool_use"
    )
    expect(start).toBeDefined()
    expect(start!.data.content_block).toMatchObject({ name: "read_file" })

    const input = events.find(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data.delta as { type?: string })?.type === "input_json_delta"
    )
    expect(
      JSON.parse((input!.data.delta as { partial_json: string }).partial_json)
    ).toEqual({ target_file: "a.ts" })

    const messageDelta = events.find((e) => e.event === "message_delta")!
    expect(messageDelta.data.delta).toMatchObject({ stop_reason: "tool_use" })

    // The MCP request is still waiting: the editor has not answered yet.
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    const toolCallId = (start!.data.content_block as { id: string }).id
    expect(
      session.submitToolResult(toolCallId, {
        content: [{ type: "text", text: "file body" }],
      })
    ).toBe(true)
    await expect(pending).resolves.toMatchObject({
      content: [{ type: "text", text: "file body" }],
    })

    stream.close()
  })

  it("continues the same browser turn on the next segment", async () => {
    const stream = controllable()
    const session = new ChatGptWebTurnSession({ source: stream.source })

    const pending = session.dispatchTool("read_file", {})
    const firstFrames: string[] = []
    for await (const frame of session.segment()) firstFrames.push(frame)
    const toolStart = parse(firstFrames).find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data.content_block as { type?: string })?.type === "tool_use"
    )!
    session.submitToolResult(
      (toolStart.data.content_block as { id: string }).id,
      {
        content: [{ type: "text", text: "ok" }],
      }
    )
    await pending

    // The browser stream was never restarted; its later output belongs to the
    // second Cursor turn.
    stream.emit(textFrame("after the tool"))
    stream.emit("data: [DONE]\n")
    stream.close()

    const frames: string[] = []
    for await (const frame of session.segment()) frames.push(frame)
    const texts = parse(frames)
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data.delta as { text?: string }).text)
    expect(texts.join("")).toContain("after the tool")
  })

  it("rejects a tool the editor never answers", async () => {
    const stream = controllable()
    const session = new ChatGptWebTurnSession({
      source: stream.source,
      toolTimeoutMs: 20,
    })
    const pending = session.dispatchTool("read_file", {})
    await expect(pending).rejects.toThrow(/did not return a result/)
    stream.close()
  })

  it("fails every waiter when the turn is abandoned", async () => {
    const stream = controllable()
    const session = new ChatGptWebTurnSession({ source: stream.source })
    const pending = session.dispatchTool("read_file", {})
    session.abort("client went away")
    // An MCP request left hanging would hold an OpenAI connection open until
    // it timed out on their side, so abandonment has to propagate.
    await expect(pending).rejects.toThrow(/client went away/)
    stream.close()
  })

  it("ignores a result for a tool it is not waiting on", () => {
    const stream = controllable()
    const session = new ChatGptWebTurnSession({ source: stream.source })
    expect(session.submitToolResult("toolu_nope", { content: [] })).toBe(false)
    stream.close()
  })
})
