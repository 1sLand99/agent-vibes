import * as fs from "node:fs"
import * as path from "node:path"
import {
  ChatGptWebV1Decoder,
  type ChatGptWebStreamEvent,
} from "./chatgpt-web-v1-stream"

/**
 * The fixture is a real connector-backed turn captured off the wire, so these
 * pin the decoder against the encoding as it actually arrives rather than as
 * documented — there is no specification for it.
 */
const FIXTURE = path.join(
  __dirname,
  "../../../test/fixtures/chatgpt-web-v1-turn.sse"
)

function collect(chunks: string[]): {
  text: string
  reasoning: string
  tools: { tool: string; payload: string }[]
  done: boolean
} {
  const decoder = new ChatGptWebV1Decoder()
  const out = {
    text: "",
    reasoning: "",
    tools: [] as { tool: string; payload: string }[],
    done: false,
  }
  const apply = (event: ChatGptWebStreamEvent) => {
    if (event.kind === "text") out.text += event.delta
    else if (event.kind === "reasoning") out.reasoning += event.delta
    else if (event.kind === "tool_call")
      out.tools.push({ tool: event.tool, payload: event.payload })
    else out.done = true
  }
  for (const chunk of chunks) for (const e of decoder.push(chunk)) apply(e)
  return out
}

describe("ChatGptWebV1Decoder", () => {
  const raw = fs.readFileSync(FIXTURE, "utf8")

  it("reconstructs the assistant's answer from a real turn", () => {
    const { text, done } = collect([raw])
    expect(done).toBe(true)
    expect(text).toContain("工作区根目录")
    expect(text).toContain(".dir   apps")
    expect(text).toContain(".file  package.json")
  })

  it("surfaces the connector tool call", () => {
    const { tools } = collect([raw])
    expect(tools).toHaveLength(1)
    expect(tools[0]!.tool).toBe("api_tool.call_tool")
    expect(tools[0]!.payload).toContain("agent-vibes")
  })

  it("produces the same result when the stream is split mid-frame", () => {
    // Chunk boundaries land wherever the socket decides, so a frame split
    // across two pushes must not be lost — the buffer exists for this.
    const chunked: string[] = []
    for (let i = 0; i < raw.length; i += 137)
      chunked.push(raw.slice(i, i + 137))
    expect(collect(chunked)).toEqual(collect([raw]))
  })

  it("emits each piece of text once as it grows", () => {
    // Every frame carries the whole part, so a decoder that forwarded the
    // value verbatim would repeat the answer several times over.
    const { text } = collect([raw])
    const marker = "工作区根目录"
    expect(text.split(marker)).toHaveLength(2)
  })

  it("ignores control frames and the encoding announcement", () => {
    const decoder = new ChatGptWebV1Decoder()
    expect(decoder.push('data: "v1"\n')).toEqual([])
    expect(
      decoder.push('data: {"type":"title_generation","title":"x"}\n')
    ).toEqual([])
    expect(decoder.push("data: not json\n")).toEqual([])
  })

  it("treats message_stream_complete as the end of the turn", () => {
    const decoder = new ChatGptWebV1Decoder()
    const events = decoder.push(
      'data: {"type":"message_stream_complete","conversation_id":"c"}\n'
    )
    expect(events).toEqual([{ kind: "done" }])
  })

  it("inherits the operation and path when a frame omits them", () => {
    // `{"c":n,"v":…}` with no `o`/`p` means "same operation, next channel";
    // reading it as a no-op loses whole messages.
    const decoder = new ChatGptWebV1Decoder()
    decoder.push(
      'data: {"p":"","o":"add","c":0,"v":{"message":{"author":{"role":"assistant"},' +
        '"metadata":{"recipient":"all"},"content":{"content_type":"text","parts":["first"]}}}}\n'
    )
    const events = decoder.push(
      'data: {"c":1,"v":{"message":{"author":{"role":"assistant"},' +
        '"metadata":{"recipient":"all"},"content":{"content_type":"text","parts":["second"]}}}}\n'
    )
    expect(events).toEqual([{ kind: "text", delta: "second" }])
  })
})
