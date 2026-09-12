import type { ConfigService } from "@nestjs/config"
import { McpCursorToolsProvider } from "./mcp-cursor-tools.provider"
import { McpRelayAgent } from "./mcp-relay.agent"
import { McpService } from "./mcp.service"

/**
 * The agent runs nothing. These pin that a call travels to the editor and its
 * answer travels back, and that the "no editor attached" case comes back as an
 * answer rather than a dropped frame.
 */

const config = { get: (_: string, fallback = "") => fallback } as ConfigService

function harness() {
  const provider = new McpCursorToolsProvider(new McpService())
  const agent = new McpRelayAgent(config, provider)
  const sent: Record<string, unknown>[] = []
  const ws = {
    send: (raw: string) =>
      sent.push(JSON.parse(raw) as Record<string, unknown>),
  }
  const deliver = (frame: unknown) =>
    (
      agent as unknown as {
        onMessage: (ws: unknown, raw: string) => Promise<void>
      }
    ).onMessage(ws, JSON.stringify(frame))
  return { provider, deliver, sent }
}

describe("McpRelayAgent", () => {
  it("hands a call to the editor and sends back what it answered", async () => {
    const { provider, deliver, sent } = harness()
    const seen: { name: string; args: Record<string, unknown> }[] = []
    provider.attach({
      dispatch: (name, args) => {
        seen.push({ name, args })
        return Promise.resolve({ content: [{ type: "text", text: "done" }] })
      },
    })

    await deliver({
      type: "call",
      callId: "c1",
      name: "edit_file_v2",
      arguments: { target_file: "a.ts" },
    })

    expect(seen).toEqual([
      { name: "edit_file_v2", args: { target_file: "a.ts" } },
    ])
    expect(sent).toEqual([
      {
        type: "result",
        callId: "c1",
        result: { content: [{ type: "text", text: "done" }] },
      },
    ])
  })

  it("answers rather than going silent when no editor is attached", async () => {
    // The relay is holding a ChatGPT connector open on the other end; a frame
    // that never comes back strands it until the call times out.
    const { deliver, sent } = harness()
    await deliver({ type: "call", callId: "c2", name: "read_file" })

    expect(sent).toHaveLength(1)
    const result = sent[0] as {
      callId: string
      result: { isError?: boolean; content: { text: string }[] }
    }
    expect(result.callId).toBe("c2")
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0]!.text).toContain("No editor session")
  })

  it("treats missing arguments as an empty object", async () => {
    const { provider, deliver } = harness()
    let seen: Record<string, unknown> | null = null
    provider.attach({
      dispatch: (_name, args) => {
        seen = args
        return Promise.resolve({ content: [] })
      },
    })
    await deliver({ type: "call", callId: "c3", name: "read_file" })
    expect(seen).toEqual({})
  })

  it("keeps the socket alive", async () => {
    const { deliver, sent } = harness()
    await deliver({ type: "ping" })
    expect(sent).toEqual([{ type: "pong" }])
  })

  it("ignores anything that is not a call", async () => {
    const { deliver, sent } = harness()
    await deliver({ type: "call" })
    await deliver({ type: "register", tools: [] })
    await deliver({ nonsense: true })
    expect(sent).toEqual([])
  })
})
