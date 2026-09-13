/** Minimal JSON-RPC 2.0 and MCP shapes used by the bridge's MCP endpoint. */

/** Protocol revision advertised when a client does not pin one. */
export const MCP_PROTOCOL_VERSION = "2025-06-18"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  /** Absent for notifications, which must not be answered. */
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0"
  id: string | number | null
  result: Record<string, unknown>
}

export interface JsonRpcFailure {
  jsonrpc: "2.0"
  id: string | number | null
  error: { code: number; message: string; data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/** JSON-RPC reserved codes, plus the one application code we raise. */
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603
/** No local session is attached, so no tool can run. */
export const RPC_NO_SESSION = -32000

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  content: { type: "text"; text: string }[]
  isError?: boolean
}

/**
 * A source of callable tools.
 *
 * The public endpoint holds no capability itself; everything it can do is
 * contributed by a provider. In the deployed topology the only provider that
 * matters is the one backed by a connected local session, so an unattached
 * relay is inert by construction rather than by policy.
 */
export interface McpToolProvider {
  readonly id: string
  listTools(): Promise<McpTool[]> | McpTool[]
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> | McpToolResult
}

export function rpcSuccess(
  id: string | number | null,
  result: Record<string, unknown>
): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result }
}

export function rpcFailure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  }
}
