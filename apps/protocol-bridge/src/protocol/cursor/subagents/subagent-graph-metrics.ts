import { create, fromJson } from "@bufbuild/protobuf"
import {
  AssistantMessageSchema,
  ConversationStepSchema,
  ThinkingMessageSchema,
  type ConversationStep,
} from "../../../gen/agent/v1_pb"
import type { SessionMessage } from "../session/session-lifecycle.service"
import type {
  SubagentSpawnRequest,
  SubagentToolContractEntry,
  SubagentToolExecutionOwner,
} from "../session/subagent-spawn-request"
import type {
  SubagentRunEvidence,
  SubagentRunTerminalFacts,
} from "../session/subagent-run-store.service"
import { WorkspaceScope, WorkspaceScopeError } from "../session/workspace-scope"
import {
  readSubagentToolResultPresentationFact,
  readSubagentToolResultRejectionFact,
  requireSubagentToolResultPresentationFact,
  type SubagentToolResultPresentationFact,
} from "./subagent-tool-result-presentation"
import {
  assertFrozenSubagentToolEntryOwnerBinding,
  resolveFrozenSubagentToolCallProjection,
} from "./subagent-tool-call-projection"

export interface SubagentGraphExecutionMetrics {
  readonly turnCount: number
  readonly toolCallCount: number
}

export interface SubagentGraphTerminalProjection {
  readonly terminalFacts: SubagentRunTerminalFacts
  readonly conversationSteps: readonly ConversationStep[]
}

interface DurableToolUse {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

interface DurableToolResult {
  readonly toolUseId: string
  readonly isError: boolean
  readonly metadata: Record<string, unknown> | undefined
}

const CURSOR_WORKSPACE_MUTATION_DEFINITION_KEYS = new Set([
  "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
])

/**
 * Claude Code's AgentTool finalizer returns the last assistant message that
 * contains text. A max-turn boundary may follow a pure tool_use message, so
 * selecting only the graph tail would discard the child's most recent real
 * answer. This projector reads the durable child graph and never invents a
 * completion turn or parses diagnostic transcript text.
 */
export function findLastSubagentAssistantText(
  messages: readonly Pick<
    SessionMessage,
    "uuid" | "logicalParentUuid" | "providerMessageId" | "message"
  >[]
): string | undefined {
  const visited = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index]
    if (!record || record.message.role !== "assistant") continue
    const key = assistantLogicalMessageKey(record, index)
    if (visited.has(key)) continue
    visited.add(key)
    const text = messages
      .flatMap((candidate, candidateIndex) => {
        if (
          candidate.message.role !== "assistant" ||
          assistantLogicalMessageKey(candidate, candidateIndex) !== key ||
          !Array.isArray(candidate.message.content)
        ) {
          return []
        }
        return candidate.message.content.flatMap((block) => {
          if (!block || typeof block !== "object") return []
          const value = block as { type?: unknown; text?: unknown }
          return value.type === "text" && typeof value.text === "string"
            ? [value.text]
            : []
        })
      })
      .join("")
    if (text.length > 0) return text
  }
  return undefined
}

/**
 * Derive execution counters from the durable child graph projection. Runtime
 * contexts may mirror these values for UI progress, but they never own them.
 */
export function deriveSubagentGraphExecutionMetrics(
  messages: readonly Pick<
    SessionMessage,
    "uuid" | "logicalParentUuid" | "providerMessageId" | "message"
  >[]
): SubagentGraphExecutionMetrics {
  const assistantTurns = new Set<string>()
  let toolCallCount = 0
  for (let index = 0; index < messages.length; index += 1) {
    const record = messages[index]!
    if (record.message.role !== "assistant") continue
    assistantTurns.add(assistantLogicalMessageKey(record, index))
    const content = Array.isArray(record.message.content)
      ? record.message.content
      : []
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use"
      ) {
        toolCallCount += 1
      }
    }
  }
  return { turnCount: assistantTurns.size, toolCallCount }
}

