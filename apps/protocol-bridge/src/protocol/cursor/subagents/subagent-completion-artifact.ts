import {
  createSubAgentCompletionArtifact,
  type SubAgentCompletionArtifact,
} from "../../../context/sub-agent-memory-formatter"
import type {
  SubagentRunRecord,
  SubagentRunTerminalFacts,
  TerminalSubagentRunStatus,
} from "../session/subagent-run-store.service"

const MAX_DURABLE_MODIFIED_FILES = 1_024
const MAX_DURABLE_MODIFIED_FILE_LENGTH = 8_192
const MAX_DURABLE_EVIDENCE = 64

/**
 * Build the one canonical terminal artifact from a durable sub-agent run.
 *
 * The run record is the only input: foreground delivery, background
 * `await_task`, control notification, and durable session memory must all
 * render the same completed/failed/killed/interrupted outcome from these
 * persisted facts. This helper deliberately has no session, transaction, or
 * stream dependency, so callers cannot introduce a second terminal shape.
 */
export function requireCanonicalSubagentCompletionArtifact(
  run: SubagentRunRecord
): SubAgentCompletionArtifact {
  if (!isTerminalStatus(run.status) || run.terminalAt === undefined) {
    throw new Error(
      `Sub-agent completion artifact requires a terminal durable run: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }

  if (
    !isPositiveSafeInteger(run.startedAt) ||
    !isPositiveSafeInteger(run.terminalAt)
  ) {
    throw new Error(
      `Sub-agent completion artifact requires valid durable timestamps: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  if (run.terminalAt < run.startedAt) {
    throw new Error(
      `Sub-agent completion artifact has terminal time before start: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  const resultText = requireTerminalResultText(run)
  const terminalFacts = requireDurableTerminalFacts(run)

  const artifact = createSubAgentCompletionArtifact({
    agentId: run.agentId,
    agentType: run.agentType,
    status: run.status,
    durationMs: run.terminalAt - run.startedAt,
    resultText,
    task: run.description,
    turnCount: terminalFacts.turnCount,
    toolCallCount: terminalFacts.toolCallCount,
    modifiedFiles: terminalFacts.modifiedFiles,
    evidence: terminalFacts.evidence,
  })
  return artifact
}

function isTerminalStatus(
  status: SubagentRunRecord["status"]
): status is TerminalSubagentRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "killed" ||
    status === "interrupted"
  )
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function requireTerminalResultText(run: SubagentRunRecord): string {
  const resultText =
    run.status === "completed" ? run.finalText : run.errorMessage
  const forbiddenResultText =
    run.status === "completed" ? run.errorMessage : run.finalText
  if (
    typeof resultText !== "string" ||
    !resultText.trim() ||
    forbiddenResultText !== undefined
  ) {
    throw new Error(
      `Sub-agent completion artifact requires terminal result text: ` +
        `conversation=${run.conversationId} agentId=${run.agentId} ` +
        `status=${run.status}`
    )
  }
  return resultText
}

/**
 * A formatter can safely clip presentation text, but it must never repair
 * malformed durable facts. These checks mirror the run-store contract while
 * preserving each validated modified-file string byte-for-byte.
 */
function requireDurableTerminalFacts(
  run: SubagentRunRecord
): SubagentRunTerminalFacts {
  const facts = run.terminalFacts
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new Error(
      `Sub-agent completion artifact requires durable terminal facts: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  const allowedFields = new Set([
    "turnCount",
    "toolCallCount",
    "modifiedFiles",
    "evidence",
  ])
  const unsupported = Object.keys(facts).filter(
    (field) => !allowedFields.has(field)
  )
  if (unsupported.length > 0) {
    throw new Error(
      `Sub-agent completion artifact has unsupported durable terminal facts: ` +
        `conversation=${run.conversationId} agentId=${run.agentId} ` +
        `fields=${unsupported.join(",")}`
    )
  }
  requireOptionalNonNegativeSafeInteger(facts.turnCount, run, "turnCount")
  requireOptionalNonNegativeSafeInteger(
    facts.toolCallCount,
    run,
    "toolCallCount"
  )
  requireDurableModifiedFiles(facts.modifiedFiles, run)
  requireDurableEvidence(facts.evidence, run)
  return facts
}

function requireOptionalNonNegativeSafeInteger(
  value: unknown,
  run: SubagentRunRecord,
  field: "turnCount" | "toolCallCount"
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    throw new Error(
      `Sub-agent completion artifact has invalid durable ${field}: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
}

function requireDurableModifiedFiles(
  modifiedFiles: unknown,
  run: SubagentRunRecord
): asserts modifiedFiles is string[] {
  if (!Array.isArray(modifiedFiles)) {
    throw new Error(
      `Sub-agent completion artifact requires durable modifiedFiles: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  if (modifiedFiles.length > MAX_DURABLE_MODIFIED_FILES) {
    throw new Error(
      `Sub-agent completion artifact has too many durable modifiedFiles: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  for (const file of modifiedFiles) {
    if (
      typeof file !== "string" ||
      file.length === 0 ||
      file.includes("\u0000") ||
      file.length > MAX_DURABLE_MODIFIED_FILE_LENGTH
    ) {
      throw new Error(
        `Sub-agent completion artifact has invalid durable modifiedFiles: ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
  }
}

function requireDurableEvidence(
  evidence: unknown,
  run: SubagentRunRecord
): asserts evidence is SubagentRunTerminalFacts["evidence"] {
  if (!Array.isArray(evidence)) {
    throw new Error(
      `Sub-agent completion artifact requires durable evidence: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  if (evidence.length > MAX_DURABLE_EVIDENCE) {
    throw new Error(
      `Sub-agent completion artifact has too much durable evidence: ` +
        `conversation=${run.conversationId} agentId=${run.agentId}`
    )
  }
  for (const item of evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Sub-agent completion artifact has invalid durable evidence: ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
    const fields = Object.keys(item as Record<string, unknown>)
    if (
      fields.length !== 2 ||
      !fields.includes("toolName") ||
      !fields.includes("summary")
    ) {
      throw new Error(
        `Sub-agent completion artifact has invalid durable evidence: ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
    const candidate = item as { toolName?: unknown; summary?: unknown }
    if (
      !isCanonicalBoundedText(candidate.toolName, 1_024) ||
      !isCanonicalBoundedText(candidate.summary, 4_096)
    ) {
      throw new Error(
        `Sub-agent completion artifact has invalid durable evidence: ` +
          `conversation=${run.conversationId} agentId=${run.agentId}`
      )
    }
  }
}

function isCanonicalBoundedText(value: unknown, maxLength: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u0000") &&
    value.length <= maxLength
  )
}
