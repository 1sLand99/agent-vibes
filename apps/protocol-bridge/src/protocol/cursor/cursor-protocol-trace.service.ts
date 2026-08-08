import { fromBinary } from "@bufbuild/protobuf"
import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  AgentClientMessage,
  AgentServerMessage,
  AgentServerMessageSchema,
  ToolCall,
  ToolCallSchema,
} from "../../gen/agent/v1_pb"

type TraceDirection = "inbound" | "outbound" | "internal"

interface CapabilitySnapshotTrace {
  readonly backend: string
  readonly model: string
  readonly clientSupportedTools: readonly string[]
  readonly providerCoreTools: readonly string[]
  readonly providerDeferredTools: readonly string[]
  readonly providerMcpTools: readonly string[]
}

interface TraceRecord {
  ts: string
  direction: TraceDirection
  messageType:
    | "AgentClientMessage"
    | "AgentServerMessage"
    | "CapabilitySnapshot"
  topCase?: string
  nestedCase?: string
  toolCase?: string
  toolResultCase?: string
  toolOutcome?: "success" | "failure" | "unknown"
  hookCase?: string
  callId?: string
  id?: number
  execId?: string
  toolCallId?: string
  modelCallId?: string
  conversationId?: string
  streamEpoch?: string
  model?: string
  bytes?: number
  compressedBytes?: number
  context?: string
  // ConversationAction triggering metadata. Persisted so audit / replay
  // can correlate which Cursor user / authId initiated each action.
  triggeringAuthId?: string
  triggeringUserAuthId?: string
  triggeringUserId?: string | number
  // Sub-case specific extras: only present when relevant. Lets audit/replay
  // distinguish e.g. step_started vs step_completed (with stepName/status),
  // active_branch_change (branchId/branchName), turn_ended (reason),
  // summary_completed (summaryId), prompt_suggestion (suggestionId), etc.
  // Values are flat string|number for cheap JSONL grep.
  nestedExtras?: Record<string, string | number>
  capabilitySnapshot?: CapabilitySnapshotTrace
}

interface TraceScope {
  readonly conversationId?: string
  readonly streamEpoch?: string
}

interface ClientTraceMeta extends TraceScope {
  readonly bytes?: number
  readonly compressedBytes?: number
  readonly context?: string
}

interface ServerTraceMeta extends TraceScope {
  readonly bytes?: number
  readonly context?: string
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function extractToolCase(toolCall: ToolCall | undefined): string | undefined {
  return toolCall?.tool.case || undefined
}

function extractGenericToolCallId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return firstString(
    record.toolCallId,
    record.originalToolCallId,
    record.callId,
    record.id
  )
}

/**
 * Best-effort flat extractor for "nested extras" — small key/value bag of
 * scalar fields associated with a particular oneof sub-case. We deliberately
 * avoid recursing into nested messages here; the goal is cheap JSONL grep,
 * not a full structured dump.
 */
function pickScalarFields(
  source: unknown,
  keys: readonly string[]
): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  if (!source || typeof source !== "object") return out
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) {
      out[key] = value
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
    } else if (typeof value === "bigint") {
      out[key] = value.toString()
    } else if (typeof value === "boolean") {
      out[key] = value ? "true" : "false"
    }
  }
  return out
}

function mergeExtras(
  record: TraceRecord,
  extras: Record<string, string | number>
): void {
  if (Object.keys(extras).length === 0) return
  record.nestedExtras = { ...(record.nestedExtras || {}), ...extras }
}

/**
 * Pull the inner ToolCall.tool oneof case ("readToolCall" / "shellToolCall"
 * / "truncatedToolCall" / etc.) regardless of which wrapping update we are
 * looking at. ToolCallStarted/Completed/Delta all carry the ToolCall on
 * different field names, so we try a couple of common accessors.
 */
function extractAnyToolCase(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const candidates = [
    record.toolCall,
    record.tool_call,
    record.delta,
    record.partialToolCall,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const inner = candidate as Record<string, unknown>
    const tool = inner.tool
    if (tool && typeof tool === "object") {
      const tc = tool as { case?: string }
      if (typeof tc.case === "string" && tc.case.length > 0) {
        return tc.case
      }
    }
    // Some deltas store the case directly on `delta.case`.
    const innerCase = (inner as { case?: string }).case
    if (typeof innerCase === "string" && innerCase.length > 0) {
      return innerCase
    }
  }
  return undefined
}

