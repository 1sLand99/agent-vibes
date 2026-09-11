import { McpService } from "./mcp.service"
import {
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_NO_SESSION,
  type JsonRpcFailure,
  type JsonRpcResponse,
  type McpToolProvider,
} from "./mcp-types"

const rpc = (
  method: string,
  params?: Record<string, unknown>,
  id: unknown = 1
) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
})

const err = (r: JsonRpcResponse | null) => (r as JsonRpcFailure).error

function stubProvider(
  overrides: Partial<McpToolProvider> = {}
): McpToolProvider {
  return {
    id: "stub",
    listTools: () => [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    callTool: (name, args) => ({
      content: [
        { type: "text" as const, text: `${name}:${JSON.stringify(args)}` },
      ],
    }),
    ...overrides,
  }
}

describe("McpService", () => {
  let service: McpService

  beforeEach(() => {
    service = new McpService()
  })

  describe("with no session attached", () => {
    it("advertises an empty tool list", async () => {
      const reply = await service.handle(rpc("tools/list"))
      expect(reply).toMatchObject({ result: { tools: [] } })
    })

    it("refuses every tool call", async () => {
      const reply = await service.handle(
        rpc("tools/call", {
          name: "read_file",
          arguments: { path: "/etc/passwd" },
        })
      )
      expect(err(reply).code).toBe(RPC_NO_SESSION)
    })

    it("still completes the handshake so a connector can register", async () => {
      const reply = await service.handle(
        rpc("initialize", { protocolVersion: "2025-03-26" })
      )
      expect(reply).toMatchObject({
        result: {
          protocolVersion: "2025-03-26",
          serverInfo: { name: "agent-vibes" },
        },
      })
    })
  })

  describe("with a session attached", () => {
    beforeEach(() => service.registerProvider(stubProvider()))

    it("lists the session's tools and runs one", async () => {
      const list = await service.handle(rpc("tools/list"))
      expect(list).toMatchObject({ result: { tools: [{ name: "read_file" }] } })

      const call = await service.handle(
        rpc("tools/call", { name: "read_file", arguments: { path: "a.txt" } })
      )
      expect(call).toMatchObject({
        result: {
          content: [{ type: "text", text: 'read_file:{"path":"a.txt"}' }],
        },
      })
    })

    it("refuses a tool the provider never advertised", async () => {
      const reply = await service.handle(
        rpc("tools/call", { name: "run_shell", arguments: { cmd: "rm -rf /" } })
      )
      expect(err(reply).code).toBe(RPC_INVALID_PARAMS)
      expect(err(reply).message).toContain("Unknown tool")
    })

    it("rejects non-object arguments before reaching the provider", async () => {
      const callTool = jest.fn()
      service.unregisterProvider("stub")
      service.registerProvider(stubProvider({ callTool }))
      const reply = await service.handle(
        rpc("tools/call", { name: "read_file", arguments: "not-an-object" })
      )
      expect(err(reply).code).toBe(RPC_INVALID_PARAMS)
      expect(callTool).not.toHaveBeenCalled()
    })

    it("goes inert again once the session detaches", async () => {
      service.unregisterProvider("stub")
      const reply = await service.handle(
        rpc("tools/call", { name: "read_file" })
      )
      expect(err(reply).code).toBe(RPC_NO_SESSION)
    })
  })

  describe("protocol handling", () => {
    it("does not answer notifications", async () => {
      expect(
        await service.handle({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        })
      ).toBeNull()
    })

    it("reports unknown methods on requests", async () => {
      const reply = await service.handle(rpc("tools/delete"))
      expect(err(reply).code).toBe(RPC_METHOD_NOT_FOUND)
    })

    it("rejects non-object messages without throwing", async () => {
      for (const bad of ["string", 42, null, []]) {
        const reply = await service.handle(bad)
        expect(reply).not.toBeNull()
        expect(err(reply)).toBeDefined()
      }
    })

    it("turns a throwing provider into a JSON-RPC error, not a crash", async () => {
      service.registerProvider(
        stubProvider({
          callTool: () => {
            throw new Error("secret internal path /Users/x/.ssh/id_rsa")
          },
        })
      )
      const reply = await service.handle(
        rpc("tools/call", { name: "read_file" })
      )
      expect(err(reply).message).toBe("Internal error")
      expect(JSON.stringify(reply)).not.toContain("id_rsa")
    })
  })
})