/**
 * Reduce terminal child facts from the immutable sidechain plus its frozen
 * capability contract.  A received ExecClient frame is not proof that a
 * file mutation succeeded: a path becomes a modified file only when the
 * exact frozen mutation capability has a paired durable tool_result whose
 * canonical `is_error` flag is not true.
 */
export function deriveSubagentGraphTerminalFacts(
  messages: readonly Pick<
    SessionMessage,
    "uuid" | "logicalParentUuid" | "providerMessageId" | "message" | "metadata"
  >[],
  spawnRequest: SubagentSpawnRequest
): SubagentRunTerminalFacts {
  return deriveSubagentGraphTerminalProjection(messages, spawnRequest)
    .terminalFacts
}

/**
 * Build the complete terminal projection from graph facts. Text/thinking
 * steps come from accepted assistant fragments; tool steps come only from the
 * versioned official Cursor presentation fact committed with each result.
 */
export function deriveSubagentGraphTerminalProjection(
  messages: readonly Pick<
    SessionMessage,
    "uuid" | "logicalParentUuid" | "providerMessageId" | "message" | "metadata"
  >[],
  spawnRequest: SubagentSpawnRequest
): SubagentGraphTerminalProjection {
  const metrics = deriveSubagentGraphExecutionMetrics(messages)
  // A recovered child graph has no live SessionRecord. Restore its one frozen
  // scope once for this projection; every mutation below shares that authority.
  const workspaceScope = WorkspaceScope.fromFrozenSnapshot(
    spawnRequest.workspace
  )
  const { uses, results } = collectDurableToolPairs(messages)
  const entriesByName = new Map(
    spawnRequest.toolContract.tools.map((entry) => [entry.name, entry] as const)
  )
  const modifiedFiles: string[] = []
  const modifiedFileSet = new Set<string>()
  const evidence: SubagentRunEvidence[] = []
  const presentations = new Map<string, SubagentToolResultPresentationFact>()
  const rejectedToolResults = new Set<string>()

  for (const use of uses) {
    const result = results.get(use.id)
    if (!result) continue
    const entry = entriesByName.get(use.name)
    const rejection = readSubagentToolResultRejectionFact(result.metadata)
    const presentation = readSubagentToolResultPresentationFact(result.metadata)

    if (!entry) {
      if (!rejection) {
        throw new Error(
          `Unknown sub-agent tool_result ${result.toolUseId} has no durable rejection fact.`
        )
      }
      if (!result.isError) {
        throw new Error(
          `Unknown sub-agent tool_result ${result.toolUseId} must record is_error=true.`
        )
      }
      if (presentation) {
        throw new Error(
          `Unknown sub-agent tool_result ${result.toolUseId} cannot carry a Cursor ToolCall presentation.`
        )
      }
      if (
        rejection.code !== "unknown_capability" ||
        rejection.capabilityId !== null ||
        rejection.modelToolName !== use.name
      ) {
        throw new Error(
          `Unknown sub-agent tool_result ${result.toolUseId} rejection does not match its exact model tool name.`
        )
      }
      rejectedToolResults.add(use.id)
      continue
    }

    if (rejection) {
      if (!result.isError) {
        throw new Error(
          `Sub-agent tool_result ${result.toolUseId} records a rejection without is_error=true.`
        )
      }
      if (
        rejection.code !== "capability_unavailable_in_phase" ||
        rejection.modelToolName !== use.name
      ) {
        throw new Error(
          `Sub-agent tool_result ${result.toolUseId} rejection does not match its frozen capability name.`
        )
      }
      if (rejection.capabilityId !== entry.capabilityId) {
        throw new Error(
          `Sub-agent tool_result ${result.toolUseId} rejection capability does not match its frozen tool.`
        )
      }
      if (entry.executionOwners[rejection.phase] !== null) {
        throw new Error(
          `Sub-agent tool_result ${result.toolUseId} records an unowned rejection for an executable frozen phase.`
        )
      }
      if (presentation) {
        throw new Error(
          `Sub-agent tool_result ${result.toolUseId} cannot carry both an unowned rejection and a Cursor ToolCall presentation.`
        )
      }
      rejectedToolResults.add(use.id)
      continue
    }
    const requiredPresentation = requireSubagentToolResultPresentationFact(
      result.metadata
    )
    assertPresentationMatchesExecution(use, entry, result, requiredPresentation)
    presentations.set(use.id, requiredPresentation)
    const mutationPath = resolveDurableWorkspaceMutation(
      entry,
      requiredPresentation,
      result.isError,
      workspaceScope
    )
    if (result.isError) continue

    if (mutationPath) {
      if (!modifiedFileSet.has(mutationPath)) {
        modifiedFileSet.add(mutationPath)
        modifiedFiles.push(mutationPath)
      }
    }

    if (evidence.length < 64) {
      evidence.push({
        toolName: entry.name,
        summary: describeSuccessfulCapability(entry, use.input),
      })
    }
  }

  return {
    terminalFacts: {
      ...metrics,
      modifiedFiles,
      evidence,
    },
    conversationSteps: projectDurableConversationSteps(
      messages,
      entriesByName,
      presentations,
      rejectedToolResults
    ),
  }
}