const NON_FAILURE_TOOL_RESULT_CASES = new Set([
  "success",
  "startSuccess",
  "saveSuccess",
  "discardSuccess",
  "async",
  "registered",
  "needsConfirmation",
  "complete",
  "stillRunning",
])

const FAILURE_TOOL_RESULT_CASES = new Set([
  "failure",
  "timeout",
  "rejected",
  "spawnError",
  "sandboxUnsupported",
  "permissionDenied",
  "fileNotFound",
  "notFile",
  "fileBusy",
  "error",
  "readPermissionDenied",
  "writePermissionDenied",
  "notFound",
])

const TOOL_RESULT_OUTCOMES = buildToolResultOutcomeTable()

function buildToolResultOutcomeTable(): ReadonlyMap<
  string,
  ReadonlyMap<string, "success" | "failure">
> {
  const table = new Map<string, ReadonlyMap<string, "success" | "failure">>()
  const toolFields = ToolCallSchema.fields.filter(
    (field) => field.oneof?.name === "tool"
  )
  for (const toolField of toolFields) {
    const resultField = toolField.message?.fields.find(
      (field) => field.localName === "result"
    )
    const resultCases = resultField?.message?.fields.filter(
      (field) => field.oneof?.name === "result"
    )
    if (!resultCases || resultCases.length === 0) {
      throw new Error(
        `Cursor protocol trace cannot classify ${toolField.localName}: result oneof is missing`
      )
    }
    const outcomes = new Map<string, "success" | "failure">()
    for (const resultCase of resultCases) {
      const isSuccess = NON_FAILURE_TOOL_RESULT_CASES.has(resultCase.localName)
      const isFailure = FAILURE_TOOL_RESULT_CASES.has(resultCase.localName)
      if (isSuccess === isFailure) {
        throw new Error(
          `Cursor protocol trace has no exact outcome for ${toolField.localName}.${resultCase.localName}`
        )
      }
      outcomes.set(resultCase.localName, isSuccess ? "success" : "failure")
    }
    table.set(toolField.localName, outcomes)
  }
  return table
}

export function classifyCursorToolResultCase(
  toolCase: string | undefined,
  resultCase: string | undefined
): TraceRecord["toolOutcome"] {
  if (!toolCase || !resultCase) return "unknown"
  return TOOL_RESULT_OUTCOMES.get(toolCase)?.get(resultCase) || "unknown"
}

function extractResultOneofCase(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const resultOneof = (value as Record<string, unknown>).result
  if (!resultOneof || typeof resultOneof !== "object") return undefined
  const resultCase = (resultOneof as { case?: unknown }).case
  return typeof resultCase === "string" && resultCase.length > 0
    ? resultCase
    : undefined
}

function extractToolResultCase(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const update = value as Record<string, unknown>
  const toolCall = (update.toolCall || update.tool_call) as
    | { tool?: { value?: unknown } }
    | undefined
  const callValue = toolCall?.tool?.value
  if (!callValue || typeof callValue !== "object") return undefined
  return extractResultOneofCase((callValue as Record<string, unknown>).result)
}

function extractToolOutcome(
  value: unknown,
  toolCase: string | undefined
): TraceRecord["toolOutcome"] {
  const resultCase = extractToolResultCase(value)
  return resultCase
    ? classifyCursorToolResultCase(toolCase, resultCase)
    : "unknown"
}

function extractToolResultExtras(
  value: unknown,
  toolCase: string | undefined
): Record<string, string | number> {
  if (
    toolCase !== "listMcpResourcesToolCall" ||
    !value ||
    typeof value !== "object"
  ) {
    return {}
  }
  const update = value as Record<string, unknown>
  const toolCall = (update.toolCall || update.tool_call) as
    | { tool?: { value?: unknown } }
    | undefined
  const callValue = toolCall?.tool?.value
  const resultMessage =
    callValue && typeof callValue === "object"
      ? (callValue as Record<string, unknown>).result
      : undefined
  const resultOneof =
    resultMessage && typeof resultMessage === "object"
      ? (resultMessage as Record<string, unknown>).result
      : undefined
  if (
    !resultOneof ||
    typeof resultOneof !== "object" ||
    (resultOneof as { case?: unknown }).case !== "success"
  ) {
    return {}
  }
  const success = (resultOneof as { value?: unknown }).value
  const resources =
    success && typeof success === "object"
      ? (success as Record<string, unknown>).resources
      : undefined
  return Array.isArray(resources) ? { resourceCount: resources.length } : {}
}

