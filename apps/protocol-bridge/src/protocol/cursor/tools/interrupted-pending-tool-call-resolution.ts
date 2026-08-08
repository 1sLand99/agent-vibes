import { toJson } from "@bufbuild/protobuf"
import { createHash } from "node:crypto"

import {
  ConversationStepSchema,
  InterruptedPendingToolCallResolutionSchema,
  SandboxPolicySchema,
  type ShellResult,
  ShellResultSchema,
  type TaskResult,
} from "../../../gen/agent/v1_pb"
import type { CursorInterruptedPendingToolCallResolutionWire } from "../codec/cursor-conversation-codec"

/**
 * Terminal states that are representable by Cursor's regular tool-result
 * lifecycle. Keep this local instead of importing the stream service so this
 * projector stays independently testable and cannot acquire a runtime
 * dependency on the connection loop.
 */
export type InterruptedToolResultStatus =
  | "success"
  | "failure"
  | "error"
  | "rejected"
  | "timeout"
  | "permission_denied"
  | "spawn_error"
  | "sandbox_unsupported"

export interface InterruptedShellResultMetadata {
  command?: string
  workingDirectory?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  signal?: string
  executionTime?: number
  shellId?: number
  pid?: number
  msToWait?: number
  terminalsFolder?: string
  backgroundReason?: number
  isBackground?: boolean
  aborted?: boolean
  abortReason?: number
  localExecutionTimeMs?: number
  interleavedOutput?: string
  outputHead?: string
  outputTail?: string
  elidedChars?: number
  outputLocation?: {
    filePath?: string
    sizeBytes?: bigint | number
    lineCount?: bigint | number
  }
  timeoutMs?: number
  isReadonly?: boolean
  terminalMessage?: string
  requestedSandboxPolicy?: Record<string, unknown> | null
}

export interface InterruptedTaskSuccessProjection {
  conversationSteps: Array<Record<string, unknown>>
  agentId?: string
  isBackground: boolean
  durationMs?: bigint
  resultSuffix?: string
  backgroundReason: number
  transcriptPath?: string
}

export interface ProjectedInterruptedPendingToolCallResolution {
  toolCallId: string
  source: CursorInterruptedPendingToolCallResolutionWire["source"]
  /** Typed protobuf decoded from the same exact `resolutionBytes`. */
  typed: CursorInterruptedPendingToolCallResolutionWire["typed"]
  resolutionCase: "shellResult" | "taskResult"
  /** Exact repeated-message payload from the inbound protobuf container. */
  resolutionBytes: Uint8Array
  /** Exact interrupted_pending_tool_call_resolutions message bytes. */
  containerBytes: Uint8Array
  content: string
  state: {
    status: InterruptedToolResultStatus
    message?: string
  }
  shellResult?: InterruptedShellResultMetadata
  taskSuccess?: InterruptedTaskSuccessProjection
  /** Present for the TaskResult.error oneof even when the error string is empty. */
  taskError?: string
}

type ProjectedInterruptedPendingToolCallResolutionBase = Omit<
  ProjectedInterruptedPendingToolCallResolution,
  "typed"
>

/**
 * Stable pointer into CursorWireStore. This contains only the wire-row key;
 * raw protocol bytes deliberately have one durable owner in that store.
 */
export interface InterruptedResolutionWireFrameLocator {
  streamEpoch: string
  seq: number
  direction: "inbound" | "outbound"
  frameKind: string
}

/**
 * Graph-safe audit projection for an official terminal resolution. Hashes and
 * lengths let diagnostics verify the typed projection against CursorWireStore
 * without duplicating opaque protobuf bytes in session_messages.metadata_json.
 */