function projectDurableConversationSteps(
  messages: readonly Pick<SessionMessage, "message">[],
  entriesByName: ReadonlyMap<string, SubagentToolContractEntry>,
  presentations: ReadonlyMap<string, SubagentToolResultPresentationFact>,
  rejectedToolResults: ReadonlySet<string>
): ConversationStep[] {
  const toolNamesById = new Map<string, string>()
  const steps: ConversationStep[] = []
  for (const record of messages) {
    const content = Array.isArray(record.message.content)
      ? record.message.content
      : []
    if (record.message.role === "assistant") {
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const candidate = block as {
          type?: unknown
          text?: unknown
          thinking?: unknown
          id?: unknown
          name?: unknown
        }
        if (candidate.type === "text" && typeof candidate.text === "string") {
          if (candidate.text.length > 0) {
            steps.push(
              create(ConversationStepSchema, {
                message: {
                  case: "assistantMessage",
                  value: create(AssistantMessageSchema, {
                    text: candidate.text,
                  }),
                },
              })
            )
          }
        } else if (
          candidate.type === "thinking" &&
          typeof candidate.thinking === "string"
        ) {
          if (candidate.thinking.length > 0) {
            steps.push(
              create(ConversationStepSchema, {
                message: {
                  case: "thinkingMessage",
                  value: create(ThinkingMessageSchema, {
                    text: candidate.thinking,
                    durationMs: 0,
                  }),
                },
              })
            )
          }
        } else if (
          candidate.type === "tool_use" &&
          typeof candidate.id === "string" &&
          typeof candidate.name === "string"
        ) {
          toolNamesById.set(candidate.id, candidate.name)
        }
      }
      continue
    }

    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const candidate = block as { type?: unknown; tool_use_id?: unknown }
      if (
        candidate.type !== "tool_result" ||
        typeof candidate.tool_use_id !== "string"
      ) {
        continue
      }
      const toolName = toolNamesById.get(candidate.tool_use_id)
      if (!toolName) continue
      const presentation = presentations.get(candidate.tool_use_id)
      if (!presentation) {
        if (rejectedToolResults.has(candidate.tool_use_id)) continue
        throw new Error(
          `Sub-agent tool_result ${candidate.tool_use_id} has no durable terminal fact.`
        )
      }
      if (!entriesByName.has(toolName)) {
        throw new Error(
          `Unknown sub-agent tool_result ${candidate.tool_use_id} cannot carry a Cursor ToolCall presentation.`
        )
      }
      steps.push(
        fromJson(ConversationStepSchema, presentation.conversationStep, {
          ignoreUnknownFields: false,
        })
      )
    }
  }
  return steps
}

