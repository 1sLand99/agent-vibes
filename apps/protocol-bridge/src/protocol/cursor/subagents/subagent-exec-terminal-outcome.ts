import { fromBinary } from "@bufbuild/protobuf"
import {
  type DeleteResult,
  ExecClientMessageSchema,
  type McpResult,
  type WriteResult,
} from "../../../gen/agent/v1_pb"
import type { SubagentExecProtocol } from "../session/subagent-spawn-request"
import type { SubagentExecRawResult } from "./subagent-exec-bridge.service"

/**
 * Canonical terminal states exposed to a child provider continuation.
 *
 * The frozen child Exec catalog has exactly three terminal message types.
 * This union intentionally does not preserve generic shell/read/search or
 * streamed-shell states: those capabilities have no frozen client owner.
 */
export type SubagentExecTerminalStatus =
  | "success"
  | "rejected"
  | "permission_denied"
  | "error"
  | "no_space"
  | "file_not_found"
  | "not_file"
  | "file_busy"
  | "tool_not_found"
  | "server_not_found"

/** Exact official inner result arm, plus the committed protocol failure. */
export type SubagentExecTerminalResultArm =
  | "success"
  | "rejected"
  | "permissionDenied"
  | "error"
  | "noSpace"
  | "fileNotFound"
  | "notFile"
  | "fileBusy"
  | "toolNotFound"
  | "serverNotFound"
  | "protocolError"

/** The only model-facing terminal representation for a frozen child result. */
export interface SubagentExecTerminalOutcome {
  readonly content: string
  readonly isError: boolean
  readonly status: SubagentExecTerminalStatus
  /** Exact parser wire spelling returned by the Cursor client. */
  readonly resultCase: string
  /** Exact official inner oneof arm, or the explicit protocol failure arm. */
  readonly resultArm: SubagentExecTerminalResultArm
}

export class SubagentExecTerminalOutcomeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = SubagentExecTerminalOutcomeError.name
  }
}

const WIRE_RESULT_CASE_BY_TERMINAL_CASE = {
  writeResult: "write_result",
  deleteResult: "delete_result",
  mcpResult: "mcp_result",
} as const satisfies Record<
  SubagentExecProtocol["terminal"]["resultCase"],
  string
>

const TERMINAL_STATUS_BY_RESULT_ARM: Readonly<
  Record<SubagentExecTerminalResultArm, SubagentExecTerminalStatus>
> = {
  success: "success",
  rejected: "rejected",
  permissionDenied: "permission_denied",
  error: "error",
  noSpace: "no_space",
  fileNotFound: "file_not_found",
  notFile: "not_file",
  fileBusy: "file_busy",
  toolNotFound: "tool_not_found",
  serverNotFound: "server_not_found",
  protocolError: "error",
}

/**
 * Decode one raw child ExecClientMessage and project only the result oneof
 * declared by the persisted owner. A message with a valid global Cursor
 * oneof but the wrong frozen capability pair is a protocol violation, not a
 * usable child tool result.
 */
export function projectSubagentExecTerminalOutcome(
  result: SubagentExecRawResult,
  execProtocol: SubagentExecProtocol
): SubagentExecTerminalOutcome {
  const expected = requireSingleTerminalProtocol(execProtocol)
  if (!Buffer.isBuffer(result.resultData) || result.resultData.length === 0) {
    throw new SubagentExecTerminalOutcomeError(
      `Sub-agent exec result ${result.resultCase} has no protobuf payload`
    )
  }

  if (result.resultCase !== expected.wireResultCase) {
    throw new SubagentExecTerminalOutcomeError(
      `Sub-agent exec result case does not match its frozen protocol: ` +
        `declared=${result.resultCase} expected=${expected.wireResultCase}`
    )
  }

  let message: ReturnType<typeof fromBinary<typeof ExecClientMessageSchema>>
  try {
    message = fromBinary(ExecClientMessageSchema, result.resultData)
  } catch (error) {
    throw new SubagentExecTerminalOutcomeError(
      `Cannot decode sub-agent exec result ${result.resultCase}: ${formatError(error)}`
    )
  }

  if (message.message.case !== expected.resultCase) {
    throw new SubagentExecTerminalOutcomeError(
      `Sub-agent exec result case mismatch: declared=${result.resultCase} decoded=${
        message.message.case || "empty"
      } expected=${expected.resultCase}`
    )
  }

  switch (message.message.case) {
    case "writeResult":
      return projectWriteResult(result.resultCase, message.message.value)
    case "deleteResult":
      return projectDeleteResult(result.resultCase, message.message.value)
    case "mcpResult":
      return projectMcpResult(result.resultCase, message.message.value)
    default:
      throw new SubagentExecTerminalOutcomeError(
        `Unsupported frozen sub-agent exec result payload ${readUnknownOneofCase(message.message)}`
      )
  }
}

/**
 * A malformed client terminal becomes one durable graph outcome. The caller
 * commits this value in the same transaction as the frozen tool result, so a
 * waiter cannot resume on an uncommitted or ambiguous protocol failure.
 */