export function buildInterruptedResolutionGraphMetadata(
  resolution: ProjectedInterruptedPendingToolCallResolution,
  wireFrame?: InterruptedResolutionWireFrameLocator
): Record<string, unknown> {
  const digest = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex")
  return {
    cursorInterruptedPendingToolCallResolution: {
      source: resolution.source,
      toolCallId: resolution.toolCallId,
      resolutionCase: resolution.resolutionCase,
      typed: toJson(
        InterruptedPendingToolCallResolutionSchema,
        resolution.typed
      ),
      resolutionBytes: {
        sha256: digest(resolution.resolutionBytes),
        byteLength: resolution.resolutionBytes.byteLength,
      },
      containerBytes: {
        sha256: digest(resolution.containerBytes),
        byteLength: resolution.containerBytes.byteLength,
      },
      ...(wireFrame
        ? {
            wireFrame: {
              streamEpoch: wireFrame.streamEpoch,
              seq: wireFrame.seq,
              direction: wireFrame.direction,
              frameKind: wireFrame.frameKind,
            },
          }
        : {}),
    },
  }
}

export type InterruptedResolutionTargetKind = "shell" | "task"

export interface InterruptedResolutionTarget {
  /** Must be the unmodified protocol tool_call_id. */
  toolCallId: string
  toolName: string
  /**
   * Established by the caller from durable dispatch/graph ownership. This
   * matcher intentionally does not infer a family from a display name.
   */
  kind: InterruptedResolutionTargetKind
  /**
   * `recovered_sidechain` is an interrupted worker's inner edge. It remains
   * a runtime-owned terminal route, but must commit only to its original
   * sidechain rather than the main-graph ledger-only batch.
   */
  source: "pending" | "ledger" | "recovered_sidechain"
}

export interface MatchedInterruptedPendingToolCallResolution {
  target: InterruptedResolutionTarget
  resolution: ProjectedInterruptedPendingToolCallResolution
}

export interface InterruptedResolutionMatchResult {
  matched: MatchedInterruptedPendingToolCallResolution[]
  /** Exact IDs that are valid official records but do not name an open target. */
  unconsumed: Array<{
    toolCallId: string
    reason: "unknown_target"
  }>
}

/** A malformed resolution frame never gets a best-effort partial settle. */
export class InterruptedPendingToolCallResolutionProtocolError extends Error {
  constructor(message: string) {
    super(`Interrupted pending tool call resolution protocol error: ${message}`)
  }
}

function shellContent(
  stdout: string,
  stderr: string,
  shell: ShellResult,
  truncated?: {
    outputHead?: string
    outputTail?: string
    elidedChars?: number
  }
): string {
  const lines: string[] = []
  if (stdout) lines.push(stdout)
  if (stderr) lines.push(`[stderr] ${stderr}`)
  if (lines.length === 0 && (truncated?.outputHead || truncated?.outputTail)) {
    if (truncated.outputHead) lines.push(truncated.outputHead)
    lines.push(
      `[... ${truncated.elidedChars ?? "unknown"} characters omitted ...]`
    )
    if (truncated.outputTail) lines.push(truncated.outputTail)
  }
  if (lines.length > 0) return lines.join("\n")

  // Empty output is not permission to invent a prose result. Keep the
  // protocol's complete typed result visible to the model instead.
  return JSON.stringify({
    shell_result: toJson(ShellResultSchema, shell),
  })
}