function collectDurableToolPairs(
  messages: readonly Pick<SessionMessage, "message" | "metadata">[]
): {
  uses: DurableToolUse[]
  results: ReadonlyMap<string, DurableToolResult>
} {
  const uses: DurableToolUse[] = []
  const usesById = new Map<string, DurableToolUse>()
  const results = new Map<string, DurableToolResult>()

  for (const record of messages) {
    const content = Array.isArray(record.message.content)
      ? record.message.content
      : []
    if (record.message.role === "assistant") {
      for (const block of content) {
        if (!block || typeof block !== "object") continue
        const candidate = block as {
          type?: unknown
          id?: unknown
          name?: unknown
          input?: unknown
        }
        if (candidate.type !== "tool_use") continue
        if (
          typeof candidate.id !== "string" ||
          !candidate.id ||
          typeof candidate.name !== "string" ||
          !candidate.name ||
          !candidate.input ||
          typeof candidate.input !== "object" ||
          Array.isArray(candidate.input)
        ) {
          throw new Error(
            "Sub-agent durable graph contains a malformed tool_use block."
          )
        }
        if (usesById.has(candidate.id)) {
          throw new Error(
            `Sub-agent durable graph contains duplicate tool_use id ${candidate.id}.`
          )
        }
        const use: DurableToolUse = {
          id: candidate.id,
          name: candidate.name,
          input: candidate.input as Record<string, unknown>,
        }
        uses.push(use)
        usesById.set(use.id, use)
      }
      continue
    }

    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const candidate = block as {
        type?: unknown
        tool_use_id?: unknown
        is_error?: unknown
      }
      if (candidate.type !== "tool_result") continue
      if (typeof candidate.tool_use_id !== "string" || !candidate.tool_use_id) {
        throw new Error(
          "Sub-agent durable graph contains a malformed tool_result block."
        )
      }
      if (!usesById.has(candidate.tool_use_id)) {
        throw new Error(
          `Sub-agent durable graph contains an unmatched tool_result id ${candidate.tool_use_id}.`
        )
      }
      if (results.has(candidate.tool_use_id)) {
        throw new Error(
          `Sub-agent durable graph contains duplicate tool_result id ${candidate.tool_use_id}.`
        )
      }
      if (typeof candidate.is_error !== "boolean") {
        throw new Error(
          `Sub-agent durable tool_result ${candidate.tool_use_id} has no explicit is_error outcome.`
        )
      }
      results.set(candidate.tool_use_id, {
        toolUseId: candidate.tool_use_id,
        isError: candidate.is_error,
        metadata: record.metadata,
      })
    }
  }

  return { uses, results }
}

function assistantLogicalMessageKey(
  record: Pick<
    SessionMessage,
    "uuid" | "logicalParentUuid" | "providerMessageId" | "message"
  >,
  index: number
): string {
  return (
    record.logicalParentUuid ||
    record.providerMessageId ||
    ("id" in record.message ? record.message.id : undefined) ||
    record.uuid ||
    `assistant-fragment-${index}`
  )
}

function assertPresentationMatchesExecution(
  use: DurableToolUse,
  entry: SubagentToolContractEntry,
  result: DurableToolResult,
  presentation: SubagentToolResultPresentationFact
): void {
  if (presentation.capabilityId !== entry.capabilityId) {
    throw new Error(
      `Sub-agent tool_result ${result.toolUseId} presentation capability does not match its frozen tool.`
    )
  }
  const owner = entry.executionOwners[presentation.phase]
  if (owner === null) {
    throw new Error(
      `Sub-agent tool_result ${result.toolUseId} presentation phase is not enabled by its frozen tool.`
    )
  }
  assertFrozenSubagentToolEntryOwnerBinding(entry, owner)
  const expectedProjection = resolveFrozenSubagentToolCallProjection(owner)
  const step = fromJson(ConversationStepSchema, presentation.conversationStep, {
    ignoreUnknownFields: false,
  })
  if (
    step.message.case !== "toolCall" ||
    step.message.value.toolCallId !== use.id
  ) {
    throw new Error(
      `Sub-agent tool_result ${result.toolUseId} presentation does not own its durable tool_use id.`
    )
  }
  if (step.message.value.tool.case !== expectedProjection.toolCallCase) {
    throw new Error(
      `Sub-agent tool_result ${result.toolUseId} presentation case ${String(step.message.value.tool.case)} does not match frozen owner case ${expectedProjection.toolCallCase}.`
    )
  }
}