export function projectSubagentExecProtocolFailureOutcome(
  result: Pick<SubagentExecRawResult, "resultCase">,
  error: SubagentExecTerminalOutcomeError
): SubagentExecTerminalOutcome {
  return createTerminalOutcome(
    result.resultCase,
    "protocolError",
    "error",
    `[sub-agent exec protocol error] ${error.message}`
  )
}

/** Project Cursor's control-channel throw as the child's real error terminal. */
export function projectSubagentExecThrowOutcome(input: {
  readonly reason: string
  readonly stack: string
}): SubagentExecTerminalOutcome {
  const reason =
    input.reason.trim().slice(0, 800) || "execution aborted by client"
  const stack = input.stack.trim().slice(0, 2000)
  const content = stack
    ? `[client execution aborted] ${reason}\nstack: ${stack}`
    : `[client execution aborted] ${reason}`
  return createTerminalOutcome("exec_throw", "protocolError", "error", content)
}

function requireSingleTerminalProtocol(execProtocol: SubagentExecProtocol): {
  readonly resultCase: SubagentExecProtocol["terminal"]["resultCase"]
  readonly wireResultCase: string
} {
  const candidate = execProtocol as unknown
  if (!candidate || typeof candidate !== "object") {
    throw new SubagentExecTerminalOutcomeError(
      "Frozen sub-agent exec protocol is missing"
    )
  }
  const record = candidate as {
    requestCase?: unknown
    terminal?: { transport?: unknown; resultCase?: unknown }
  }
  if (record.terminal?.transport !== "single") {
    throw new SubagentExecTerminalOutcomeError(
      "Frozen sub-agent exec protocol does not declare a single terminal transport"
    )
  }

  switch (record.requestCase) {
    case "writeArgs":
      if (record.terminal.resultCase === "writeResult") {
        return {
          resultCase: "writeResult",
          wireResultCase: WIRE_RESULT_CASE_BY_TERMINAL_CASE.writeResult,
        }
      }
      break
    case "deleteArgs":
      if (record.terminal.resultCase === "deleteResult") {
        return {
          resultCase: "deleteResult",
          wireResultCase: WIRE_RESULT_CASE_BY_TERMINAL_CASE.deleteResult,
        }
      }
      break
    case "mcpArgs":
      if (record.terminal.resultCase === "mcpResult") {
        return {
          resultCase: "mcpResult",
          wireResultCase: WIRE_RESULT_CASE_BY_TERMINAL_CASE.mcpResult,
        }
      }
      break
  }
  throw new SubagentExecTerminalOutcomeError(
    "Frozen sub-agent exec protocol has an unsupported request/terminal pair"
  )
}

function projectWriteResult(
  resultCase: string,
  result: WriteResult
): SubagentExecTerminalOutcome {
  switch (result.result.case) {
    case "success": {
      const value = result.result.value
      const content =
        value.fileContentAfterWrite !== undefined
          ? value.fileContentAfterWrite
          : `File written successfully: ${value.path || "(unnamed path)"} (${value.linesCreated} lines, ${value.fileSize} bytes)`
      return createTerminalOutcome(resultCase, "success", "success", content)
    }
    case "permissionDenied":
      return createTerminalOutcome(
        resultCase,
        "permissionDenied",
        "permission_denied",
        `[write permission denied]${
          result.result.value.error || result.result.value.path
            ? ` ${result.result.value.error || result.result.value.path}`
            : ""
        }`
      )
    case "noSpace":
      return createTerminalOutcome(
        resultCase,
        "noSpace",
        "no_space",
        `[write error] No space left on device${
          result.result.value.path ? `: ${result.result.value.path}` : ""
        }`
      )
    case "error":
      return createTerminalOutcome(
        resultCase,
        "error",
        "error",
        `[write error]${result.result.value.error ? ` ${result.result.value.error}` : ""}`
      )
    case "rejected":
      return createTerminalOutcome(
        resultCase,
        "rejected",
        "rejected",
        `[write rejected]${result.result.value.reason ? ` ${result.result.value.reason}` : ""}`
      )
    case undefined:
      throw missingResultArm("writeResult")
    default:
      throw unsupportedResultArm(
        "writeResult",
        readUnknownOneofCase(result.result)
      )
  }
}