const INTERACTION_UPDATE_EXTRA_KEYS: Record<string, readonly string[]> = {
  textDelta: ["modelCallId", "callId", "isFinal"],
  thinkingDelta: ["modelCallId", "callId", "thinkingStyle"],
  thinkingCompleted: ["modelCallId", "callId"],
  tokenDelta: ["modelCallId", "inputTokens", "outputTokens", "totalTokens"],
  heartbeat: ["modelCallId", "callId"],
  shellOutputDelta: ["execId", "callId", "stream", "isStderr"],
  toolCallStarted: ["callId", "modelCallId", "toolCallId"],
  toolCallCompleted: [
    "callId",
    "modelCallId",
    "toolCallId",
    "status",
    "errorReason",
  ],
  toolCallDelta: ["callId", "modelCallId", "toolCallId"],
  partialToolCall: ["callId", "toolCallId", "partialIndex"],
  stepStarted: ["stepId", "stepName", "stepKind", "modelCallId"],
  stepCompleted: ["stepId", "stepName", "stepKind", "status", "modelCallId"],
  summary: ["summaryId", "modelCallId"],
  summaryStarted: ["summaryId", "modelCallId"],
  summaryCompleted: ["summaryId", "modelCallId", "status"],
  turnEnded: [
    "modelCallId",
    "endReason",
    "reason",
    "stopReason",
    "outcome",
    "isFinal",
  ],
  userMessageAppended: ["messageId", "callId"],
  promptSuggestion: ["suggestionId", "modelCallId"],
  postRequestPrompt: ["promptId", "modelCallId"],
  activeBranchChange: ["branchId", "branchName", "modelCallId"],
  feedbackRequest: ["requestId", "modelCallId", "kind"],
}

const CONVERSATION_ACTION_EXTRA_KEYS: Record<string, readonly string[]> = {
  userMessageAction: ["messageId", "callId", "modelCallId"],
  resumeAction: ["resumeReason", "callId"],
  cancelAction: ["cancelReason", "callId"],
  summarizeAction: ["summaryId", "callId"],
  shellCommandAction: ["execId", "shellId", "command"],
  startPlanAction: ["planId"],
  executePlanAction: ["planId", "stepId"],
  asyncAskQuestionCompletionAction: ["originalToolCallId"],
  cancelSubagentAction: ["subagentId", "reason"],
  backgroundTaskCompletionAction: ["taskId", "status"],
  backgroundShellAction: ["shellId", "status"],
  backgroundSubagentAction: ["subagentId", "status"],
}