function resolveDurableWorkspaceMutation(
  entry: SubagentToolContractEntry,
  presentation: SubagentToolResultPresentationFact,
  isError: boolean,
  workspaceScope: WorkspaceScope
): string | undefined {
  const isMutation = isWorkspaceMutationCapability(entry)
  const mutation = presentation.workspaceMutation
  if (!isMutation) {
    if (mutation !== null) {
      throw new Error(
        `Sub-agent capability ${entry.name} recorded a workspace mutation it does not own.`
      )
    }
    return undefined
  }
  if (mutation === null) {
    if (!isError) {
      throw new Error(
        `Successful sub-agent capability ${entry.name} has no canonical workspace mutation path.`
      )
    }
    return undefined
  }
  try {
    const target = workspaceScope.resolveTarget(mutation.absolutePath)
    if (target.absolutePath !== mutation.absolutePath) {
      throw new Error(
        `Sub-agent capability ${entry.name} recorded a non-canonical workspace mutation path.`
      )
    }
    return target.absolutePath
  } catch (error) {
    if (error instanceof WorkspaceScopeError) {
      throw new Error(
        `Sub-agent capability ${entry.name} recorded a workspace mutation outside its frozen scope.`
      )
    }
    throw error
  }
}

function isWorkspaceMutationCapability(
  entry: SubagentToolContractEntry
): boolean {
  return [
    entry.executionOwners.foreground,
    entry.executionOwners.background,
  ].some(
    (owner) =>
      owner?.kind === "cursor-client" &&
      CURSOR_WORKSPACE_MUTATION_DEFINITION_KEYS.has(owner.cursorDefinitionKey)
  )
}

function describeSuccessfulCapability(
  entry: SubagentToolContractEntry,
  input: Readonly<Record<string, unknown>>
): string {
  const owners = [
    entry.executionOwners.foreground,
    entry.executionOwners.background,
  ].filter((owner): owner is SubagentToolExecutionOwner => owner !== null)

  for (const owner of owners) {
    if (owner.kind === "cursor-client") {
      const path = readCanonicalToolString(input.path)
      return path ? `path=${path}` : "completed"
    }
    if (owner.kind === "mcp-client") {
      return `server=${owner.providerIdentifier} tool=${owner.toolName}`
    }
    if (owner.kind === "bridge-inline") {
      if (
        owner.operation === "read_file" ||
        owner.operation === "list_directory"
      ) {
        const path = readCanonicalToolString(input.path)
        return path ? `path=${path}` : "completed"
      }
      if (owner.operation === "run_terminal_command") {
        const command = readCanonicalToolString(input.command)
        return command
          ? `command=${clipEvidenceValue(command, 240)}`
          : "completed"
      }
      if (owner.operation === "grep_search") {
        const pattern = readCanonicalToolString(input.pattern)
        return pattern
          ? `pattern=${clipEvidenceValue(pattern, 240)}`
          : "completed"
      }
      if (owner.operation === "read_mcp_resource") {
        const uri = readCanonicalToolString(input.uri)
        return uri ? `uri=${clipEvidenceValue(uri, 240)}` : "completed"
      }
    }
    if (owner.kind === "bridge-deferred") {
      const query = readCanonicalToolString(input.query)
      return query ? `query=${clipEvidenceValue(query, 240)}` : "completed"
    }
  }
  return "completed"
}

function readCanonicalToolString(value: unknown): string | undefined {
  return typeof value === "string" && value === value.trim() && value.length > 0
    ? value
    : undefined
}

function clipEvidenceValue(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}