function projectShellResult(
  wire: CursorInterruptedPendingToolCallResolutionWire,
  shell: ShellResult
): ProjectedInterruptedPendingToolCallResolutionBase | undefined {
  const rootMetadata = {
    requestedSandboxPolicy: shell.sandboxPolicy
      ? (toJson(SandboxPolicySchema, shell.sandboxPolicy) as Record<
          string,
          unknown
        >)
      : undefined,
    isBackground: shell.isBackground,
    terminalsFolder: shell.terminalsFolder,
    pid: shell.pid,
  }

  switch (shell.result.case) {
    case "success": {
      const value = shell.result.value
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "shellResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: shellContent(value.stdout, value.stderr, shell, value),
        state: { status: "success" },
        shellResult: {
          ...rootMetadata,
          command: value.command,
          workingDirectory: value.workingDirectory,
          stdout: value.stdout,
          stderr: value.stderr,
          exitCode: value.exitCode,
          signal: value.signal,
          executionTime: value.executionTime,
          outputLocation: value.outputLocation,
          shellId: value.shellId,
          interleavedOutput: value.interleavedOutput,
          pid: value.pid ?? rootMetadata.pid,
          msToWait: value.msToWait,
          localExecutionTimeMs: value.localExecutionTimeMs,
          backgroundReason: value.backgroundReason,
          outputHead: value.outputHead,
          outputTail: value.outputTail,
          elidedChars: value.elidedChars,
        },
      }
    }
    case "failure": {
      const value = shell.result.value
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "shellResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: shellContent(value.stdout, value.stderr, shell, value),
        state: { status: "failure" },
        shellResult: {
          ...rootMetadata,
          command: value.command,
          workingDirectory: value.workingDirectory,
          stdout: value.stdout,
          stderr: value.stderr,
          exitCode: value.exitCode,
          signal: value.signal,
          executionTime: value.executionTime,
          outputLocation: value.outputLocation,
          interleavedOutput: value.interleavedOutput,
          abortReason: value.abortReason,
          aborted: value.aborted,
          localExecutionTimeMs: value.localExecutionTimeMs,
          outputHead: value.outputHead,
          outputTail: value.outputTail,
          elidedChars: value.elidedChars,
        },
      }
    }
    case "timeout": {
      const value = shell.result.value
      const message = `command timed out after ${value.timeoutMs}ms`
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "shellResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: shellContent("", "", shell),
        state: { status: "timeout", message },
        shellResult: {
          ...rootMetadata,
          command: value.command,
          workingDirectory: value.workingDirectory,
          timeoutMs: value.timeoutMs,
        },
      }
    }
    case "rejected": {
      const value = shell.result.value
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "shellResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: shellContent("", "", shell),
        state: { status: "rejected", message: value.reason || undefined },
        shellResult: {
          ...rootMetadata,
          command: value.command,
          workingDirectory: value.workingDirectory,
          isReadonly: value.isReadonly,
          terminalMessage: value.reason,
        },
      }
    }
    case "spawnError": {
      const value = shell.result.value
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "shellResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: shellContent("", "", shell),
        state: { status: "spawn_error", message: value.error || undefined },
        shellResult: {
          ...rootMetadata,
          command: value.command,
          workingDirectory: value.workingDirectory,
          terminalMessage: value.error,
        },
      }
    }
    case "permissionDenied": {
      const value = shell.result.value
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "shellResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: shellContent("", "", shell),
        state: {
          status: "permission_denied",
          message: value.error || undefined,
        },
        shellResult: {
          ...rootMetadata,
          command: value.command,
          workingDirectory: value.workingDirectory,
          isReadonly: value.isReadonly,
          terminalMessage: value.error,
        },
      }
    }
    case undefined:
      return undefined
  }
}

function projectTaskResult(
  wire: CursorInterruptedPendingToolCallResolutionWire,
  task: TaskResult
): ProjectedInterruptedPendingToolCallResolutionBase | undefined {
  switch (task.result.case) {
    case "success": {
      const value = task.result.value
      const taskSuccess: InterruptedTaskSuccessProjection = {
        conversationSteps: value.conversationSteps.map(
          (step) =>
            toJson(ConversationStepSchema, step) as Record<string, unknown>
        ),
        agentId: value.agentId,
        isBackground: value.isBackground,
        durationMs: value.durationMs,
        resultSuffix: value.resultSuffix,
        backgroundReason: value.backgroundReason,
        transcriptPath: value.transcriptPath,
      }
      const assistantOutputs = value.conversationSteps
        .filter(
          (step) =>
            step.message.case === "assistantMessage" &&
            step.message.value.text.length > 0
        )
        .map((step) =>
          step.message.case === "assistantMessage"
            ? step.message.value.text
            : ""
        )
        .filter(Boolean)
      // TaskSuccess carries Cursor UI fields as well as assistant steps. Only
      // assistant output is semantic model content; resultSuffix and
      // transcriptPath remain in the structured UI projection below.
      const content =
        assistantOutputs.length > 0
          ? assistantOutputs.join("\n")
          : value.isBackground
            ? `[task success] background sub-agent${value.agentId ? ` ${value.agentId}` : ""} started`
            : `[task success] sub-agent${value.agentId ? ` ${value.agentId}` : ""} completed`

      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "taskResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content,
        state: { status: "success" },
        taskSuccess,
      }
    }
    case "error": {
      const error = task.result.value.error
      return {
        toolCallId: wire.typed.toolCallId,
        source: wire.source,
        resolutionCase: "taskResult",
        resolutionBytes: Uint8Array.from(wire.resolutionBytes),
        containerBytes: Uint8Array.from(wire.containerBytes),
        content: error
          ? `[task error] ${error}`
          : JSON.stringify({ task_result: { error: "" } }),
        state: { status: "error", message: error || undefined },
        taskError: error,
      }
    }
    case undefined:
      return undefined
  }
}

