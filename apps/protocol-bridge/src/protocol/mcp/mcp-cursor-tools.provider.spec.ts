import { McpCursorToolsProvider } from "./mcp-cursor-tools.provider"
import { McpService } from "./mcp.service"
import type { McpToolResult } from "./mcp-types"

describe("McpCursorToolsProvider", () => {
  let provider: McpCursorToolsProvider

  beforeEach(() => {
    provider = new McpCursorToolsProvider(new McpService())
  })

  it("advertises Cursor's own tools under their own names", () => {
    // The point of this provider is that nothing is translated: the model has
    // to ask for the tool the editor already implements, by that exact name.
    const names = provider.listTools().map((tool) => tool.name)
    expect(names).toContain("read_file")
    expect(names).toContain("edit_file_v2")
    expect(names).toContain("grep_search")
    expect(names.length).toBeGreaterThan(40)
  })

  it("passes each schema through as MCP expects it", () => {
    const readFile = provider.listTools().find((t) => t.name === "read_file")
    expect(readFile).toBeDefined()
    expect(readFile!.inputSchema).toMatchObject({ type: "object" })
    expect(readFile!.description.length).toBeGreaterThan(10)
  })

  describe("with no editor attached", () => {
    it("knows the tools even before a session claims them", () => {
      // listTools stays pure; what changes with a sink is whether the endpoint
      // advertises them at all.
      expect(provider.attached).toBe(false)
      expect(provider.listTools().length).toBeGreaterThan(0)
    })

    it("only advertises them on the endpoint while a sink is attached", () => {
      const mcp = new McpService()
      const scoped = new McpCursorToolsProvider(mcp)
      expect(mcp.providerCount).toBe(0)
      const detach = scoped.attach({
        dispatch: () => Promise.resolve({ content: [] }),
      })
      expect(mcp.providerCount).toBe(1)
      detach()
      expect(mcp.providerCount).toBe(0)
    })

    it("refuses to run one, and says why", async () => {
      const result = await provider.callTool("read_file", { target_file: "a" })
      expect(result.isError).toBe(true)
      // A vague failure reads to a model like "the file is missing", which
      // sends it down a debugging path that has nothing to do with the cause.
      expect(result.content[0]!.text).toContain("No editor session")
    })
  })

  describe("with an editor attached", () => {
    it("hands the call to the sink untouched", async () => {
      const seen: { name: string; args: Record<string, unknown> }[] = []
      provider.attach({
        dispatch: (name, args): Promise<McpToolResult> => {
          seen.push({ name, args })
          return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
        },
      })
      const result = await provider.callTool("read_file", {
        target_file: "a.ts",
      })
      expect(seen).toEqual([
        { name: "read_file", args: { target_file: "a.ts" } },
      ])
      expect(result.content[0]!.text).toBe("ok")
    })

    it("goes back to refusing once the turn releases it", async () => {
      const detach = provider.attach({
        dispatch: () =>
          Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
      })
      expect(provider.attached).toBe(true)
      detach()
      expect(provider.attached).toBe(false)
      const result = await provider.callTool("read_file", {})
      expect(result.isError).toBe(true)
    })

    it("ignores a detach from a sink that was already replaced", async () => {
      // Two turns overlapping must not let the older one's cleanup strip the
      // newer one's sink.
      const detachFirst = provider.attach({
        dispatch: () =>
          Promise.resolve({ content: [{ type: "text", text: "first" }] }),
      })
      provider.attach({
        dispatch: () =>
          Promise.resolve({ content: [{ type: "text", text: "second" }] }),
      })
      detachFirst()
      expect(provider.attached).toBe(true)
      const result = await provider.callTool("read_file", {})
      expect(result.content[0]!.text).toBe("second")
    })
  })
})
