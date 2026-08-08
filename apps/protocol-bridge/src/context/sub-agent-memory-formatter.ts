import { requireExactDurableIdentifier } from "./durable-identifier"
import type { SubAgentMemoryEvidence, SubAgentMemoryPayload } from "./types"

/**
 * Canonical structured artifact for a finished sub-agent.
 *
 * The sub-agent lifecycle writes the artifact through
 * `SessionMemoryEventStore` while structured lifecycle state (turn count,
 * tool-call count, modified files, and typed evidence) is still available.
 *
 * Keeping the formatting in one place makes the explicit event stable for
 * persistence and attachment projection without reconstructing it from
 * transcript text later.
 *
 * One artifact renders both the parent task report and the durable memory
 * projection. Neither consumer is permitted to parse the other consumer's
 * text output.
 *
 * Fields with empty/undefined values are dropped (no `agentId=` dangling).
 * `agentId` is an exact durable identifier; malformed values are rejected
 * before they can address a different event or diagnostic export.
 */

export interface SubAgentMemoryFormatInput {
  agentId: string
  agentType?: string
  status?: string
  turnCount?: number
  toolCallCount?: number
  durationMs?: number
  modifiedFiles?: readonly string[]
  /** Sub-agent's original finalText. Internal whitespace is preserved. */
  resultText?: string
  /** Evidence derived directly from typed ConversationStep data. */
  evidence?: readonly SubAgentMemoryEvidence[]
  task?: string
}

export interface SubAgentMemoryFormatOptions {
  resultMaxChars?: number
  evidenceMaxChars?: number
  taskMaxChars?: number
  /** Hard cap on the joined output. Default 600. */
  totalMaxChars?: number
}

const DEFAULT_RESULT_MAX = 360
const DEFAULT_EVIDENCE_MAX = 480
const DEFAULT_TASK_MAX = 180
const DEFAULT_TOTAL_MAX = 600
const MAX_PERSISTED_RESULT_CHARS = 4_096
const MAX_EVIDENCE_ITEMS = 6

export interface SubAgentCompletionArtifact {
  payload: SubAgentMemoryPayload
  report: string
}

/**
 * Creates the shared typed representation for foreground task reports and
 * durable session memory. The memory payload is bounded; the parent graph or
 * background run outbox remains the authoritative complete result. Files are
 * diagnostic exports only.
 */
export function createSubAgentCompletionArtifact(
  input: SubAgentMemoryFormatInput
): SubAgentCompletionArtifact {
  const payload = toSubAgentMemoryPayload(input)
  const reportResultText = trimResultText(input.resultText)
  return {
    payload,
    // The durable payload has a deliberate persistence cap. The foreground
    // task report must instead retain the original final answer verbatim
    // (apart from outer whitespace), including code blocks and line breaks.
    report: renderSubAgentCompletionReport({
      ...payload,
      ...(reportResultText ? { resultText: reportResultText } : {}),
    }),
  }
}

export function toSubAgentMemoryPayload(
  input: SubAgentMemoryFormatInput
): SubAgentMemoryPayload {
  const agentId = requireExactDurableIdentifier(
    input.agentId,
    "sub-agent memory agentId"
  )
  const resultText = trimResultText(input.resultText)
  const evidence = normalizeEvidence(input.evidence)
  return {
    agentId,
    ...(squash(input.agentType) ? { agentType: squash(input.agentType) } : {}),
    status: squash(input.status) || "unknown",
    ...(finiteNonNegative(input.turnCount) !== undefined
      ? { turnCount: finiteNonNegative(input.turnCount) }
      : {}),
    ...(finiteNonNegative(input.toolCallCount) !== undefined
      ? { toolCallCount: finiteNonNegative(input.toolCallCount) }
      : {}),
    ...(finiteNonNegative(input.durationMs) !== undefined
      ? { durationMs: finiteNonNegative(input.durationMs) }
      : {}),
    ...(input.modifiedFiles && input.modifiedFiles.length > 0
      ? {
          // File names are opaque durable facts. In particular, POSIX permits
          // leading/trailing whitespace in a file name, so presentation must
          // not normalize it away. The durable completion-artifact boundary
          // validates these values before they reach this formatter.
          modifiedFiles: [...input.modifiedFiles],
        }
      : {}),
    ...(resultText
      ? { resultText: clip(resultText, MAX_PERSISTED_RESULT_CHARS) }
      : {}),
    evidence,
    ...(squash(input.task) ? { task: squash(input.task) } : {}),
  }
}