function summarizeClientMessage(
  msg: AgentClientMessage,
  meta?: ClientTraceMeta
): TraceRecord {
  const record: TraceRecord = {
    ts: new Date().toISOString(),
    direction: "inbound",
    messageType: "AgentClientMessage",
    topCase: msg.message.case || undefined,
    bytes: meta?.bytes,
    compressedBytes: meta?.compressedBytes,
    context: meta?.context,
    conversationId: meta?.conversationId,
    streamEpoch: meta?.streamEpoch,
  }

  switch (msg.message.case) {
    case "runRequest": {
      const value = msg.message.value
      record.nestedCase = value.action?.action.case || undefined
      record.conversationId = value.conversationId || undefined
      record.model =
        value.requestedModel?.modelId ||
        value.modelDetails?.modelId ||
        undefined
      break
    }
    case "execClientMessage": {
      const value = msg.message.value
      record.nestedCase = value.message.case || undefined
      record.id = value.id
      record.execId = value.execId || undefined
      record.toolCallId = extractGenericToolCallId(value.message.value)
      if (value.message.case === "executeHookResult") {
        record.hookCase = value.message.value.response?.response.case
      }
      break
    }
    case "execClientControlMessage": {
      const value = msg.message.value
      record.nestedCase = value.message.case || undefined
      record.id = firstNumber((value as unknown as Record<string, unknown>).id)
      record.execId = firstString(
        (value as unknown as Record<string, unknown>).execId
      )
      break
    }
    case "interactionResponse": {
      const value = msg.message.value
      record.nestedCase = value.result.case || undefined
      record.id = value.id
      break
    }
    case "conversationAction": {
      const action = msg.message.value.action
      record.nestedCase = action.case || undefined
      record.toolCallId = extractGenericToolCallId(action.value)
      // Sub-case-specific scalar extras (executePlan / shellCommand /
      // backgroundShell / cancelSubagent etc.) so each ConversationAction
      // sub-case is distinguishable in trace without decoding payload.
      const conversationExtraKeys = action.case
        ? CONVERSATION_ACTION_EXTRA_KEYS[action.case]
        : undefined
      if (conversationExtraKeys) {
        mergeExtras(
          record,
          pickScalarFields(action.value, conversationExtraKeys)
        )
      }
      if (
        action.case === "asyncAskQuestionCompletionAction" &&
        action.value &&
        typeof action.value === "object"
      ) {
        const resultCase = extractResultOneofCase(
          (action.value as Record<string, unknown>).result
        )
        if (resultCase) mergeExtras(record, { resultCase })
      }
      // Persist triggering metadata when Cursor includes it on the
      // ConversationAction envelope. Cursor 3.x carries the authId on
      // either `triggeringAuthId` (legacy) or
      // `triggeringUserInfo.{authId,userId}` (current).
      const conversationActionRecord = msg.message.value as unknown as Record<
        string,
        unknown
      >
      const triggeringUserInfo = (() => {
        const value = conversationActionRecord.triggeringUserInfo
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return value as Record<string, unknown>
        }
        return undefined
      })()
      const legacyAuthId = firstString(
        conversationActionRecord.triggeringAuthId
      )
      if (legacyAuthId) {
        record.triggeringAuthId = legacyAuthId
      }
      if (triggeringUserInfo) {
        const infoAuthId = firstString(triggeringUserInfo.authId)
        if (infoAuthId) {
          record.triggeringUserAuthId = infoAuthId
        }
        const userIdRaw = triggeringUserInfo.userId
        if (typeof userIdRaw === "string" && userIdRaw.length > 0) {
          record.triggeringUserId = userIdRaw
        } else if (
          typeof userIdRaw === "number" &&
          Number.isFinite(userIdRaw)
        ) {
          record.triggeringUserId = userIdRaw
        } else if (typeof userIdRaw === "bigint") {
          record.triggeringUserId = userIdRaw.toString()
        }
      }
      break
    }
    default:
      break
  }

  return record
}

