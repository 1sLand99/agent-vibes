import type { McpTool, McpToolResult } from "./mcp-types"

/**
 * Frames exchanged between a workspace agent and the public MCP relay.
 *
 * The agent dials out to the relay, so the machine holding the workspace
 * never needs an inbound port and the relay never needs to know how to reach
 * it. The relay is the passive half: it forwards calls it receives from an
 * MCP client and waits for the agent to answer.
 */

/** Agent → relay: advertise this session and the tools it can run. */
export interface RelayRegisterFrame {
  readonly type: "register"
  readonly sessionId: string
  readonly label: string
  readonly tools: readonly McpTool[]
}

/** Relay → agent: run one tool. */
export interface RelayCallFrame {
  readonly type: "call"
  readonly callId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** Agent → relay: the outcome of a call. */
export interface RelayResultFrame {
  readonly type: "result"
  readonly callId: string
  readonly result?: McpToolResult
  readonly error?: string
}

/** Either direction: liveness, so a dead peer is noticed before a call is. */
export interface RelayPingFrame {
  readonly type: "ping" | "pong"
}

export type RelayFrame =
  | RelayRegisterFrame
  | RelayCallFrame
  | RelayResultFrame
  | RelayPingFrame

export function parseRelayFrame(raw: string): RelayFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const frame = parsed as { type?: unknown }
  if (typeof frame.type !== "string") return null
  if (!["register", "call", "result", "ping", "pong"].includes(frame.type)) {
    return null
  }
  return parsed as RelayFrame
}