/** Render the complete parent `task` tool-result from a typed artifact. */
export function renderSubAgentCompletionReport(
  payload: SubAgentMemoryPayload
): string {
  const finalBlock =
    payload.resultText ||
    "[sub-agent completed without an explicit final answer]"
  const summaryLines: string[] = ["Sub-agent execution summary:"]
  summaryLines.push(`- agentId: ${payload.agentId}`)
  summaryLines.push(`- status: ${payload.status}`)
  if (payload.turnCount !== undefined)
    summaryLines.push(`- turns: ${payload.turnCount}`)
  if (payload.toolCallCount !== undefined)
    summaryLines.push(`- tool calls: ${payload.toolCallCount}`)
  if (payload.durationMs !== undefined)
    summaryLines.push(`- duration: ${payload.durationMs}ms`)
  if (payload.modifiedFiles && payload.modifiedFiles.length > 0) {
    const preview = payload.modifiedFiles.slice(0, 20).join(", ")
    const overflow =
      payload.modifiedFiles.length > 20
        ? ` (+${payload.modifiedFiles.length - 20} more)`
        : ""
    summaryLines.push(`- modified files: ${preview}${overflow}`)
  }

  const sections = [finalBlock, "---", summaryLines.join("\n")]
  if (payload.evidence.length > 0) {
    const toolLines = payload.evidence.map(
      (item, index) => `${index + 1}. ${item.toolName} — ${item.summary}`
    )
    sections.push(`Tool calls:\n${toolLines.join("\n")}`)
  }
  return sections.join("\n\n")
}

/**
 * Build the body of a `sub_agent` session-memory entry without the
 * leading `Sub-agent result: ` prefix.
 */
export function formatSubAgentMemoryBody(
  input: SubAgentMemoryFormatInput,
  options?: SubAgentMemoryFormatOptions
): string {
  const agentId = requireExactDurableIdentifier(
    input.agentId,
    "sub-agent memory agentId"
  )

  const resultMax = options?.resultMaxChars ?? DEFAULT_RESULT_MAX
  const evidenceMax = options?.evidenceMaxChars ?? DEFAULT_EVIDENCE_MAX
  const taskMax = options?.taskMaxChars ?? DEFAULT_TASK_MAX
  const totalMax = options?.totalMaxChars ?? DEFAULT_TOTAL_MAX

  const parts: string[] = [`agentId=${agentId}`]

  const task = squash(input.task)
  if (task) parts.push(`task=${clip(task, taskMax)}`)

  const agentType = squash(input.agentType)
  if (agentType) parts.push(`agentType=${agentType}`)

  const status = squash(input.status)
  if (status) parts.push(`status=${status}`)

  if (typeof input.turnCount === "number" && Number.isFinite(input.turnCount)) {
    parts.push(`turns=${Math.max(0, Math.floor(input.turnCount))}`)
  }
  if (
    typeof input.toolCallCount === "number" &&
    Number.isFinite(input.toolCallCount)
  ) {
    parts.push(`toolCalls=${Math.max(0, Math.floor(input.toolCallCount))}`)
  }
  if (
    typeof input.durationMs === "number" &&
    Number.isFinite(input.durationMs)
  ) {
    parts.push(`durationMs=${Math.max(0, Math.floor(input.durationMs))}`)
  }

  if (input.modifiedFiles && input.modifiedFiles.length > 0) {
    const preview = input.modifiedFiles.slice(0, 8).join(", ")
    const overflow =
      input.modifiedFiles.length > 8
        ? ` (+${input.modifiedFiles.length - 8} more)`
        : ""
    parts.push(`modifiedFiles=${preview}${overflow}`)
  }

  const result = squash(input.resultText)
  if (result) parts.push(`result=${clip(result, resultMax)}`)

  const evidence = normalizeEvidence(input.evidence)
    .map((item) => `${item.toolName}: ${item.summary}`)
    .join(" | ")
  if (evidence) parts.push(`evidence=${clip(evidence, evidenceMax)}`)

  return clip(parts.join("; "), totalMax)
}

/**
 * Same as {@link formatSubAgentMemoryBody} but prefixed with
 * `Sub-agent result: `.
 */
export function formatSubAgentMemoryEntry(
  input: SubAgentMemoryFormatInput,
  options?: SubAgentMemoryFormatOptions
): string {
  const body = formatSubAgentMemoryBody(input, options)
  return `Sub-agent result: ${body}`
}

/**
 * Stable domain event identity for a `sub_agent` memory event. Agent ids are
 * minted at spawn and are the only valid owner identity; a parent tool-call
 * id is a relation, not an identity substitute.
 */
export function buildSubAgentMemorySourceEventId(agentId: string): string {
  return `sub_agent:${requireExactDurableIdentifier(
    agentId,
    "sub-agent memory agentId"
  )}`
}

function normalizeEvidence(
  evidence: readonly SubAgentMemoryEvidence[] | undefined
): SubAgentMemoryEvidence[] {
  const normalized: SubAgentMemoryEvidence[] = []
  for (const item of evidence || []) {
    const toolName = squash(item?.toolName)
    const summary = squash(item?.summary)
    if (!toolName || !summary) continue
    normalized.push({ toolName, summary })
    if (normalized.length >= MAX_EVIDENCE_ITEMS) break
  }
  return normalized
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined
}

function squash(value: string | undefined): string {
  if (!value) return ""
  return value.replace(/\s+/g, " ").trim()
}

function trimResultText(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function clip(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}