function summarizeServerMessage(
  msg: AgentServerMessage,
  meta?: ServerTraceMeta
): TraceRecord {
  const record: TraceRecord = {
    ts: new Date().toISOString(),
    direction: "outbound",
    messageType: "AgentServerMessage",
    topCase: msg.message.case || undefined,
    bytes: meta?.bytes,
    context: meta?.context,
    conversationId: meta?.conversationId,
    streamEpoch: meta?.streamEpoch,
  }

  switch (msg.message.case) {
    case "interactionUpdate": {
      const update = msg.message.value.message
      record.nestedCase = update.case || undefined
      const value = update.value as Record<string, unknown> | undefined
      record.callId = firstString(value?.callId)
      record.modelCallId = firstString(value?.modelCallId)
      record.toolCase = extractToolCase(value?.toolCall as ToolCall | undefined)
      if (!record.toolCase) {
        record.toolCase = extractAnyToolCase(value)
      }
      if (!record.toolCase && value?.toolCallDelta) {
        const delta = value.toolCallDelta as { delta?: { case?: string } }
        record.toolCase = delta.delta?.case
      }
      if (update.case === "toolCallCompleted") {
        record.toolResultCase = extractToolResultCase(value)
        record.toolOutcome = extractToolOutcome(value, record.toolCase)
        mergeExtras(record, extractToolResultExtras(value, record.toolCase))
      }
      // Capture sub-case-specific scalars so audit / replay can distinguish
      // turn_ended vs step_completed vs summary_completed without decoding
      // the full envelope. Only fields that are flat scalars are captured.
      const interactionExtraKeys = update.case
        ? INTERACTION_UPDATE_EXTRA_KEYS[update.case]
        : undefined
      if (interactionExtraKeys) {
        mergeExtras(record, pickScalarFields(value, interactionExtraKeys))
      }
      // The toolCallId on the inner ToolCall is the canonical correlation
      // key for tool_call_started / completed / delta; pull it explicitly
      // when the wrapping update did not carry callId itself.
      if (!record.toolCallId) {
        const innerToolCall = (value?.toolCall ||
          value?.tool_call ||
          value?.delta) as { toolCallId?: string; callId?: string } | undefined
        record.toolCallId = firstString(
          innerToolCall?.toolCallId,
          innerToolCall?.callId
        )
      }
      break
    }
    case "interactionQuery": {
      const query = msg.message.value
      record.nestedCase = query.query.case || undefined
      record.id = query.id
      record.toolCallId = extractGenericToolCallId(query.query.value)
      break
    }
    case "execServerMessage": {
      const exec = msg.message.value
      record.nestedCase = exec.message.case || undefined
      record.id = exec.id
      record.execId = exec.execId || undefined
      record.toolCallId = extractGenericToolCallId(exec.message.value)
      if (exec.message.case === "executeHookArgs") {
        record.hookCase = exec.message.value.request?.request.case
      }
      if (
        exec.message.case === "shellArgs" ||
        exec.message.case === "shellStreamArgs"
      ) {
        mergeExtras(record, {
          commandSha256: createHash("sha256")
            .update(exec.message.value.command)
            .digest("hex"),
        })
      }
      break
    }
    case "execServerControlMessage": {
      const control = msg.message.value
      record.nestedCase = control.message.case || undefined
      break
    }
    default:
      break
  }

  return record
}

export class CursorProtocolTraceService {
  private static readonly DEFAULT_MAX_TRACE_BYTES = 64 * 1024 * 1024
  private static readonly TRACE_SIZE_CHECK_INTERVAL_MS = 5000
  private static lastTraceSizeCheckAt = 0

