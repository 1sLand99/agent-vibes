import { Injectable, Logger } from "@nestjs/common"
import {
  getDefaultAgentToolNames,
  getFrozenCursorToolDefinition,
  resolveCursorToolDefinitionKey,
} from "../cursor/tools/cursor-tool-mapper"
import { McpService } from "./mcp.service"
import type { McpTool, McpToolProvider, McpToolResult } from "./mcp-types"

/**
 * Offers Cursor's own tool set over MCP.
 *
 * This is the piece that lets a Cursor turn run on ChatGPT Web. The web model
 * ignores the `tools` field entirely, so the only channel it will call through
 * is a connector — and a connector is MCP. Advertising Cursor's tools here
 * means the model asks for `read_file` or `edit_file` by the same name and
 * schema the IDE already implements, and the call can be handed straight to
 * the editor rather than reimplemented.
 *
 * Cursor's definitions already carry a name, a description and a JSON schema,
 * which is exactly an MCP tool, so nothing is translated — they are passed
 * through.
 *
 * Two things read this provider, and they ask different questions:
 *
 *   - `listTools` is the manifest, and it does not depend on a sink. The relay
 *     agent sends it once per connection because a ChatGPT connector discovers
 *     tools when it is registered and can never refresh them.
 *   - Registration with McpService is scoped to an attached sink, so the local
 *     endpoint advertises a tool only while something can actually run it.
 *     A deployment with no editor — the public relay host runs this same
 *     binary — therefore offers nothing of its own and serves only what an
 *     attached editor session brought.
 */

export interface CursorToolSink {
  /**
   * Hand one tool call to the editor and resolve with its result.
   *
   * Implemented by the Cursor stream side, which knows which turn is waiting
   * for tool calls and how to project one into it.
   */
  dispatch(name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

@Injectable()
export class McpCursorToolsProvider implements McpToolProvider {
  private readonly logger = new Logger(McpCursorToolsProvider.name)
  readonly id = "cursor"
  private sink: CursorToolSink | null = null
  private cached: McpTool[] | null = null

  constructor(private readonly mcp: McpService) {}

  /**
   * Attach the editor. Returns a function that detaches it, so a turn can
   * claim the tools for its lifetime and give them back when it ends.
   */
  attach(sink: CursorToolSink): () => void {
    this.sink = sink
    this.mcp.registerProvider(this)
    this.logger.warn("Cursor tool sink attached")
    return () => {
      if (this.sink !== sink) return
      this.sink = null
      this.mcp.unregisterProvider(this.id)
      this.logger.warn("Cursor tool sink detached")
    }
  }

  get attached(): boolean {
    return this.sink !== null
  }

  listTools(): McpTool[] {
    if (this.cached) return this.cached
    const tools: McpTool[] = []
    for (const toolName of getDefaultAgentToolNames()) {
      const key = resolveCursorToolDefinitionKey(toolName)
      if (!key) continue
      const definition = getFrozenCursorToolDefinition(key)
      if (!definition.name || !definition.inputSchema) continue
      tools.push({
        name: definition.name,
        description: definition.description || definition.name,
        inputSchema: definition.inputSchema,
      })
    }
    this.cached = tools
    return tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const sink = this.sink
    if (!sink) {
      // Advertised but not runnable: say so plainly rather than failing in a
      // way the model would read as "the file does not exist".
      return {
        content: [
          {
            type: "text",
            text:
              "No editor session is attached to this endpoint, so this tool " +
              "cannot run right now.",
          },
        ],
        isError: true,
      }
    }
    return sink.dispatch(name, args)
  }
}