/**
 * Convert only complete official resolution oneofs. An absent or future oneof
 * is intentionally not projected: callers must leave its pending call for
 * their explicit abort path instead of manufacturing a terminal result.
 */
export function projectInterruptedPendingToolCallResolution(
  wire: CursorInterruptedPendingToolCallResolutionWire
): ProjectedInterruptedPendingToolCallResolution | undefined {
  const projected = (() => {
    switch (wire.typed.resolution.case) {
      case "shellResult":
        return projectShellResult(wire, wire.typed.resolution.value)
      case "taskResult":
        return projectTaskResult(wire, wire.typed.resolution.value)
      case undefined:
        return undefined
    }
  })()
  return projected
    ? {
        ...projected,
        typed: wire.typed,
      }
    : undefined
}

/**
 * Match only an exact `tool_call_id`, and only once. There is intentionally no
 * order-, name-, or "last pending" fallback. A malformed resolution frame is
 * rejected as a whole so it cannot partially settle an arbitrary subset.
 */
export function matchInterruptedPendingToolCallResolutions(
  wires: readonly CursorInterruptedPendingToolCallResolutionWire[],
  targets: readonly InterruptedResolutionTarget[]
): InterruptedResolutionMatchResult {
  const resolutionCounts = new Map<string, number>()
  for (const wire of wires) {
    const id = wire.typed.toolCallId
    if (!id) {
      throw new InterruptedPendingToolCallResolutionProtocolError(
        "resolution has an empty tool_call_id"
      )
    }
    resolutionCounts.set(id, (resolutionCounts.get(id) || 0) + 1)
  }
  for (const [toolCallId, count] of resolutionCounts) {
    if (count > 1) {
      throw new InterruptedPendingToolCallResolutionProtocolError(
        `tool_call_id ${toolCallId} appears ${count} times`
      )
    }
  }

  const targetsById = new Map<string, InterruptedResolutionTarget>()
  for (const target of targets) {
    if (!target.toolCallId) continue
    if (targetsById.has(target.toolCallId)) {
      throw new InterruptedPendingToolCallResolutionProtocolError(
        `open target ${target.toolCallId} has duplicate ownership`
      )
    }
    targetsById.set(target.toolCallId, target)
  }

  const matched: MatchedInterruptedPendingToolCallResolution[] = []
  const unconsumed: InterruptedResolutionMatchResult["unconsumed"] = []
  for (const wire of wires) {
    const toolCallId = wire.typed.toolCallId
    const projected = projectInterruptedPendingToolCallResolution(wire)
    if (!projected) {
      throw new InterruptedPendingToolCallResolutionProtocolError(
        `tool_call_id ${toolCallId} has no supported terminal resolution oneof`
      )
    }
    const target = targetsById.get(toolCallId)
    if (!target) {
      unconsumed.push({ toolCallId, reason: "unknown_target" })
      continue
    }
    const expectedKind =
      projected.resolutionCase === "shellResult" ? "shell" : "task"
    if (target.kind !== expectedKind) {
      throw new InterruptedPendingToolCallResolutionProtocolError(
        `tool_call_id ${toolCallId} resolves ${expectedKind} but durable target is ${target.kind}`
      )
    }
    matched.push({ target, resolution: projected })
  }

  return { matched, unconsumed }
}