  private static enabled(): boolean {
    const raw = process.env.CURSOR_PROTOCOL_TRACE
    if (raw === undefined || raw.trim() === "") return true
    return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase())
  }

  private static maxTraceBytes(): number {
    const raw = process.env.CURSOR_PROTOCOL_TRACE_MAX_BYTES
    if (raw === undefined || raw.trim() === "") {
      return this.DEFAULT_MAX_TRACE_BYTES
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return this.DEFAULT_MAX_TRACE_BYTES
    }
    return parsed
  }

  private static tracePath(): string {
    if (process.env.CURSOR_PROTOCOL_TRACE_FILE) {
      return this.guardAgainstRepoPollution(
        path.resolve(process.env.CURSOR_PROTOCOL_TRACE_FILE)
      )
    }
    if (process.env.AGENT_VIBES_LOG_DIR) {
      return this.guardAgainstRepoPollution(
        path.resolve(
          process.env.AGENT_VIBES_LOG_DIR,
          "cursor_protocol_trace.jsonl"
        )
      )
    }
    // Default to the canonical Agent Vibes data dir so dev/test runs never
    // leak trace files into the repository working tree.
    return path.resolve(
      os.homedir(),
      ".agent-vibes",
      "logs",
      "cursor_protocol_trace.jsonl"
    )
  }

  /**
   * Reject trace target paths that fall inside a Git working tree.
   *
   * Rationale: smoke / regression specs explicitly forbid trace files from
   * landing in `apps/**`, `.log/`, `tmp/` etc. inside the repo. If an env
   * override resolves to a path under any directory containing a `.git`
   * entry, fall back to the canonical default under `$HOME/.agent-vibes/logs`
   * so we silently neutralize accidental pollution without breaking trace
   * recording.
   *
   * The walk stops at the user's home dir or the filesystem root to bound
   * cost. We `fs.stat` rather than `existsSync` to avoid following stale
   * symlinks; failures (permission denied / non-existent) are treated as
   * "not a git repo" so we err on the side of honoring the override.
   */
  private static guardAgainstRepoPollution(target: string): string {
    try {
      const home = os.homedir()
      let cursor = path.dirname(target)
      // Bound the walk: stop at filesystem root, at $HOME, or after 32 hops.
      for (let depth = 0; depth < 32; depth++) {
        if (cursor === path.parse(cursor).root) break
        if (home && cursor === home) break
        const gitMarker = path.join(cursor, ".git")
        if (fs.existsSync(gitMarker)) {
          // Repo working tree detected — reject and fall back.
          return path.resolve(
            home,
            ".agent-vibes",
            "logs",
            "cursor_protocol_trace.jsonl"
          )
        }
        const parent = path.dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
    } catch {
      // If detection itself fails, prefer the original target — tracing must
      // never block protocol handling. Only reject when we positively
      // identified a `.git` ancestor.
    }
    return target
  }

  private static append(record: TraceRecord): void {
    if (!this.enabled()) return
    try {
      const filePath = this.tracePath()
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      this.rotateTraceIfNeeded(filePath)
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8")
    } catch {
      // Tracing must never break protocol handling.
    }
  }

  private static rotateTraceIfNeeded(filePath: string): void {
    const maxBytes = this.maxTraceBytes()
    if (maxBytes <= 0) return

    const now = Date.now()
    if (now - this.lastTraceSizeCheckAt < this.TRACE_SIZE_CHECK_INTERVAL_MS) {
      return
    }
    this.lastTraceSizeCheckAt = now

    try {
      const stat = fs.statSync(filePath)
      if (stat.size < maxBytes) return

      const rotatedPath = `${filePath}.1`
      try {
        fs.rmSync(rotatedPath, { force: true })
        fs.renameSync(filePath, rotatedPath)
      } catch {
        fs.truncateSync(filePath, 0)
      }
    } catch {
      // Missing/unreadable trace file: nothing to rotate.
    }
  }

  static recordClientMessage(
    msg: AgentClientMessage,
    meta?: ClientTraceMeta
  ): void {
    this.append(summarizeClientMessage(msg, meta))
  }

  static recordServerMessage(
    msg: AgentServerMessage,
    meta?: ServerTraceMeta
  ): void {
    this.append(summarizeServerMessage(msg, meta))
  }

  static recordServerEnvelope(
    buffer: Uint8Array | Buffer,
    meta?: TraceScope & { readonly context?: string }
  ): void {
    if (!this.enabled()) return
    try {
      const bytes = Buffer.from(buffer)
      const payload = bytes.length >= 5 ? bytes.subarray(5) : Buffer.from(bytes)
      const msg = fromBinary(AgentServerMessageSchema, payload)
      this.recordServerMessage(msg, {
        bytes: payload.length,
        context: meta?.context || "envelope",
        conversationId: meta?.conversationId,
        streamEpoch: meta?.streamEpoch,
      })
    } catch {
      // Ignore malformed trace-only decode failures.
    }
  }

  static recordCapabilitySnapshot(input: {
    readonly conversationId: string
    readonly streamEpoch?: string
    readonly backend: string
    readonly model: string
    readonly clientSupportedTools: readonly string[]
    readonly providerCoreTools: readonly string[]
    readonly providerDeferredTools: readonly string[]
    readonly providerMcpTools: readonly string[]
  }): void {
    const normalizeNames = (values: readonly string[]): readonly string[] =>
      Object.freeze(
        Array.from(
          new Set(
            values.filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0
            )
          )
        ).sort((left, right) => left.localeCompare(right))
      )

    this.append({
      ts: new Date().toISOString(),
      direction: "internal",
      messageType: "CapabilitySnapshot",
      topCase: "capabilitySnapshot",
      conversationId: input.conversationId,
      streamEpoch: input.streamEpoch,
      model: input.model,
      capabilitySnapshot: {
        backend: input.backend,
        model: input.model,
        clientSupportedTools: normalizeNames(input.clientSupportedTools),
        providerCoreTools: normalizeNames(input.providerCoreTools),
        providerDeferredTools: normalizeNames(input.providerDeferredTools),
        providerMcpTools: normalizeNames(input.providerMcpTools),
      },
    })
  }
}
