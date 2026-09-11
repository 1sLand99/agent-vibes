import { ConfigService } from "@nestjs/config"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { McpWorkspaceAgent } from "./mcp-workspace.agent"

/**
 * These cover the containment rule, which is the only thing standing between
 * a tool call arriving from the internet and the rest of the filesystem.
 */
describe("McpWorkspaceAgent containment", () => {
  let root: string
  let outside: string

  const agentWith = (env: Record<string, string>) => {
    const config = {
      get: (key: string, fallback = "") => env[key] ?? fallback,
    } as unknown as ConfigService
    const agent = new McpWorkspaceAgent(config)
    // Configure without dialing a relay: onModuleInit returns early when
    // MCP_RELAY_URL is unset, so set the fields the tools read directly.
    Object.assign(agent, {
      root,
      writable: env.MCP_WORKSPACE_WRITABLE === "1",
      execEnabled: env.MCP_WORKSPACE_EXEC === "1",
    })
    return agent as unknown as {
      run: (n: string, a: Record<string, unknown>) => Promise<unknown>
      tools: () => { name: string }[]
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ws-"))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-out-"))
    await fs.writeFile(path.join(root, "inside.txt"), "inside", "utf8")
    await fs.mkdir(path.join(root, "sub"), { recursive: true })
    await fs.writeFile(path.join(root, "sub", "deep.txt"), "deep", "utf8")
    await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8")
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  const text = (result: unknown) =>
    (result as { content: { text: string }[] }).content[0]!.text

  it("reads files inside the root, including nested ones", async () => {
    const agent = agentWith({})
    expect(text(await agent.run("read_file", { path: "inside.txt" }))).toBe(
      "inside"
    )
    expect(text(await agent.run("read_file", { path: "sub/deep.txt" }))).toBe(
      "deep"
    )
  })

  it("refuses to climb out with ..", async () => {
    const agent = agentWith({})
    await expect(
      agent.run("read_file", {
        path: "../" + path.basename(outside) + "/secret.txt",
      })
    ).rejects.toThrow(/escapes the workspace root/)
  })

  it("refuses an absolute path outside the root", async () => {
    const agent = agentWith({})
    await expect(
      agent.run("read_file", { path: path.join(outside, "secret.txt") })
    ).rejects.toThrow(/escapes the workspace root/)
  })

  it("refuses a symlink that points out of the root", async () => {
    // The dangerous case: the path itself looks contained, and only resolving
    // the link reveals that it is not.
    await fs.symlink(
      path.join(outside, "secret.txt"),
      path.join(root, "link.txt")
    )
    const agent = agentWith({})
    await expect(agent.run("read_file", { path: "link.txt" })).rejects.toThrow(
      /escapes the workspace root/
    )
  })

  it("refuses a write through a symlinked directory", async () => {
    await fs.symlink(outside, path.join(root, "escape"))
    const agent = agentWith({ MCP_WORKSPACE_WRITABLE: "1" })
    await expect(
      agent.run("write_file", { path: "escape/planted.txt", content: "x" })
    ).rejects.toThrow(/escapes the workspace root/)
    await expect(
      fs.readFile(path.join(outside, "planted.txt"), "utf8")
    ).rejects.toThrow()
  })

  it("allows writing a new file under the root", async () => {
    const agent = agentWith({ MCP_WORKSPACE_WRITABLE: "1" })
    await agent.run("write_file", { path: "fresh/new.txt", content: "hello" })
    expect(await fs.readFile(path.join(root, "fresh", "new.txt"), "utf8")).toBe(
      "hello"
    )
  })

  it("keeps disabled capabilities out of the advertised tool list", () => {
    expect(
      agentWith({})
        .tools()
        .map((t) => t.name)
    ).toEqual(["read_file", "list_directory"])
    expect(
      agentWith({ MCP_WORKSPACE_WRITABLE: "1", MCP_WORKSPACE_EXEC: "1" })
        .tools()
        .map((t) => t.name)
    ).toEqual(["read_file", "list_directory", "write_file", "run_command"])
  })

  it("refuses disabled capabilities even if a call arrives anyway", async () => {
    const agent = agentWith({})
    await expect(
      agent.run("write_file", { path: "a.txt", content: "x" })
    ).rejects.toThrow(/read-only/)
    await expect(agent.run("run_command", { command: "echo" })).rejects.toThrow(
      /disabled/
    )
  })
})
