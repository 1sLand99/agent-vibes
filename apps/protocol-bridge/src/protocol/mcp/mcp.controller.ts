import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  UseGuards,
} from "@nestjs/common"
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger"
import { McpAuthGuard } from "./mcp-auth.guard"
import { McpService } from "./mcp.service"
import {
  RPC_INVALID_REQUEST,
  rpcFailure,
  type JsonRpcResponse,
} from "./mcp-types"

/**
 * Model Context Protocol endpoint (Streamable HTTP).
 *
 * Registered with ChatGPT as a connector, which means OpenAI's fetcher calls
 * it from the public internet. Every request passes McpAuthGuard first, and
 * the service behind it owns no tools of its own — see McpService for why an
 * unattached endpoint is inert.
 *
 * Batches are accepted because the spec allows them; the per-message cap
 * keeps one request from fanning out into unbounded work.
 */

/** Upper bound on messages in a single JSON-RPC batch. */
const MAX_BATCH = 20

@ApiTags("MCP")
@Controller("mcp")
@UseGuards(McpAuthGuard)
@ApiSecurity("api-key")
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "JSON-RPC entry point for MCP clients" })
  async rpc(
    @Body() body: unknown
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (Array.isArray(body)) {
      if (body.length > MAX_BATCH) {
        throw new HttpException(
          rpcFailure(
            null,
            RPC_INVALID_REQUEST,
            `Batch too large: at most ${MAX_BATCH} messages`
          ),
          400
        )
      }
      const replies: JsonRpcResponse[] = []
      for (const message of body) {
        const reply = await this.mcp.handle(message)
        if (reply) replies.push(reply)
      }
      // An all-notification batch gets no body, per JSON-RPC.
      return replies.length ? replies : undefined
    }

    return (await this.mcp.handle(body)) ?? undefined
  }

  /**
   * Liveness for the connector, and a way to see whether a workspace session
   * is attached without disclosing anything about it.
   */
  @Get()
  @ApiOperation({ summary: "MCP endpoint status" })
  status(): Record<string, unknown> {
    return {
      status: "ok",
      transport: "streamable-http",
      sessionAttached: this.mcp.providerCount > 0,
    }
  }
}