function projectDeleteResult(
  resultCase: string,
  result: DeleteResult
): SubagentExecTerminalOutcome {
  switch (result.result.case) {
    case "success": {
      const value = result.result.value
      const content =
        value.prevContent ||
        `File deleted successfully: ${
          value.deletedFile || value.path || "(unnamed path)"
        } (${value.fileSize} bytes)`
      return createTerminalOutcome(resultCase, "success", "success", content)
    }
    case "fileNotFound":
      return createTerminalOutcome(
        resultCase,
        "fileNotFound",
        "file_not_found",
        `[delete error] File not found${
          result.result.value.path ? `: ${result.result.value.path}` : ""
        }`
      )
    case "notFile":
      return createTerminalOutcome(
        resultCase,
        "notFile",
        "not_file",
        `[delete error] Not a file${
          result.result.value.path ? `: ${result.result.value.path}` : ""
        }`
      )
    case "permissionDenied":
      return createTerminalOutcome(
        resultCase,
        "permissionDenied",
        "permission_denied",
        `[delete permission denied]${
          result.result.value.path ? ` ${result.result.value.path}` : ""
        }`
      )
    case "fileBusy":
      return createTerminalOutcome(
        resultCase,
        "fileBusy",
        "file_busy",
        `[delete error] File busy${
          result.result.value.path ? `: ${result.result.value.path}` : ""
        }`
      )
    case "rejected":
      return createTerminalOutcome(
        resultCase,
        "rejected",
        "rejected",
        `[delete rejected]${result.result.value.reason ? ` ${result.result.value.reason}` : ""}`
      )
    case "error":
      return createTerminalOutcome(
        resultCase,
        "error",
        "error",
        `[delete error]${result.result.value.error ? ` ${result.result.value.error}` : ""}`
      )
    case undefined:
      throw missingResultArm("deleteResult")
    default:
      throw unsupportedResultArm(
        "deleteResult",
        readUnknownOneofCase(result.result)
      )
  }
}

function projectMcpResult(
  resultCase: string,
  result: McpResult
): SubagentExecTerminalOutcome {
  switch (result.result.case) {
    case "success": {
      const content: string[] = []
      const success = result.result.value
      for (const item of success.content) {
        switch (item.content.case) {
          case "text":
            content.push(item.content.value.text)
            break
          case "image":
            content.push(
              `[mcp image] ${
                item.content.value.mimeType || "application/octet-stream"
              } ${item.content.value.data.length} bytes`
            )
            break
          case undefined:
            throw new SubagentExecTerminalOutcomeError(
              "MCP success contains an empty content arm"
            )
          default:
            throw unsupportedResultArm(
              "mcpResult.success.content",
              readUnknownOneofCase(item.content)
            )
        }
      }
      return createMcpSuccessTerminalOutcome(
        resultCase,
        content.length > 0 ? content.join("\n") : "[mcp success] (no content)",
        success.isError
      )
    }
    case "error":
      return createTerminalOutcome(
        resultCase,
        "error",
        "error",
        `[mcp error]${result.result.value.error ? ` ${result.result.value.error}` : ""}`
      )
    case "rejected":
      return createTerminalOutcome(
        resultCase,
        "rejected",
        "rejected",
        `[mcp rejected]${result.result.value.reason ? ` ${result.result.value.reason}` : ""}`
      )
    case "permissionDenied":
      return createTerminalOutcome(
        resultCase,
        "permissionDenied",
        "permission_denied",
        `[mcp permission denied]${
          result.result.value.error ? ` ${result.result.value.error}` : ""
        }`
      )
    case "toolNotFound":
      return createTerminalOutcome(
        resultCase,
        "toolNotFound",
        "tool_not_found",
        `[mcp tool not found]${
          result.result.value.name ? ` ${result.result.value.name}` : ""
        }`
      )
    case "serverNotFound":
      return createTerminalOutcome(
        resultCase,
        "serverNotFound",
        "server_not_found",
        `[mcp server not found]${
          result.result.value.name ? ` ${result.result.value.name}` : ""
        }`
      )
    case "approved":
      throw new SubagentExecTerminalOutcomeError(
        "MCP approval acknowledgement is not a terminal result for a frozen sub-agent capability"
      )
    case undefined:
      throw missingResultArm("mcpResult")
    default:
      throw unsupportedResultArm(
        "mcpResult",
        readUnknownOneofCase(result.result)
      )
  }
}

function createTerminalOutcome(
  resultCase: string,
  resultArm: SubagentExecTerminalResultArm,
  status: SubagentExecTerminalStatus,
  content: string
): SubagentExecTerminalOutcome {
  const canonicalStatus = TERMINAL_STATUS_BY_RESULT_ARM[resultArm]
  if (status !== canonicalStatus) {
    throw new SubagentExecTerminalOutcomeError(
      `Sub-agent terminal arm ${resultArm} cannot be projected as ${status}`
    )
  }
  return {
    content,
    isError: canonicalStatus !== "success",
    status: canonicalStatus,
    resultCase,
    resultArm,
  }
}

function createMcpSuccessTerminalOutcome(
  resultCase: string,
  content: string,
  isToolError: boolean
): SubagentExecTerminalOutcome {
  return {
    content,
    isError: isToolError,
    status: isToolError ? "error" : "success",
    resultCase,
    resultArm: "success",
  }
}

function missingResultArm(kind: string): SubagentExecTerminalOutcomeError {
  return new SubagentExecTerminalOutcomeError(
    `Sub-agent ${kind} has no terminal result arm`
  )
}

function unsupportedResultArm(
  kind: string,
  arm: string
): SubagentExecTerminalOutcomeError {
  return new SubagentExecTerminalOutcomeError(
    `Sub-agent ${kind} has unsupported terminal result arm ${arm}`
  )
}

function readUnknownOneofCase(value: unknown): string {
  if (!value || typeof value !== "object" || !("case" in value)) {
    return "empty"
  }
  const oneofCase = (value as { case?: unknown }).case
  return typeof oneofCase === "string" ? oneofCase : "empty"
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
