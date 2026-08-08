import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import { AssistantToolBatchService } from "./assistant-tool-batch.service"
import { ContextStateService } from "./context-state.service"
import { SessionStreamService } from "./session-stream.service"
import { ContextProjectionStore } from "./context-projection-store.service"
import { rebuildContextProjectionRecords } from "./context-projection-recovery"
import { ClaudeProjectionStore } from "./claude-projection-store.service"
import { rebuildClaudeProjectionRecords } from "./claude-projection-recovery"
import {
  ContextProjectionHeadStore,
  type ContextProjectionHead,
} from "./context-projection-active-head.store"
import { SnipBoundaryStore } from "./snip-boundary-store.service"
import { SessionMemoryEventStore } from "./session-memory-event-store.service"
import {
  materializeSnipBoundaryRecords,
  mergeSnipBoundariesIntoGraph,
} from "./snip-boundary-projection"
import {
  getCursorUserMessageAction,
  projectCursorFreshHistoryBootstrap,
} from "./cursor-history-projector"
import { TurnId, ConversationId } from "../turn/turn.types"
import {
  CURSOR_SKILL_ACTIVATION_RECEIPTS_METADATA_KEY,
  type CursorSkillActivationReceipt,
} from "../skills/skill-activation-receipt"
import { MessageStore, type PersistedMessage } from "./message-store.service"
import { applyMessageRevisionProjection } from "./message-revision-projection"
import {
  subagentGraphBranchFromRun,
  type SubagentGraphBranch,
} from "./subagent-graph"
import {
  SessionPersistenceService,
  type PersistedSessionActivitySummary,
  type SessionPersistenceSnapshot,
  type SessionRow,
  type SessionTodo,
  type SessionTodoStatus,
} from "./session-persistence.service"
import {
  describeSessionFileStateLimit,
  getSessionFileStateSize,
  isSessionFileStateWithinLimit,
} from "./file-state-limits"
import { ToolCallLedger, type SessionTxn } from "./tool-call-ledger.service"
import {
  ExecDispatchStore,
  type ExecDispatchRecord,
} from "./exec-dispatch-store.service"
import {
  addWorkspaceGrants as applyWorkspaceGrantBatch,
  createSessionWorkspaceFromDeclaration,
  createSessionWorkspaceFromDeclarationWithGrants,
  describeWorkspaceRoots,
  parseConfiguredWorkspaceGrantFile,
  removeWorkspaceGrants as removeWorkspaceGrantBatch,
  replaceConfiguredWorkspaceGrants,
  restoreSessionWorkspace,
  serializeSessionWorkspace,
  type PersistedSessionWorkspaceState,
  type SessionWorkspaceState,
  type WorkspaceGrant,
  WorkspaceSessionStateError,
} from "./workspace-session-state"
import {
  restoreCursorManagedReadResources,
  reconcileCursorManagedPlanRegistry,
  serializeCursorManagedReadResources,
  upsertCursorManagedPlanReadResource,
  type CursorManagedReadResource,
} from "./cursor-managed-read-resource"
import {
  assertContextTokenLimitProvenance,
  resolveSessionContextWindowTransition,
  type ContextTokenLimitSource,
} from "./context-window-transition"
import type {
  ContextCompactionCommit,
  ContextConversationState,
  ContextSessionMemoryEntry,
  ContentBlock,
  ContextTranscriptRecord,
  ContextUsageSnapshot,
  LooseMessageContent,
} from "../../../context/types"
import {
  extractText,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "../../../context/types"
import {
  deriveCompactionHistoryFromTranscript,
  getActiveCompactCommitFromTranscript,
  isMessageRecord,
  isSnipBoundaryRecord,
} from "../../../context/context-transcript-events"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import { ToolResultStorageService } from "../../../context/tool-result-storage.service"
import type { ContextModelProfile } from "../../../context/context-model-profile"
import type {
  BackendType,
  ModelRouteResult,
} from "../../../llm/shared/model-router.service"
import {
  assertCodexRootProviderIdentity,
  createCodexRootProviderIdentity,
  type CodexRootProviderIdentity,
} from "../../../llm/openai/codex-provider-identity"
import { PersistenceService } from "../../../persistence"
import type {
  CursorThinkingLevel,
  McpToolDef,
  ParsedCursorRequest,
} from "../tools/cursor-request-parser"
import {
  CURSOR_HOOK_ADDITIONAL_CONTEXTS_METADATA_KEY,
  isCursorHookAdditionalContextEvent,
  type CursorAgentHookStep,
  type CursorHookAdditionalContextReceipt,
} from "../hooks/cursor-hook-contract"
import {
  EMPTY_SUBAGENT_MODEL_OVERRIDES,
  type ResolvedSubagentOverride,
  type SubagentModelOverridesMap,
} from "../subagents/subagent-model-override"
import {
  EMPTY_SELECTED_SUBAGENT_MODELS,
  type SelectedSubagentModelCatalog,
} from "../subagents/subagent-model-selection"
import type { SubagentDefinition } from "../subagents/types"
import type { ParentMcpToolSnapshot } from "../tools/mcp-call-contract"
import { safeJsonStringify } from "../safe-json"
import type {
  DeferredToolDescriptor,
  ToolDefinition,
} from "../tools/cursor-tool-mapper"
import type { EditFailureSelection } from "../tools/tool-protocol-helpers"
import {
  type BridgeGoalState,
  deserializeBridgeGoalState,
  serializeBridgeGoalState,
} from "../tools/goal-state"
import type {
  PendingToolExecutionState,
  ToolExecutionOwner,
  ToolExecutionRecoveryReason,
  ToolExecutionStatus,
} from "./tool-execution-types"
import { type SessionTaskBudgetState } from "./task-budget-state"
import { type ToolInterruptionReason } from "./tool-interruption"
import {
  CLAUDE_CONVERSATION_PROJECTION_LOCAL_KEY,
  assertSameProjectionOwner,
  createMainProjectionOwner,
  createProviderProjectionRef,
  type ProjectionOwner,
  type SubagentProjectionBranchSnapshot,
} from "./projection-owner"
import {
  SubagentRunStore,
  type SubagentRunRecord,
} from "./subagent-run-store.service"
import { SubagentBranchStore } from "./subagent-branch-store.service"
import { deriveSubagentGraphExecutionMetrics } from "../subagents/subagent-graph-metrics"

export interface ClearSessionCacheResult {
  clearedLoadedSessions: number
  clearedPersistedSessions: number
  clearedToolResultDirs: number
  warnings: string[]
}

export type SessionCleanupHandler = (
  conversationId: string,
  session: SessionRecord
) => void | Promise<void>

/**
 * A runtime-owned activity source which must prevent lifecycle eviction.
 * Backend stream ownership lives outside the session cache, so it reports
 * through this narrow contract instead of teaching Lifecycle about transport
 * internals.
 */
export type SessionBusyProbe = (
  conversationId: string,
  session: SessionRecord
) => boolean

/**
 * Content block types for messages
 */
export type MessageContent = LooseMessageContent

export type SessionRequestRefreshScope = "full" | "partial" | "control"

export function resolveSessionRequestRefreshScope(
  request?: Pick<
    ParsedCursorRequest,
    | "sessionUpdateScope"
    | "isAgentControlMessage"
    | "isResumeAction"
    | "newMessage"
    | "attachedImages"
  >
): SessionRequestRefreshScope {
  if (!request) return "control"
  if (request.sessionUpdateScope) return request.sessionUpdateScope
  if (request.isAgentControlMessage || request.isResumeAction) return "control"
  if (request.newMessage || (request.attachedImages?.length ?? 0) > 0) {
    return "full"
  }
  return "partial"
}

export function canClearSessionRequestScopedFields(
  request?: Pick<
    ParsedCursorRequest,
    | "sessionUpdateScope"
    | "isAgentControlMessage"
    | "isResumeAction"
    | "newMessage"
    | "attachedImages"
  >
): boolean {
  return resolveSessionRequestRefreshScope(request) === "full"
}

export interface SessionWorkspaceRefreshResult {
  readonly workspace?: SessionWorkspaceState
  /** The primary root changed or the workspace identity was replaced. */
  readonly reloadConfiguredWorkspaceGrants: boolean
}

/**
 * Apply a parsed workspace declaration at the lifecycle boundary.
 *
 * A full request without a declaration explicitly clears the workspace. A
 * partial or control request without one retains the already-bound scope.
 * Any incoming declaration remains protocol-authoritative, including on a
 * control frame. Session grants survive only when its IDE root set is
 * unchanged, while config grants are reloaded whenever the primary changes.
 */
export function resolveSessionWorkspaceRefresh(input: {
  readonly current?: SessionWorkspaceState
  readonly request?: Pick<
    ParsedCursorRequest,
    "workspaceDeclaration" | "resumeWorkspaceReferences"
  >
  readonly refreshScope: SessionRequestRefreshScope
}): SessionWorkspaceRefreshResult {
  const { current, request, refreshScope } = input
  const incoming = request?.workspaceDeclaration
  if (!incoming) {
    if (refreshScope === "full") {
      return { workspace: undefined, reloadConfiguredWorkspaceGrants: false }
    }
    return { workspace: current, reloadConfiguredWorkspaceGrants: false }
  }

  if (!current) {
    return {
      workspace: createSessionWorkspaceFromDeclaration(incoming),
      reloadConfiguredWorkspaceGrants: true,
    }
  }

  const identityChanged =
    current.scope.workspaceIdentity !== incoming.scope.workspaceIdentity
  if (identityChanged) {
    return {
      workspace: createSessionWorkspaceFromDeclaration(incoming),
      reloadConfiguredWorkspaceGrants: true,
    }
  }

  const primaryChanged =
    current.scope.primaryRoot !== incoming.scope.primaryRoot
  const retainedGrants = primaryChanged
    ? current.grants.filter((grant) => grant.source === "session")
    : current.grants
  return {
    workspace: createSessionWorkspaceFromDeclarationWithGrants(
      incoming,
      retainedGrants
    ),
    reloadConfiguredWorkspaceGrants: primaryChanged,
  }
}

/**
 * Resume references are only useful when they name one of the already-bound
 * IDE roots. They are never converted into a Scope or an additional grant.
 */
export function matchResumeWorkspaceReferences(
  workspace: SessionWorkspaceState | undefined,
  references: ParsedCursorRequest["resumeWorkspaceReferences"]
): readonly NonNullable<
  ParsedCursorRequest["resumeWorkspaceReferences"]
>[number][] {
  if (!workspace || !references || references.length === 0) {
    return Object.freeze([])
  }
  const ideRoots = new Set(workspace.scope.ideRoots)
  return Object.freeze(
    references.filter((reference) => ideRoots.has(reference.path))
  )
}

/**
 * Cursor's plan registry is an authoritative read-capability snapshot only
 * when ConversationStateStructure is present. Frames without conversation
 * state retain the current registry regardless of their request refresh scope.
 */
export function resolveSessionManagedReadResourcesRefresh(input: {
  readonly current: readonly CursorManagedReadResource[]
  readonly request?: Pick<ParsedCursorRequest, "cursorManagedReadResources">
}): readonly CursorManagedReadResource[] {
  if (input.request?.cursorManagedReadResources !== undefined) {
    return reconcileCursorManagedPlanRegistry(
      input.current,
      input.request.cursorManagedReadResources
    )
  }
  return input.current
}

/**
 * Mirrors claude-code/src/services/api/claude.ts AssistantMessage / UserMessage:
 * `{type, uuid, timestamp, message: {...}}`. A streaming assistant turn yields
 * one of these per content block (split-sibling — same `message.id`, distinct
 * `uuid`); send-time normalization merges siblings by `message.id`. See
 * /Users/recronin/.claude/plans/think-users-recronin-repositories-vscod-hashed-chipmunk.md.
 */
export interface SessionMessageGraphIdentity {
  parentUuid?: string
  logicalParentUuid?: string
  sourceToolAssistantUuid?: string
  provider?: string
  providerMessageId?: string
  blockOccurrence?: number
  turnId?: string
  threadId?: string
  branchId?: string
  agentId?: string
  isSidechain?: boolean
  forkSourceUuid?: string
  forkLineage?: string[]
  /** Retained in the durable graph but omitted from future provider prompts. */
  excludedFromProviderProjection?: boolean
  /**
   * Protocol facts attached to the durable graph fragment. They are persisted
   * as `session_messages.metadata_json` and never enter provider message
   * content.
   */
  metadata?: Record<string, unknown>
}

export interface SessionAssistantMessage extends SessionMessageGraphIdentity {
  type: "assistant"
  uuid: string
  timestamp: string
  /** Backend request id, when available (Anthropic only). */
  requestId?: string
  message: {
    /** Provider message id used as the split-sibling merge key when present. */
    id?: string
    role: "assistant"
    content: MessageContent
    /** Filled by `mutateLastAssistantUsage` on `message_delta`. */
    usage?: ContextUsageSnapshot
    stop_reason?: string | null
    model?: string
  }
  isApiErrorMessage?: boolean
}

export interface SessionUserMessage extends SessionMessageGraphIdentity {
  type: "user"
  uuid: string
  timestamp: string
  message: {
    role: "user"
    content: MessageContent
  }
  /** cc-style isMeta — message contributed for context plumbing only,
   *  hidden from the IDE-facing transcript. */
  isMeta?: boolean
  /** Tool execution payload attached for the duration of the originating
   *  turn; cleared at the next iteration to avoid memory growth. Mirrors
   *  cc query.ts:530-538. */
  toolUseResult?: unknown
}

export type SessionMessage = SessionAssistantMessage | SessionUserMessage

/**
 * Distributive `Omit<SessionMessage, "uuid" | "timestamp">`. Plain
 * `Omit` over a union narrows to the intersection of fields, which
 * silently drops user-only props like `toolUseResult` / `isMeta`. This
 * variant preserves the per-arm shape so callers can build a
 * SessionUserMessage init object that still carries those fields.
 */
export type SessionMessageInit = SessionMessage extends infer T
  ? T extends SessionMessage
    ? Omit<T, "uuid" | "timestamp">
    : never
  : never

/**
 * Capture an input array onto the session as a *frozen* cache-key value.
 *
 * The prepared-tool-build memo in `cursor-connect-stream.service` uses
 * captured tool-definition arrays by reference as part of its cache key.
 * If a caller later mutated the same array in place
 * (`push`, `splice`, …), the cache key would silently desynchronise
 * from the cached value.
 *
 * Freezing the captured copy turns any such mutation into a synchronous
 * `TypeError` instead of a silent stale-cache bug, which is the exact
 * defense-in-depth invariant we want.  We freeze a *copy* of the input
 * rather than the input itself so we don't mutate the caller's array
 * (callers may continue to mutate the array they passed in — they just
 * won't observe their writes through the session).
 *
 * The freeze is shallow.  Element-level mutation (e.g. editing an
 * `McpToolDef.input_schema`) would still desync the cache, but no
 * code path in the bridge mutates these descriptors after parser
 * construction, so the deep-freeze cost would not buy any extra
 * invariant.
 *
 * For optional fields, `undefined` flows through unchanged so callers
 * that distinguish "absent" from "empty" keep that distinction.
 */
export function freezeCacheKeyArray<T>(input: T[] | undefined): T[] | undefined
export function freezeCacheKeyArray<T>(
  input: T[] | undefined,
  fallback: T[]
): T[]
export function freezeCacheKeyArray<T>(
  input: T[] | undefined,
  fallback?: T[]
): T[] | undefined {
  if (input === undefined) {
    return fallback === undefined
      ? undefined
      : (Object.freeze([...fallback]) as unknown as T[])
  }
  return Object.freeze([...input]) as unknown as T[]
}

/** Canonical factory for a durable SessionMessage union member. */
export function makeSessionMessage(
  role: "user" | "assistant",
  content: MessageContent,
  extras?: {
    /** Anthropic message id — used for split-sibling merge during send. */
    messageId?: string
    /** Pre-allocated uuid (falls back to crypto.randomUUID). */
    uuid?: string
    /** Pre-allocated ISO timestamp (falls back to now). */
    timestamp?: string
    /** Backend request id (Anthropic only). */
    requestId?: string
    isMeta?: boolean
    /** Raw tool execution payload — see SessionUserMessage.toolUseResult.
     *  Cleared on the next send via clearToolUseResultsBeforeNextSend
     *  (mirrors cc query.ts:530-538). */
    toolUseResult?: unknown
    parentUuid?: string
    logicalParentUuid?: string
    sourceToolAssistantUuid?: string
    provider?: string
    providerMessageId?: string
    blockOccurrence?: number
    turnId?: string
    threadId?: string
    branchId?: string
    agentId?: string
    isSidechain?: boolean
    forkSourceUuid?: string
    forkLineage?: string[]
    excludedFromProviderProjection?: boolean
    metadata?: Record<string, unknown>
  }
): SessionMessage {
  const uuid = extras?.uuid ?? crypto.randomUUID()
  const timestamp = extras?.timestamp ?? new Date().toISOString()
  if (role === "assistant") {
    return {
      type: "assistant",
      uuid,
      timestamp,
      ...(extras?.parentUuid ? { parentUuid: extras.parentUuid } : {}),
      ...(extras?.logicalParentUuid
        ? { logicalParentUuid: extras.logicalParentUuid }
        : {}),
      ...(extras?.sourceToolAssistantUuid
        ? { sourceToolAssistantUuid: extras.sourceToolAssistantUuid }
        : {}),
      ...(extras?.provider ? { provider: extras.provider } : {}),
      ...(extras?.providerMessageId
        ? { providerMessageId: extras.providerMessageId }
        : {}),
      ...(extras?.blockOccurrence !== undefined
        ? { blockOccurrence: extras.blockOccurrence }
        : {}),
      ...(extras?.turnId ? { turnId: extras.turnId } : {}),
      ...(extras?.threadId ? { threadId: extras.threadId } : {}),
      ...(extras?.branchId ? { branchId: extras.branchId } : {}),
      ...(extras?.agentId ? { agentId: extras.agentId } : {}),
      ...(extras?.isSidechain ? { isSidechain: true } : {}),
      ...(extras?.forkSourceUuid
        ? { forkSourceUuid: extras.forkSourceUuid }
        : {}),
      ...(extras?.forkLineage ? { forkLineage: [...extras.forkLineage] } : {}),
      ...(extras?.excludedFromProviderProjection
        ? { excludedFromProviderProjection: true }
        : {}),
      ...(extras?.metadata
        ? { metadata: structuredClone(extras.metadata) }
        : {}),
      ...(extras?.requestId ? { requestId: extras.requestId } : {}),
      message: {
        ...(extras?.messageId ? { id: extras.messageId } : {}),
        role: "assistant",
        content,
      },
    }
  }
  return {
    type: "user",
    uuid,
    timestamp,
    ...(extras?.parentUuid ? { parentUuid: extras.parentUuid } : {}),
    ...(extras?.logicalParentUuid
      ? { logicalParentUuid: extras.logicalParentUuid }
      : {}),
    ...(extras?.sourceToolAssistantUuid
      ? { sourceToolAssistantUuid: extras.sourceToolAssistantUuid }
      : {}),
    ...(extras?.provider ? { provider: extras.provider } : {}),
    ...(extras?.providerMessageId
      ? { providerMessageId: extras.providerMessageId }
      : {}),
    ...(extras?.blockOccurrence !== undefined
      ? { blockOccurrence: extras.blockOccurrence }
      : {}),
    ...(extras?.turnId ? { turnId: extras.turnId } : {}),
    ...(extras?.threadId ? { threadId: extras.threadId } : {}),
    ...(extras?.branchId ? { branchId: extras.branchId } : {}),
    ...(extras?.agentId ? { agentId: extras.agentId } : {}),
    ...(extras?.isSidechain ? { isSidechain: true } : {}),
    ...(extras?.forkSourceUuid
      ? { forkSourceUuid: extras.forkSourceUuid }
      : {}),
    ...(extras?.forkLineage ? { forkLineage: [...extras.forkLineage] } : {}),
    ...(extras?.excludedFromProviderProjection
      ? { excludedFromProviderProjection: true }
      : {}),
    ...(extras?.metadata ? { metadata: structuredClone(extras.metadata) } : {}),
    ...(extras?.isMeta ? { isMeta: true } : {}),
    ...(extras?.toolUseResult !== undefined
      ? { toolUseResult: extras.toolUseResult }
      : {}),
    message: {
      role: "user",
      content,
    },
  }
}

/** Canonical pure projection of an accepted durable graph row. */
export function projectPersistedMessageToSessionMessage(
  message: PersistedMessage
): SessionMessage {
  const extras = {
    uuid: message.uuid,
    timestamp: new Date(message.timestamp).toISOString(),
    parentUuid: message.parentUuid,
    logicalParentUuid: message.logicalParentUuid,
    sourceToolAssistantUuid: message.sourceToolAssistantUuid,
    provider: message.provider,
    providerMessageId: message.providerMessageId,
    blockOccurrence: message.blockOccurrence,
    turnId: message.turnId,
    threadId: message.threadId,
    branchId: message.branchId,
    agentId: message.agentId,
    isSidechain: message.isSidechain,
    forkSourceUuid: message.forkSourceUuid,
    forkLineage: message.forkLineage ? [...message.forkLineage] : undefined,
    metadata: message.metadata,
  }
  if (message.role === "assistant") {
    return makeSessionMessage("assistant", message.content as MessageContent, {
      ...extras,
      messageId: message.providerMessageId,
    })
  }
  return makeSessionMessage("user", message.content as MessageContent, {
    ...extras,
    isMeta: message.isMeta,
  })
}

/**
 * Storage layer keeps every block — including thinking — verbatim. Send-time
 * sanitization (per backend constraints) lives in
 * `apps/protocol-bridge/src/llm/shared/normalize-for-api.ts` and is invoked
 * from the buildMessages exits in cursor-connect-stream.service.ts.
 *
 * The previous write-time sanitize used to drop unsigned thinking blocks
 * before they reached the session, which made the original reasoning
 * unrecoverable. See plan
 * .claude/plans/think-users-recronin-repositories-vscod-hashed-chipmunk.md
 * for the rationale.
 */

/** Reasoning remains on durable assistant graph fragments. Kiro derives a
 *  bounded text preamble from its exact request candidate, while Codex keeps
 *  the same continuity through its native rollout. */

export type { SessionTodoStatus } from "./session-persistence.service"

export interface SessionTodoItem {
  id: string
  content: string
  status: SessionTodoStatus
  createdAt: number
  updatedAt: number
  dependencies: string[]
}

export interface InterruptedToolCallInfo {
  toolCallId: string
  toolName: string
  sentAt: Date
  reason: ToolInterruptionReason
  detail?: string
}

/**
 * Immediate, explicit interruption data. This is only used by a caller that
 * has received a real cancellation/supersession signal; it is never a
 * process-restart surrogate.
 */
export interface InterruptedToolBatch {
  interruptedToolCalls: InterruptedToolCallInfo[]
  interruptedSubAgent?: {
    subagentId: string
    parentToolCallId: string
    turnCount: number
    toolCallCount: number
  }
}

export interface SessionActiveToolBatch {
  batchId: string
  /** Stable root user request shared by all continuation graph turns. */
  topLevelTurnId: TurnId
  /** Graph turn that emitted the assistant tool_use blocks in this batch. */
  graphTurnId: TurnId
  /** Exact accepted provider route that emitted this batch. */
  readonly providerBackend: BackendType
  readonly providerModel: string
  readonly toolUseSummaryOverride?: ResolvedSubagentOverride
  toolCallIds: string[]
  assistantText: string
  readOnly: boolean
  startedAt: number
  tools: Array<{
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    resultSummary?: string
  }>
}

export interface SessionTopLevelContinuationBudget {
  continuationCount: number
  lastHistoryTokens: number
  lastDeltaTokens: number
  startedAt: number
}

export interface SessionTopLevelAgentTurnState {
  /** Absent only while the session has no active top-level user request. */
  topLevelTurnId?: TurnId
  llmTurnCount: number
  continuationBudget: SessionTopLevelContinuationBudget
  activeToolBatch?: SessionActiveToolBatch
  /** Current provider-context revision for this top-level user request. */
  codexContextRevision: number
  /** Revision installed by the last accepted Codex provider request. */
  acceptedCodexContextRevision?: number
}

export type SessionBackgroundCommandStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"

export interface SessionBackgroundCommand {
  commandId: string
  originToolCallId: string
  execIds: number[]
  command: string
  cwd: string
  pid?: number
  terminalsFolder?: string
  status: SessionBackgroundCommandStatus
  stdout: string[]
  stderr: string[]
  exitCode?: number
  msToWait?: number
  backgroundReason?: number
  lastTerminalFileLength?: number
  startedAt: number
  updatedAt: number
  completedAt?: number
}

export interface SessionReadSnapshot {
  filePath: string
  startLine?: number
  endLine?: number
  content: string
  capturedAt: number
  sourceToolName: string
  /**
   * Disk mtime (ms since epoch) of the underlying file at the moment the
   * snapshot was captured. Set when `addReadSnapshot` was able to stat the
   * absolute path on the bridge host; left undefined for paths the bridge
   * cannot stat (relative paths without resolved cwd, virtual sources,
   * stat errors).
   *
   * Used by `getLatestReadSnapshot` to detect external disk writes (e.g.
   * shell scripts overwriting a smoke fixture between two `read_file` calls
   * inside one chat session) and treat the snapshot as stale instead of
   * reusing the in-memory copy that no longer matches disk. Without this
   * guard the edit failure-projection (`latest_snapshot_source: read_file`
   * + cached `current_text`) gives the model a phantom view of the file
   * and the next edit_file_v2 round can apply on top of stale content.
   */
  diskMtimeMs?: number
  /** Disk size (bytes) at capture time; co-checked with mtime. */
  diskSizeBytes?: number
}

/**
 * 排队中的 edit_file_v2 调度记录。
 *
 * 当同一 path 上已有 holder（正在 read→write 进程中）时，后续 edit
 * 不直接派发 readArgs，而是入队等待 holder 释放槽。
 */
export interface QueuedEditDispatch {
  toolCallId: string
  path: string
  enqueuedAt: number
}

export interface EditFailureContext extends EditFailureSelection {
  filePath: string
  reason:
    | "missing_content"
    | "empty_target"
    | "range_invalid"
    | "target_not_found"
    | "ambiguous_target"
    | "unsafe_overwrite"
    | "missing_search_replace"
    | "empty_search"
    | "invalid_chunk"
    | "noop_identical"
    | "self_swallowing_replace"
  matchCountInFile?: number
}

export type SessionTranscriptEventKind =
  | "session_restored"
  | "user_message"
  | "assistant_message"
  | "tool_use"
  | "tool_result"

export interface SessionTranscriptEvent {
  id: string
  seq: number
  kind: SessionTranscriptEventKind
  recordId?: string
  role?: "user" | "assistant"
  messageId?: string
  toolUseId?: string
  toolName?: string
  contentChars?: number
  createdAt: number
  turnId?: string
  summary?: string
}

/**
 * Cached output of `optimizeImplicitCodexTools` +
 * `buildToolsForApiWithDefer` for the active turn.
 *
 * The cursor stream service rebuilds this on every tool-result
 * continuation; the result is fully determined by a small set of inputs
 * (model → backend route, supportedTools, mcpToolDefs, useWeb,
 * discoveredTools size, project cwd, subagent set signature).  When all
 * those inputs are unchanged, every continuation in a turn produces a
 * byte-identical tools array, but the build path also performs
 * synchronous file IO via `SubagentRegistryService.getAll()` to scan
 * `~/.cursor/agents` and `<cwd>/.cursor/agents`.  Caching the result
 * keyed by the input snapshot lets us skip both the IO and the
 * provenance / defer-policy work on every round after the first.
 *
 * Lifetime is one top-level user turn. The stream boundary clears it before
 * the first request of the next user turn, so agent-file edits become visible
 * at a deterministic boundary while every continuation and child spawn in the
 * current turn sees exactly the catalog advertised to the parent model.
 */
export interface SessionPreparedToolBuild {
  /** Snapshot of the inputs that fully determine the cached output. */
  key: {
    model: string
    backend: BackendType
    supportedToolsRef: string[]
    mcpToolDefsRef: ParsedCursorRequest["mcpToolDefs"] | undefined
    useWeb: boolean
    discoveredToolsSize: number
    projectCwd: string
    selectedSubagentModelsRef: SelectedSubagentModelCatalog
    /**
     * Frozen definition and capability fingerprints for every visible child.
     * This is diagnostic cache identity only; the full definitions below are
     * the spawn authority for the whole top-level user turn.
     */
    subagentSignature: string
  }
  /** Resolved upstream backend + concrete model id. */
  route: ModelRouteResult
  /** Output of `optimizeImplicitCodexTools` (input to the defer split). */
  optimizedTools: string[]
  /** Tools array sent to the upstream this turn. */
  apiTools: ToolDefinition[]
  /** Deferred catalog advertised in the system prompt this turn. */
  deferred: DeferredToolDescriptor[]
  /** Frozen MCP identity/schema catalog advertised for this parent turn. */
  mcpToolDefsSnapshot: readonly ParentMcpToolSnapshot[]
  /**
   * Exact visible agent definitions loaded at the new-user-turn boundary.
   * Task descriptions and every spawn in that turn consume this same
   * snapshot; tool continuations never rescan agent files or drift to a
   * definition the parent model was not shown.
   */
  subagentDefinitions: readonly SubagentDefinition[]
}

/**
 * Chat session state for bidirectional streaming
 */
/**
 * Lifecycle-domain fields owned by SessionLifecycleService.
 *
 * Identity, configuration, persistence triggers, abort wiring and
 * the slow-changing per-request context (project / cursor rules /
 * supported tools). Everything in this slice has at most one writer
 * per turn — the lifecycle service.
 */
export interface SessionLifecycleRecord {
  conversationId: string
  model: string

  /**
   * Durable Codex-native root identity. This is independent of Cursor's
   * conversation id and of every local provider projection key.
   */
  codexProviderIdentity: CodexRootProviderIdentity

  // Per-subagent model selection captured from
  // AgentRunRequest.subagent_model_overrides (proto field 20).
  subagentModelOverrides: SubagentModelOverridesMap

  /** Request-scoped Cursor allow-list for invocation-level task models. */
  selectedSubagentModels: SelectedSubagentModelCatalog

  /** Exact Cursor protocol enum; persisted and replayed without coercion. */
  thinkingLevel: CursorThinkingLevel
  thinkingDetailsRequested: boolean
  isAgentic: boolean
  supportedTools: string[]
  discoveredTools: Set<string>
  deferredToolCatalog?: DeferredToolDescriptor[]
  preparedToolBuild?: SessionPreparedToolBuild
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  /** Browser MCP page state, used to gate page-dependent tool calls. */
  browserContext?: {
    hasPage: boolean
    lastToolName?: string
    lastUrl?: string
    updatedAt: number
  }
  useWeb: boolean
  requestContextEnv?: ParsedCursorRequest["requestContextEnv"]
  createdAt: Date
  lastActivityAt: Date

  /**
   * Lifecycle-owned workspace state. Its Scope is the only executable
   * filesystem authority for this session; presentation is immutable
   * metadata and cannot be interpreted as roots.
   */
  workspace?: SessionWorkspaceState
  /** Exact read-only files granted by Cursor conversation protocol state. */
  cursorManagedReadResources: readonly CursorManagedReadResource[]
  codeChunks?: ParsedCursorRequest["codeChunks"]
  cursorRules?: ParsedCursorRequest["cursorRules"]
  skillOptions?: ParsedCursorRequest["skillOptions"]
  selectedCursorRulePaths?: ParsedCursorRequest["selectedCursorRulePaths"]
  selectedCursorRuleNames?: ParsedCursorRequest["selectedCursorRuleNames"]
  activeCursorSkillNames?: string[]
  cursorCommands?: ParsedCursorRequest["cursorCommands"]
  customSystemPrompt?: ParsedCursorRequest["customSystemPrompt"]
  /** SessionStart hook context supplied by Cursor in RequestContext. */
  hooksAdditionalContext?: ParsedCursorRequest["hooksAdditionalContext"]
  /** Durable ConversationStateStructure.goal_state for the composer session. */
  goalState?: BridgeGoalState
  /** Durable ConversationStateStructure.is_root_project_conversation. */
  isRootProjectConversation?: boolean
  explicitContext?: string
  contextTokenLimit?: number
  contextTokenLimitSource?: ContextTokenLimitSource
  contextMaxMode?: boolean
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>
  /** Request-scoped Agent v1 ExecuteHook capabilities advertised by Cursor. */
  hookConfiguredSteps: readonly CursorAgentHookStep[]

  /** Config roots are loaded once for the current workspace primary root. */
  configuredWorkspaceGrantsLoadedForPrimary?: string

  /** Deferred control-frame continuations enqueued mid-turn. */
  deferredControlContinuations: Array<{
    parsed: ParsedCursorRequest
    payload: string
    kind:
      | "async_user_response"
      | "background_task_notification"
      | "goal_continuation"
    streamId: string
    reason: string
    enqueuedAt: number
  }>

  /** Last assistant model id seen — used by send-time thinking sanitize. */
  lastAssistantModel?: string
  /** Last assistant backend (anthropic / codex / google etc). */
  lastAssistantBackend?: BackendType
  lastToolUseSummary?: string
}

/**
 * Context-state-domain fields owned by ContextStateService.
 *
 * Transcript, message records, transcript events, cursor turn state
 * machine, task budget, read paths / file states / tool metrics,
 * snip projection and per-session counters.
 */
export interface ContextStateRecord {
  /** Canonical parent-session projection. UI and session memory stay here. */
  mainProjection: MountedContextProjection
  /** Independently mounted child branch projections, keyed by owner key. */
  childProjections: Map<string, MountedContextProjection>
  taskBudgetState?: SessionTaskBudgetState
  topLevelAgentTurnState: SessionTopLevelAgentTurnState

  readPaths: Set<string>
  readSnapshots: SessionReadSnapshot[]
  fileStates: Map<string, { beforeContent: string; afterContent: string }>
  toolMetrics: SessionToolMetrics
  messageBlobIds: string[]
  turns: string[]
  currentAssistantMessage?: Record<string, unknown>

  // Protocol counters.
  stepId: number
  execId: number

  /** Pending request context ledger projection. */
  pendingRequestContextLedger?: {
    promptTokenCount: number
    contextProfile: ContextModelProfile
    recordedCompactionId?: string
    attachmentFingerprint?: string
  }

  /** Todo list owned by the session todo manager. */
  todos: SessionTodoItem[]
}

/**
 * One mounted read model derived from exactly one durable graph owner.
 * `branchSnapshot` is mandatory for children and absent for the main graph.
 */
export interface MountedContextProjection {
  readonly owner: ProjectionOwner
  messages: SessionMessage[]
  generation: number
  messageRecords: ContextTranscriptRecord[]
  transcriptEvents: SessionTranscriptEvent[]
  nextTranscriptEventSeq: number
  contextState: ContextConversationState
  usedTokens: number
  branchSnapshot?: SubagentProjectionBranchSnapshot
}

type PreparedInitialGraphProjection = Pick<
  MountedContextProjection,
  | "messages"
  | "generation"
  | "messageRecords"
  | "transcriptEvents"
  | "nextTranscriptEventSeq"
  | "contextState"
>

export interface RetiredToolExecMapping {
  toolCallId: string
  toolName: string
  retiredAt: number
}

/**
 * Stream-domain fields owned by SessionStreamService.
 *
 * Background commands, edit-path queue, interaction queries, exec-id
 * mapping, current BiDi stream identifier.
 */
export interface SessionStreamRecord {
  /** ExecServerMessage.id → toolCallId mapping for control messages. */
  pendingToolCallByExecId: Map<number, string>
  /** Recently detached exec ids. Used to ignore late Cursor result frames. */
  retiredToolCallByExecId: Map<number, RetiredToolExecMapping>
  /** Current BiDi stream id (rotated on supersede). */
  currentStreamId: string

  /** Per-path edit serialisation: holder + queue. */
  editPathHolderByPath: Map<string, string>
  editPathQueueByPath: Map<string, QueuedEditDispatch[]>

  /** Active InteractionQuery entries awaiting client response. */
  pendingInteractionQueries: Map<
    number,
    {
      resolve: (response: any) => void
      reject: (error: Error) => void
      queryType: string
      payload?: Record<string, unknown>
      turnId?: TurnId
      kind?: string
      deadline?: number
      streamId?: string
      blocksTurn?: boolean
      createdAt: number
    }
  >
  interactionQueryId: number
}

/**
 * The lifecycle session slice. ContextState and SessionStream keep their own
 * records; callers must request those domains explicitly.
 */
export type SessionRecord = SessionLifecycleRecord

/**
 * Pending tool call ledger entry — what the bridge needs to remember
 * about a tool call so it can: (a) abort it on cancel, (b) match an
 * inbound tool_result back to its dispatcher, (c) preserve the exact
 * durable client terminal wait across a process restart. Inlined from the deleted
 * `turn/pending-tool-store.ts` module.
 */
export interface PendingToolEntry<TPayload = unknown> {
  readonly conversationId: ConversationId
  readonly turnId: TurnId
  readonly toolCallId: string
  readonly toolName: string
  readonly startedAt: number
  readonly recoveredFromCrash?: boolean
  payload?: TPayload
}

interface PendingInternalEntry<TPayload> extends PendingToolEntry<TPayload> {
  resolved: boolean
}

export interface PendingToolCall extends PendingToolExecutionState {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  historyToolName?: string
  historyToolInput?: Record<string, unknown>
  codexToolCallType?: "function" | "custom" | "tool_search"
  /**
   * Immutable skill-state transitions prepared with the durable tool_use.
   * They are published only after the matching tool_result graph commit.
   */
  skillActivationReceipts?: readonly CursorSkillActivationReceipt[]
  hookAdditionalContexts?: readonly CursorHookAdditionalContextReceipt[]
  /**
   * Records that this invocation has no Cursor ToolCall UI lifecycle. The
   * matching tool result still closes the durable graph edge and remains in
   * provider history; only started/completed client envelopes are omitted.
   */
  clientLifecycleSuppression?: PendingToolClientLifecycleSuppression
  toolFamilyHint?: "mcp" | "edit" | "web_fetch"
  modelCallId: string
  startedEmitted: boolean
  sentAt: Date
  execIds: Set<number>
  editApplyWarning?: string
  editFailureContext?: EditFailureContext
  /**
   * Set when `applyEditInputToFileText` collapsed the edit to a
   * literal no-op (search === replace) rather than a real failure.
   * Result formatter reads this to emit a friendly success result
   * (`[edit applied: no-op]`) instead of `[edit_apply_failed]`. Mutex
   * with `editApplyWarning`: when noopReason is set, warning MUST be
   * undefined.
   *
   * Only `identical_search_replace` is a real noop. Genuine apply
   * failures (target_not_found, ambiguous_target, range_invalid, etc.)
   * MUST leave this undefined and let `editApplyWarning` drive the
   * `[edit_apply_failed]` projection — see the dispatcher's
   * `computedEdit.fileText === editPending.beforeContent` fallback in
   * cursor-connect-stream.service.ts (smoke-regression #3g fix).
   */
  editNoopReason?: "identical_search_replace"
  beforeContent?: string // File content before edit (for edit tools)
  afterContent?: string // File content after edit (computed from applyEditInputToFileText)
  /**
   * For edit_file_v2 invocations: the resolved target file path used to
   * coordinate path-level serialization (see SessionRecord.editPathHolderByPath
   * and SessionRecord.editPathQueueByPath). Stored at registration time so the
   * detach path can release the path slot regardless of which exec id triggers
   * cleanup.
   */
  editPath?: string
  // Which BiDi stream this tool call was dispatched on
  streamId: string
  // Shell stream accumulation (for streaming shell output)
  shellStreamOutput?: {
    stdout: string[]
    stderr: string[]
    exitCode?: number
    signal?: string
    started: boolean
  }
  /**
   * Immutable durable sidechain identity for a sub-agent exec.
   *
   * This is the only child-execution marker. A live worker may retain an
   * exact waiter, but ownership, restart routing, and graph provenance all
   * come from this assistant tool-use receipt.
   */
  sidechainOwner?: SubagentSidechainToolOwner
}

export interface PendingToolClientLifecycleSuppression {
  readonly reason: string
  readonly family?: string
}

/**
 * Exact graph ownership recovered from the assistant `tool_use` row that
 * opened a sub-agent execution.  It is intentionally not inferred from a
 * tool name, a transient waiter, or a parent task id.
 */
export interface SubagentSidechainToolOwner {
  readonly agentId: string
  readonly threadId: string
  readonly branchId: string
  readonly turnId: TurnId
  readonly forkSourceUuid: string
  readonly forkLineage: readonly string[]
  /** Durable assistant row that contains the sidechain tool_use block. */
  readonly sourceToolAssistantUuid: string
}

export interface SessionToolMetrics {
  completedCalls: number
  shellCalls: number
  editCalls: number
  mcpCalls: number
  otherCalls: number
  totalDurationMs: number
  lastCompletedAt: number | null
}

export interface ChatSessionAnalyticsEntry {
  conversationId: string
  loaded: boolean
  active: boolean
  model: string
  createdAt: string
  lastActivityAt: string
  idleMs: number
  pendingToolCalls: number
  completedToolCalls: number
  shellToolCalls: number
  editToolCalls: number
  mcpToolCalls: number
  otherToolCalls: number
  totalToolDurationMs: number
  avgToolDurationMs: number | null
  readFiles: number
  editedFiles: number
  linesAdded: number
  linesRemoved: number
  contextTokenLimit: number | null
  contextMaxMode: boolean | null
  usedContextTokens: number | null
  contextUsagePct: number | null
  requestedMaxOutputTokens: number | null
  subAgentTurns: number
  subAgentToolCalls: number
}

export interface ChatSessionAnalyticsSummary {
  timestamp: string
  totals: {
    totalSessions: number
    activeSessions: number
    loadedSessions: number
    persistedOnlySessions: number
    pendingToolCalls: number
    completedToolCalls: number
    totalToolDurationMs: number
    avgToolDurationMs: number | null
    readFiles: number
    editedFiles: number
    linesAdded: number
    linesRemoved: number
    lastActivityAt: string | null
  }
  sessions: ChatSessionAnalyticsEntry[]
}

interface PersistedPendingToolCall extends PendingToolExecutionState {
  /** Durable graph owner; runtime calls must always carry one. */
  turnId: TurnId
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  historyToolName?: string
  historyToolInput?: Record<string, unknown>
  codexToolCallType?: "function" | "custom" | "tool_search"
  skillActivationReceipts?: readonly CursorSkillActivationReceipt[]
  hookAdditionalContexts?: readonly CursorHookAdditionalContextReceipt[]
  toolFamilyHint?: "mcp" | "edit" | "web_fetch"
  modelCallId: string
  startedEmitted: boolean
  sentAt: number
  execIds: number[]
  editApplyWarning?: string
  editFailureContext?: EditFailureContext
  /** Mirror of {@link PendingToolCall.editNoopReason} for persistence. */
  editNoopReason?: "identical_search_replace"
  beforeContent?: string
  shellStreamOutput?: {
    stdout: string[]
    stderr: string[]
    exitCode?: number
    signal?: string
    started: boolean
  }
  /** Exact durable client envelopes still awaiting a terminal state. */
  dispatches: Array<
    Pick<
      ExecDispatchRecord,
      | "streamEpoch"
      | "execId"
      | "protocolExecId"
      | "state"
      | "dispatchKind"
      | "queuedAt"
      | "dispatchingAt"
      | "dispatchedAt"
    >
  >
  /** Present only for an exact durable sidechain tool_use owner. */
  sidechainOwner?: SubagentSidechainToolOwner
}

interface DurableRuntimeToolUse {
  toolName: string
  toolInput: Record<string, unknown>
  sourceMessage: PersistedMessage
}

/**
 * Migration 014 starts a fresh durable session domain. This is deliberately a
 * single current schema, not a compatibility envelope for historical JSON
 * snapshots. The graph, provider projections and tool ledger own their own
 * tables; this restore input contains only their current read models plus the
 * session configuration row.
 */
const CURRENT_SESSION_SNAPSHOT_VERSION = 20 as const

interface PersistedChatSession {
  version: typeof CURRENT_SESSION_SNAPSHOT_VERSION
  conversationId: string
  messages: SessionMessage[]
  model: string
  codexProviderIdentity: CodexRootProviderIdentity
  lastAssistantBackend?: BackendType
  lastAssistantModel?: string
  thinkingLevel: CursorThinkingLevel
  thinkingDetailsRequested: boolean
  isAgentic: boolean
  supportedTools: string[]
  mcpToolDefs?: ParsedCursorRequest["mcpToolDefs"]
  useWeb: boolean
  requestContextEnv?: ParsedCursorRequest["requestContextEnv"]
  createdAt: number
  lastActivityAt: number
  /** Current durable open graph edges reconstructed from their outbox rows. */
  restoredPendingToolCalls: PersistedPendingToolCall[]
  /** `null` is an intentional no-workspace session; absence is invalid. */
  workspace: SessionWorkspaceState | null
  cursorManagedReadResources: readonly CursorManagedReadResource[]
  codeChunks?: ParsedCursorRequest["codeChunks"]
  cursorCommands?: ParsedCursorRequest["cursorCommands"]
  customSystemPrompt?: ParsedCursorRequest["customSystemPrompt"]
  hooksAdditionalContext?: ParsedCursorRequest["hooksAdditionalContext"]
  goalState?: BridgeGoalState
  isRootProjectConversation?: boolean
  explicitContext?: string
  contextTokenLimit?: number
  contextTokenLimitSource?: ContextTokenLimitSource
  contextMaxMode?: boolean
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>
  readPaths: string[]
  fileStates: Array<{
    path: string
    beforeContent: string
    afterContent: string
  }>
  messageBlobIds: string[]
  todos: SessionTodoItem[]
}

interface LoadedPersistedSessionGraph {
  /** Complete durable graph, including audited sub-agent sidechains. */
  rawMessages: readonly PersistedMessage[]
  /** Parent-session read model with message revisions applied. */
  projectedMainMessages: SessionMessage[]
}

type RestoredSessionConfig = Pick<
  PersistedChatSession,
  | "version"
  | "codexProviderIdentity"
  | "lastAssistantBackend"
  | "lastAssistantModel"
  | "thinkingLevel"
  | "thinkingDetailsRequested"
  | "isAgentic"
  | "supportedTools"
  | "mcpToolDefs"
  | "useWeb"
  | "requestContextEnv"
  | "workspace"
  | "cursorManagedReadResources"
  | "codeChunks"
  | "cursorCommands"
  | "customSystemPrompt"
  | "hooksAdditionalContext"
  | "goalState"
  | "isRootProjectConversation"
  | "explicitContext"
  | "contextTokenLimit"
  | "contextTokenLimitSource"
  | "contextMaxMode"
  | "usedContextTokens"
  | "requestedMaxOutputTokens"
  | "requestedModelParameters"
>

/** Exact durable JSON shape emitted by {@link serializeSessionConfig}. */
type SerializedSessionConfig = Omit<
  RestoredSessionConfig,
  "workspace" | "cursorManagedReadResources" | "goalState"
> & {
  workspace: PersistedSessionWorkspaceState | null
  cursorManagedReadResources: CursorManagedReadResource[]
  goalState?: ReturnType<typeof serializeBridgeGoalState>
}

const SERIALIZED_SESSION_CONFIG_REQUIRED_FIELDS = [
  "version",
  "codexProviderIdentity",
  "thinkingLevel",
  "thinkingDetailsRequested",
  "isAgentic",
  "supportedTools",
  "useWeb",
  "workspace",
  "cursorManagedReadResources",
] as const

const SERIALIZED_SESSION_CONFIG_OPTIONAL_FIELDS = [
  "lastAssistantBackend",
  "lastAssistantModel",
  "mcpToolDefs",
  "requestContextEnv",
  "codeChunks",
  "cursorCommands",
  "customSystemPrompt",
  "hooksAdditionalContext",
  "goalState",
  "isRootProjectConversation",
  "explicitContext",
  "contextTokenLimit",
  "contextTokenLimitSource",
  "contextMaxMode",
  "usedContextTokens",
  "requestedMaxOutputTokens",
  "requestedModelParameters",
] as const

type PlainJsonRecord = Record<string, unknown>

/**
 * The JSON config column is a versioned persistence protocol, not a partial
 * object that may acquire fields through casting. Decode the exact serializer
 * shape before a session can reach any live registry.
 */
function decodeSerializedSessionConfig(
  value: unknown,
  conversationId: string
): RestoredSessionConfig {
  const label = `Session ${conversationId} current snapshot config`
  const config = requireExactPlainRecord(
    value,
    label,
    SERIALIZED_SESSION_CONFIG_REQUIRED_FIELDS,
    SERIALIZED_SESSION_CONFIG_OPTIONAL_FIELDS
  )
  if (config.version !== CURRENT_SESSION_SNAPSHOT_VERSION) {
    throw new Error(
      `Session ${conversationId} has unsupported snapshot version ${String(config.version)}`
    )
  }

  const contextTokenLimit = decodeOptionalConfigField(
    config,
    "contextTokenLimit",
    (field) => requirePositiveSafeInteger(field, `${label}.contextTokenLimit`)
  )
  const contextTokenLimitSource = decodeOptionalConfigField(
    config,
    "contextTokenLimitSource",
    (field) =>
      decodeContextTokenLimitSource(field, `${label}.contextTokenLimitSource`)
  )
  assertContextTokenLimitProvenance({
    contextTokenLimit,
    contextTokenLimitSource,
  })

  const decoded: RestoredSessionConfig = {
    version: CURRENT_SESSION_SNAPSHOT_VERSION,
    codexProviderIdentity: decodeCodexRootIdentity(
      config.codexProviderIdentity,
      `${label}.codexProviderIdentity`
    ),
    // Cursor's request parser has exactly three persisted thinking levels:
    // 0 (off), 1 (enabled), and 2 (max). This is a protocol enum, not a
    // generic numeric preference.
    thinkingLevel: requireThinkingLevel(
      config.thinkingLevel,
      `${label}.thinkingLevel`
    ),
    thinkingDetailsRequested: requireBoolean(
      config.thinkingDetailsRequested,
      `${label}.thinkingDetailsRequested`
    ),
    isAgentic: requireBoolean(config.isAgentic, `${label}.isAgentic`),
    supportedTools: decodeCanonicalIdentifierArray(
      config.supportedTools,
      `${label}.supportedTools`
    ),
    useWeb: requireBoolean(config.useWeb, `${label}.useWeb`),
    workspace: decodePersistedWorkspace(config.workspace, `${label}.workspace`),
    cursorManagedReadResources: restoreCursorManagedReadResources(
      config.cursorManagedReadResources,
      `${label}.cursorManagedReadResources`
    ),
  }

  const lastAssistantBackend = decodeOptionalConfigField(
    config,
    "lastAssistantBackend",
    (field) => decodeBackendType(field, `${label}.lastAssistantBackend`)
  )
  if (lastAssistantBackend !== undefined) {
    decoded.lastAssistantBackend = lastAssistantBackend
  }
  const lastAssistantModel = decodeOptionalConfigField(
    config,
    "lastAssistantModel",
    (field) => requireCanonicalIdentifier(field, `${label}.lastAssistantModel`)
  )
  if (lastAssistantModel !== undefined) {
    decoded.lastAssistantModel = lastAssistantModel
  }
  const mcpToolDefs = decodeOptionalConfigField(
    config,
    "mcpToolDefs",
    (field) => decodeMcpToolDefs(field, `${label}.mcpToolDefs`)
  )
  if (mcpToolDefs !== undefined) {
    decoded.mcpToolDefs = mcpToolDefs
  }
  const requestContextEnv = decodeOptionalConfigField(
    config,
    "requestContextEnv",
    (field) => decodeRequestContextEnv(field, `${label}.requestContextEnv`)
  )
  if (requestContextEnv !== undefined) {
    decoded.requestContextEnv = requestContextEnv
  }
  const codeChunks = decodeOptionalConfigField(config, "codeChunks", (field) =>
    decodeCodeChunks(field, `${label}.codeChunks`)
  )
  if (codeChunks !== undefined) {
    decoded.codeChunks = codeChunks
  }
  const cursorCommands = decodeOptionalConfigField(
    config,
    "cursorCommands",
    (field) => decodeCursorCommands(field, `${label}.cursorCommands`)
  )
  if (cursorCommands !== undefined) {
    decoded.cursorCommands = cursorCommands
  }
  const customSystemPrompt = decodeOptionalConfigField(
    config,
    "customSystemPrompt",
    (field) => requireText(field, `${label}.customSystemPrompt`)
  )
  if (customSystemPrompt !== undefined) {
    decoded.customSystemPrompt = customSystemPrompt
  }
  const hooksAdditionalContext = decodeOptionalConfigField(
    config,
    "hooksAdditionalContext",
    (field) => requireText(field, `${label}.hooksAdditionalContext`)
  )
  if (hooksAdditionalContext !== undefined) {
    decoded.hooksAdditionalContext = hooksAdditionalContext
  }
  const goalState = decodeOptionalConfigField(config, "goalState", (field) =>
    deserializeBridgeGoalState(field, `${label}.goalState`)
  )
  if (goalState !== undefined) {
    decoded.goalState = goalState
  }
  const isRootProjectConversation = decodeOptionalConfigField(
    config,
    "isRootProjectConversation",
    (field) => requireBoolean(field, `${label}.isRootProjectConversation`)
  )
  if (isRootProjectConversation !== undefined) {
    decoded.isRootProjectConversation = isRootProjectConversation
  }
  const explicitContext = decodeOptionalConfigField(
    config,
    "explicitContext",
    (field) => requireText(field, `${label}.explicitContext`)
  )
  if (explicitContext !== undefined) {
    decoded.explicitContext = explicitContext
  }
  if (contextTokenLimit !== undefined) {
    decoded.contextTokenLimit = contextTokenLimit
  }
  if (contextTokenLimitSource !== undefined) {
    decoded.contextTokenLimitSource = contextTokenLimitSource
  }
  const contextMaxMode = decodeOptionalConfigField(
    config,
    "contextMaxMode",
    (field) => requireBoolean(field, `${label}.contextMaxMode`)
  )
  if (contextMaxMode !== undefined) {
    decoded.contextMaxMode = contextMaxMode
  }
  const usedContextTokens = decodeOptionalConfigField(
    config,
    "usedContextTokens",
    // This value is refreshed both from Cursor's uint32 conversation detail
    // and from the bridge's completed-response usage ledger. The common
    // durable domain is therefore a non-negative integral token count, not
    // an arbitrary finite number.
    (field) =>
      requireNonNegativeSafeInteger(field, `${label}.usedContextTokens`)
  )
  if (usedContextTokens !== undefined) {
    decoded.usedContextTokens = usedContextTokens
  }
  const requestedMaxOutputTokens = decodeOptionalConfigField(
    config,
    "requestedMaxOutputTokens",
    (field) =>
      requirePositiveSafeInteger(field, `${label}.requestedMaxOutputTokens`)
  )
  if (requestedMaxOutputTokens !== undefined) {
    decoded.requestedMaxOutputTokens = requestedMaxOutputTokens
  }
  const requestedModelParameters = decodeOptionalConfigField(
    config,
    "requestedModelParameters",
    (field) =>
      decodeModelParameterRecord(field, `${label}.requestedModelParameters`)
  )
  if (requestedModelParameters !== undefined) {
    decoded.requestedModelParameters = requestedModelParameters
  }
  return decoded
}

function decodeOptionalConfigField<T>(
  record: PlainJsonRecord,
  field: string,
  decode: (value: unknown) => T
): T | undefined {
  return hasOwn(record, field) ? decode(record[field]) : undefined
}

function decodeCodexRootIdentity(
  value: unknown,
  label: string
): CodexRootProviderIdentity {
  const identity = requireExactPlainRecord(value, label, [
    "sessionId",
    "threadId",
    "threadSource",
  ])
  assertCodexRootProviderIdentity(identity)
  return {
    sessionId: identity.sessionId,
    threadId: identity.threadId,
    threadSource: identity.threadSource,
  }
}

function decodeBackendType(value: unknown, label: string): BackendType {
  switch (value) {
    case "google":
    case "google-claude":
    case "codex":
    case "openai-compat":
    case "claude-api":
    case "kiro":
      return value
    default:
      throw new Error(`${label} must be a supported backend`)
  }
}

function decodeContextTokenLimitSource(
  value: unknown,
  label: string
): ContextTokenLimitSource {
  if (value === "requested" || value === "conversation_state") {
    return value
  }
  throw new Error(`${label} must be requested or conversation_state`)
}

function decodePersistedWorkspace(
  value: unknown,
  label: string
): SessionWorkspaceState | null {
  if (value === null) return null
  try {
    return restoreSessionWorkspace(value)
  } catch (error) {
    throw new Error(`${label} is invalid: ${errorMessage(error)}`)
  }
}

function decodeMcpToolDefs(value: unknown, label: string): McpToolDef[] {
  return requirePlainArray(value, label).map((entry, index) => {
    const entryLabel = `${label}[${index}]`
    const definition = requireExactPlainRecord(
      entry,
      entryLabel,
      [
        "name",
        "toolName",
        "providerIdentifier",
        "description",
        "ideRegistryKey",
      ],
      ["inputSchema"]
    )
    const decoded: McpToolDef = {
      name: requireCanonicalIdentifier(definition.name, `${entryLabel}.name`),
      toolName: requireCanonicalIdentifier(
        definition.toolName,
        `${entryLabel}.toolName`
      ),
      // The wire parser deliberately uses an empty provider/key as its
      // "no registry candidate" sentinel. Preserve that exact sentinel, but
      // reject any non-canonical non-empty identity during recovery.
      providerIdentifier: requireOptionalCanonicalIdentifier(
        definition.providerIdentifier,
        `${entryLabel}.providerIdentifier`
      ),
      description: requireText(
        definition.description,
        `${entryLabel}.description`
      ),
      ideRegistryKey: requireOptionalCanonicalIdentifier(
        definition.ideRegistryKey,
        `${entryLabel}.ideRegistryKey`
      ),
    }
    const inputSchema = decodeOptionalConfigField(
      definition,
      "inputSchema",
      (field) => decodeProtoJsonRecord(field, `${entryLabel}.inputSchema`)
    )
    if (inputSchema !== undefined) {
      decoded.inputSchema = inputSchema
    }
    return decoded
  })
}

function decodeRequestContextEnv(
  value: unknown,
  label: string
): NonNullable<ParsedCursorRequest["requestContextEnv"]> {
  const env = requireExactPlainRecord(
    value,
    label,
    [],
    [
      "terminalsFolder",
      "projectFolder",
      "shell",
      "timeZone",
      "agentTranscriptsFolder",
      "artifactsFolder",
    ]
  )
  const decoded: NonNullable<ParsedCursorRequest["requestContextEnv"]> = {}
  const filesystemPathFields = [
    "terminalsFolder",
    "projectFolder",
    "agentTranscriptsFolder",
    "artifactsFolder",
  ] as const
  for (const field of filesystemPathFields) {
    if (!hasOwn(env, field)) continue
    decoded[field] = requireFilesystemPathText(env[field], `${label}.${field}`)
  }
  for (const field of ["shell", "timeZone"] as const) {
    if (!hasOwn(env, field)) continue
    decoded[field] = requireNonEmptyText(env[field], `${label}.${field}`)
  }
  return decoded
}

function decodeCodeChunks(
  value: unknown,
  label: string
): NonNullable<ParsedCursorRequest["codeChunks"]> {
  return requirePlainArray(value, label).map((entry, index) => {
    const entryLabel = `${label}[${index}]`
    const chunk = requireExactPlainRecord(
      entry,
      entryLabel,
      ["path", "content"],
      ["startLine", "endLine"]
    )
    const decoded: NonNullable<ParsedCursorRequest["codeChunks"]>[number] = {
      path: requireFilesystemPathText(chunk.path, `${entryLabel}.path`),
      // An empty editor selection/file is still a real attached code chunk.
      content: requireText(chunk.content, `${entryLabel}.content`),
    }
    const startLine = decodeOptionalConfigField(chunk, "startLine", (field) =>
      requireFiniteNumber(field, `${entryLabel}.startLine`)
    )
    if (startLine !== undefined) decoded.startLine = startLine
    const endLine = decodeOptionalConfigField(chunk, "endLine", (field) =>
      requireFiniteNumber(field, `${entryLabel}.endLine`)
    )
    if (endLine !== undefined) decoded.endLine = endLine
    return decoded
  })
}

function decodeCursorCommands(
  value: unknown,
  label: string
): NonNullable<ParsedCursorRequest["cursorCommands"]> {
  return requirePlainArray(value, label).map((entry, index) => {
    const entryLabel = `${label}[${index}]`
    const command = requireExactPlainRecord(entry, entryLabel, [
      "name",
      "content",
    ])
    return {
      name: requireNonEmptyText(command.name, `${entryLabel}.name`),
      content: requireText(command.content, `${entryLabel}.content`),
    }
  })
}

function decodeCanonicalIdentifierArray(
  value: unknown,
  label: string
): string[] {
  return requirePlainArray(value, label).map((entry, index) =>
    requireCanonicalIdentifier(entry, `${label}[${index}]`)
  )
}

function decodeModelParameterRecord(
  value: unknown,
  label: string
): Record<string, string> {
  const record = requirePlainRecord(value, label)
  const decoded: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    const identifier = requireCanonicalIdentifier(key, `${label} key`)
    decoded[identifier] = requireText(entry, `${label}.${identifier}`)
  }
  return decoded
}

/** Decode an arbitrary protobuf-derived JSON object without accepting class instances. */
function decodeProtoJsonRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  const record = requirePlainRecord(value, label)
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      decodeProtoJsonValue(entry, `${label}.${key}`),
    ])
  )
}

function decodeProtoJsonValue(value: unknown, label: string): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number") {
    return requireFiniteNumber(value, label)
  }
  if (Array.isArray(value)) {
    return requirePlainArray(value, label).map((entry, index) =>
      decodeProtoJsonValue(entry, `${label}[${index}]`)
    )
  }
  return decodeProtoJsonRecord(value, label)
}

function requireExactPlainRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = []
): PlainJsonRecord {
  const record = requirePlainRecord(value, label)
  const allowed = new Set([...required, ...optional])
  const fields = Object.keys(record)
  const missing = required.filter((field) => !hasOwn(record, field))
  const unexpected = fields.filter((field) => !allowed.has(field))
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(", ")}`] : []),
    ]
    throw new Error(
      `${label} has an invalid field shape (${details.join("; ")})`
    )
  }
  return record
}

function requirePlainRecord(value: unknown, label: string): PlainJsonRecord {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`)
  }
  const record = value as PlainJsonRecord
  assertPlainJsonRecordProperties(record, label)
  return record
}

function requirePlainArray(value: unknown, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(`${label} must be a plain array`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} must not contain symbol properties`)
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, String(index))) {
      throw new Error(`${label} must not contain sparse array holes`)
    }
  }
  const allowedFields = new Set(
    Array.from({ length: value.length }, (_, index) => String(index))
  )
  for (const field of Object.getOwnPropertyNames(value)) {
    if (field === "length") continue
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (
      !allowedFields.has(field) ||
      !descriptor ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      throw new Error(`${label} must contain only JSON array values`)
    }
  }
  return value
}

function assertPlainJsonRecordProperties(
  record: PlainJsonRecord,
  label: string
): void {
  if (Object.getOwnPropertySymbols(record).length > 0) {
    throw new Error(`${label} must not contain symbol properties`)
  }
  for (const field of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field)
    if (
      !descriptor ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      throw new Error(`${label} must contain only JSON object fields`)
    }
  }
}

/** Text payloads retain their exact bytes; only NUL is never serializable. */
function requireText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`)
  }
  if (value.includes("\u0000")) {
    throw new Error(`${label} must not contain NUL bytes`)
  }
  return value
}

/** Present optional fields must carry a real value; omission is the sentinel. */
function requireNonEmptyText(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (!text.trim()) {
    throw new Error(`${label} must be non-empty text`)
  }
  return text
}

/** Filesystem paths preserve every non-NUL byte, including boundary spaces. */
function requireFilesystemPathText(value: unknown, label: string): string {
  const path = requireText(value, label)
  if (path.length === 0) {
    throw new Error(`${label} must be a non-empty local path`)
  }
  return path
}

/** Opaque stored keys are exact values, never recovery-normalized strings. */
export function requireCanonicalIdentifier(
  value: unknown,
  label: string
): string {
  const identifier = requireNonEmptyText(value, label)
  if (identifier.trim() !== identifier) {
    throw new Error(
      `${label} must be a canonical identifier without surrounding whitespace`
    )
  }
  return identifier
}

/** Cursor represents an unavailable MCP registry candidate as an empty string. */
function requireOptionalCanonicalIdentifier(
  value: unknown,
  label: string
): string {
  const identifier = requireText(value, label)
  if (identifier === "") return identifier
  if (!identifier.trim() || identifier.trim() !== identifier) {
    throw new Error(
      `${label} must be an empty sentinel or canonical identifier`
    )
  }
  return identifier
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function requireThinkingLevel(value: unknown, label: string): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) {
    return value
  }
  throw new Error(`${label} must be one of 0, 1, or 2`)
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function requireOptionalNonNegativeSafeInteger(
  value: unknown,
  label: string
): number | undefined {
  return value === undefined
    ? undefined
    : requireNonNegativeSafeInteger(value, label)
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function hasOwn(record: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface RestoredSessionBundle {
  session: SessionLifecycleRecord
  context: ContextStateRecord
  stream: SessionStreamRecord
  restoredPendingToolCalls: PersistedPendingToolCall[]
}

/**
 * A fresh session before it is visible to any live registry. The bundle is
 * intentionally detached until its session row, initial graph, and normalized
 * domain state have committed together.
 */
interface FreshSessionBootstrap {
  session: SessionLifecycleRecord
  context: ContextStateRecord
  stream: SessionStreamRecord
  initialHistory: SessionMessage[]
}

interface PreparedSessionRequestRefresh {
  session: SessionLifecycleRecord
  context: ContextStateRecord
  canRefreshProvidedFields: boolean
  resetUsageLedger: boolean
  reloadConfiguredWorkspaceGrants: boolean
}

@Injectable()
export class SessionLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionLifecycleService.name)
  // Lifecycle metadata is physically separate from context graph state and
  // stream execution state; create/load/delete coordinate their owners.
  private readonly sessions = new Map<string, SessionLifecycleRecord>()

  // Pending tool calls — inlined from the deleted PendingToolStore
  // class. Two indexes:
  //   - byConversation: conv → toolCallId → entry  (fast lookup by id)
  //   - byTurn:         conv → turnId → Set<toolCallId>  (fast list per turn)
  // Updated atomically. The legacy class lived in turn/pending-tool-store.ts
  // and was deleted to consolidate single-source-of-truth here.
  private readonly pendingByConversation = new Map<
    ConversationId,
    Map<string, PendingInternalEntry<unknown>>
  >()
  private readonly pendingByTurn = new Map<
    ConversationId,
    Map<TurnId, Set<string>>
  >()

  /**
   * One active durable-graph turn per conversation. This is an ownership
   * guard only: accepted graph fragments are never staged in Lifecycle and
   * are never rewound on abort.
   */
  private readonly activeGraphTurns = new Map<string, TurnId>()
  private readonly ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000 // 30 minutes
  private readonly PERSISTED_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
  private readonly PERSIST_FLUSH_INTERVAL_MS = 15 * 1000
  private readonly PERSIST_DEBOUNCE_MS = 250
  private readonly RETIRED_EXEC_ID_TTL_MS = 10 * 60 * 1000
  private readonly MAX_RETIRED_EXEC_ID_MAPPINGS = 512
  private readonly scheduledPersistTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private cleanupInterval!: ReturnType<typeof setInterval>
  private persistFlushInterval!: ReturnType<typeof setInterval>

  /**
   * Independent cleanup subscribers. Session eviction is a lifecycle event
   * with more than one owner (provider adapters, runtime caches, etc.), so a
   * later registration must not silently replace an earlier resource owner.
   */
  private readonly sessionCleanupHandlers = new Set<SessionCleanupHandler>()

  /**
   * Transport/runtime work not represented by a graph turn or ledger entry.
   * Each probe is conservative: an exception keeps the session alive.
   */
  private readonly sessionBusyProbes = new Set<SessionBusyProbe>()

  /**
   * Optional callback fired on the edge transition from "session has
   * pending tool calls or interaction queries" to "session is fully
   * idle". Wired by `cursor-connect-stream` to drain
   * `session.deferredControlContinuations`.
   *
   * Edge-only semantics: invoked exactly once per non-idle → idle
   * transition, never on idle → idle no-ops, never while still
   * non-idle. The handler may be re-entered on the next non-idle
   * → idle cycle.
   */
  private onPendingWorkBecameIdleHandler?: (
    conversationId: string,
    session: SessionRecord
  ) => void

  /**
   * Resolver supplied by the protocol service so every pending-tool
   * registration can attribute itself to the active ParentTurn. The
   * protocol layer maintains a per-conversation parent-turn stack;
   * the manager calls this inline from `addPendingToolCall` to ask
   * "which turnId owns the new entry".
   *
   * An unresolved turn is an invariant violation. Callers must install the
   * supervisor resolver before registering a pending tool call.
   */
  private resolveTurnIdForConversation: (
    conversationId: string
  ) => TurnId | undefined = () => undefined

  setPendingToolTurnIdResolver(
    resolver: (conversationId: string) => TurnId | undefined
  ): void {
    this.resolveTurnIdForConversation = resolver
  }

  // ─── PendingToolStore-backed read API ────────────────────────────
  // Replaces every legacy `session.pendingToolCalls.{...}` access.
  // Reads never touch the store's `byTurn` index; they only walk the
  // (conversation, toolCallId) primary index.

  /** Equivalent to `this.getPendingToolCall(session.conversationId, toolCallId)`. */
  getPendingToolCall(
    conversationId: string,
    toolCallId: string
  ): PendingToolCall | undefined {
    const entry = this.pendingToolGet<PendingToolCall>(
      ConversationId.of(conversationId),
      toolCallId
    )
    return entry?.payload
  }

  /** Equivalent to `this.hasPendingToolCall(session.conversationId, toolCallId)`. */
  hasPendingToolCall(conversationId: string, toolCallId: string): boolean {
    return this.getPendingToolCall(conversationId, toolCallId) !== undefined
  }

  /** Equivalent to `this.pendingToolCallCount(session.conversationId)`. */
  pendingToolCallCount(conversationId: string): number {
    return this.pendingToolSnapshotForConversation(
      ConversationId.of(conversationId)
    ).length
  }

  /** Equivalent to `this.listPendingToolCallIds(session.conversationId)`. */
  listPendingToolCallIds(conversationId: string): string[] {
    return this.pendingToolSnapshotForConversation(
      ConversationId.of(conversationId)
    ).map((e) => e.toolCallId)
  }

  /** Equivalent to `this.listPendingToolCalls(session.conversationId)`. */
  listPendingToolCalls(conversationId: string): PendingToolCall[] {
    return this.pendingToolSnapshotForConversation<PendingToolCall>(
      ConversationId.of(conversationId)
    )
      .map((e) => e.payload as PendingToolCall)
      .filter((p): p is PendingToolCall => p !== undefined)
  }

  /** Equivalent to `[...session.pendingToolCalls]`. */
  listPendingToolCallEntries(
    conversationId: string
  ): Array<[string, PendingToolCall]> {
    const out: Array<[string, PendingToolCall]> = []
    for (const e of this.pendingToolSnapshotForConversation<PendingToolCall>(
      ConversationId.of(conversationId)
    )) {
      if (e.payload) out.push([e.toolCallId, e.payload])
    }
    return out
  }

  /**
   * Mutate an existing pending tool call's payload. Throws if the
   * entry is missing or already resolved — callers expect the
   * tool to be live when they reach a mutation.
   */
  updatePendingToolCall(
    conversationId: string,
    toolCallId: string,
    mutate: (current: PendingToolCall) => void
  ): void {
    this.pendingToolUpdatePayload<PendingToolCall>(
      ConversationId.of(conversationId),
      toolCallId,
      (p) => {
        if (!p) {
          throw new Error(
            `updatePendingToolCall: entry has no payload for ${conversationId}/${toolCallId}`
          )
        }
        mutate(p)
        return p
      }
    )
  }

  /** Resolve and remove a single pending tool call from the store. */
  private resolvePendingToolCallEntry(
    conversationId: string,
    toolCallId: string
  ): boolean {
    const conv = ConversationId.of(conversationId)
    const existed = this.pendingToolGet(conv, toolCallId) !== undefined
    if (existed) this.pendingToolResolve(conv, toolCallId)
    return existed
  }

  /** Resolve every live entry for a conversation. */
  private clearAllPendingToolCalls(conversationId: string): void {
    this.pendingToolClearConversation(ConversationId.of(conversationId))
  }

  constructor(
    private readonly persistence: PersistenceService,
    private readonly toolResultStorage: ToolResultStorageService,
    // The durable graph and active context projection are owned by
    // MessageStore and ContextStateService. Lifecycle persistence uses the
    // normalized session repository exclusively.
    private readonly sessionPersistence: SessionPersistenceService,
    private readonly messageStore: MessageStore,
    private readonly toolCallLedger: ToolCallLedger,
    private readonly execDispatchStore: ExecDispatchStore,
    private readonly contextProjectionStore: ContextProjectionStore,
    private readonly contextProjectionHeads: ContextProjectionHeadStore,
    private readonly snipBoundaryStore: SnipBoundaryStore,
    private readonly sessionMemoryEvents: SessionMemoryEventStore,
    private readonly subagentRunStore: SubagentRunStore,
    private readonly subagentBranches: SubagentBranchStore,
    // AssistantToolBatchService owns the in-flight assistant tool batch
    // state machine. forwardRef breaks the
    // bidirectional cycle (lifecycle → batch on persistence /
    // detach paths, batch → lifecycle for markSessionDirty).
    @Inject(forwardRef(() => AssistantToolBatchService))
    private readonly assistantToolBatch: AssistantToolBatchService,
    @Inject(forwardRef(() => ContextStateService))
    private readonly contextState: ContextStateService,
    @Inject(forwardRef(() => SessionStreamService))
    private readonly sessionStream: SessionStreamService,
    private readonly claudeProjectionStore: ClaudeProjectionStore
  ) {}

  /**
   * Conversation → active leaf turn handle resolver. Installed by
   * CursorConnectStreamService at boot (setter injection avoids the
   * DI cycle between SessionLifecycleService and TurnLifecycle while still
   * letting `getCurrentTurnAbortSignal` return the live supervisor
   * handle's signal). When unset (unit tests, pre-bridge bootstrap),
   * `getCurrentTurnAbortSignal` returns undefined.
   *
   * M3: replaces the legacy `SessionRecord.currentTurnAbortController`
   * field. Callers ask the supervisor "what's running on this
   * conversation right now" instead of reading a session-level
   * AbortController.
   */
  private activeTurnSignalResolver:
    | ((conversationId: string) => AbortSignal | undefined)
    | undefined

  setActiveTurnSignalResolver(
    resolver: (conversationId: string) => AbortSignal | undefined
  ): void {
    this.activeTurnSignalResolver = resolver
  }

  // ─── Inlined PendingToolStore — single source of truth ───────────
  // Replaces the deleted `turn/pending-tool-store.ts`. Same semantics
  // (single (conv, toolCallId) compound key, byTurn secondary index,
  // throw on duplicate-register, idempotent resolve, etc.) but lives
  // here so the lifecycle / stream services can call directly without
  // the indirection of a wrapped service. Public so external callers
  // (cursor-connect-stream / context-bridge / tests) reach the same
  // entries through a single API surface.

  pendingToolRegister<TPayload = unknown>(
    entry: PendingToolEntry<TPayload>
  ): void {
    const conversationId = ConversationId.of(entry.conversationId)
    const turnId = TurnId.of(entry.turnId)
    const toolCallId = requireExactDurableIdentifier(
      entry.toolCallId,
      "pendingToolRegister toolCallId"
    )
    const convMap = this.getOrCreatePendingConvMap(conversationId)
    if (convMap.has(toolCallId)) {
      throw new Error(
        `pendingToolRegister: duplicate registration for conversation=${conversationId} toolCallId=${toolCallId}`
      )
    }
    convMap.set(toolCallId, {
      ...entry,
      conversationId,
      turnId,
      toolCallId,
      resolved: false,
    } as PendingInternalEntry<unknown>)

    const turnMap = this.getOrCreatePendingTurnMap(conversationId)
    let set = turnMap.get(turnId)
    if (!set) {
      set = new Set()
      turnMap.set(turnId, set)
    }
    set.add(toolCallId)
  }

  pendingToolUpdatePayload<TPayload = unknown>(
    conversationId: ConversationId,
    toolCallId: string,
    mutate: (current: TPayload | undefined) => TPayload
  ): void {
    const exactConversationId = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "pendingToolUpdatePayload toolCallId"
    )
    const entry = this.pendingByConversation
      .get(exactConversationId)
      ?.get(exactToolCallId)
    if (!entry || entry.resolved) {
      throw new Error(
        `pendingToolUpdatePayload: no live entry for conversation=${exactConversationId} toolCallId=${exactToolCallId}`
      )
    }
    entry.payload = mutate(entry.payload as TPayload | undefined)
  }

  pendingToolGet<TPayload = unknown>(
    conversationId: ConversationId,
    toolCallId: string
  ): PendingToolEntry<TPayload> | undefined {
    const exactConversationId = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "pendingToolGet toolCallId"
    )
    const entry = this.pendingByConversation
      .get(exactConversationId)
      ?.get(exactToolCallId)
    if (!entry || entry.resolved) return undefined
    return entry as PendingToolEntry<TPayload>
  }

  pendingToolMatchesTurn(
    conversationId: ConversationId,
    toolCallId: string,
    turnId: TurnId
  ): boolean {
    const exactConversationId = ConversationId.of(conversationId)
    const exactTurnId = TurnId.of(turnId)
    const entry = this.pendingToolGet(exactConversationId, toolCallId)
    return entry?.turnId === exactTurnId
  }

  pendingToolResolve(conversationId: ConversationId, toolCallId: string): void {
    const exactConversationId = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "pendingToolResolve toolCallId"
    )
    const convMap = this.pendingByConversation.get(exactConversationId)
    const entry = convMap?.get(exactToolCallId)
    if (!entry || entry.resolved) return
    entry.resolved = true
    convMap!.delete(exactToolCallId)
    if (convMap!.size === 0) {
      this.pendingByConversation.delete(exactConversationId)
    }
    const turnMap = this.pendingByTurn.get(exactConversationId)
    const set = turnMap?.get(entry.turnId)
    set?.delete(exactToolCallId)
    if (set && set.size === 0) {
      turnMap!.delete(entry.turnId)
      if (turnMap!.size === 0) this.pendingByTurn.delete(exactConversationId)
    }
  }

  pendingToolListForTurn<TPayload = unknown>(
    conversationId: ConversationId,
    turnId: TurnId
  ): PendingToolEntry<TPayload>[] {
    const exactConversationId = ConversationId.of(conversationId)
    const exactTurnId = TurnId.of(turnId)
    const set = this.pendingByTurn.get(exactConversationId)?.get(exactTurnId)
    if (!set || set.size === 0) return []
    const convMap = this.pendingByConversation.get(exactConversationId)
    if (!convMap) return []
    const out: PendingToolEntry<TPayload>[] = []
    for (const id of set) {
      const e = convMap.get(id)
      if (e && !e.resolved) out.push(e as PendingToolEntry<TPayload>)
    }
    return out
  }

  pendingToolSnapshotForConversation<TPayload = unknown>(
    conversationId: ConversationId
  ): PendingToolEntry<TPayload>[] {
    const exactConversationId = ConversationId.of(conversationId)
    const convMap = this.pendingByConversation.get(exactConversationId)
    if (!convMap) return []
    const out: PendingToolEntry<TPayload>[] = []
    for (const e of convMap.values()) {
      if (!e.resolved) out.push(e as PendingToolEntry<TPayload>)
    }
    return out
  }

  clearPendingToolCallsForTurn(
    conversationId: ConversationId,
    turnId: TurnId,
    reason: string
  ): PendingToolCall[] {
    const entries = this.pendingToolListForTurn<PendingToolCall>(
      conversationId,
      turnId
    )
    const cleared: PendingToolCall[] = []
    for (const entry of entries) {
      const pending = this.clearPendingToolCall(
        String(conversationId),
        entry.toolCallId,
        reason
      )
      if (pending) {
        cleared.push(pending)
      }
    }
    return cleared
  }

  pendingToolClearConversation(conversationId: ConversationId): number {
    const exactConversationId = ConversationId.of(conversationId)
    const convMap = this.pendingByConversation.get(exactConversationId)
    if (!convMap) return 0
    const count = convMap.size
    this.pendingByConversation.delete(exactConversationId)
    this.pendingByTurn.delete(exactConversationId)
    return count
  }

  pendingToolSize(): number {
    let n = 0
    for (const m of this.pendingByConversation.values()) n += m.size
    return n
  }

  private getOrCreatePendingConvMap(conversationId: ConversationId) {
    const exactConversationId = ConversationId.of(conversationId)
    let m = this.pendingByConversation.get(exactConversationId)
    if (!m) {
      m = new Map()
      this.pendingByConversation.set(exactConversationId, m)
    }
    return m
  }

  private getOrCreatePendingTurnMap(conversationId: ConversationId) {
    const exactConversationId = ConversationId.of(conversationId)
    let m = this.pendingByTurn.get(exactConversationId)
    if (!m) {
      m = new Map()
      this.pendingByTurn.set(exactConversationId, m)
    }
    return m
  }

  onModuleInit(): void {
    this.cleanupOldPersistedSessions()

    this.cleanupInterval = setInterval(
      () => this.cleanupExpiredSessions(),
      5 * 60 * 1000
    )
    this.persistFlushInterval = setInterval(
      () => this.persistAllSessions(),
      this.PERSIST_FLUSH_INTERVAL_MS
    )
    this.cleanupInterval.unref?.()
    this.persistFlushInterval.unref?.()
  }

  /**
   * Register a callback to be invoked when a session is removed (expired or deleted).
   * Used by the orchestration layer to release provider-specific resources
   * (e.g., ProviderAdapter.dispose() for Codex WebSocket connections).
   */
  registerSessionCleanupHandler(handler: SessionCleanupHandler): () => void {
    this.sessionCleanupHandlers.add(handler)
    return () => {
      this.sessionCleanupHandlers.delete(handler)
    }
  }

  /**
   * Register an external runtime-work probe. The disposer prevents a
   * transport instance from pinning sessions after it has been torn down.
   */
  registerSessionBusyProbe(probe: SessionBusyProbe): () => void {
    this.sessionBusyProbes.add(probe)
    return () => {
      this.sessionBusyProbes.delete(probe)
    }
  }

  private invokeSessionCleanupHandlers(
    conversationId: string,
    session: SessionRecord
  ): void {
    // Snapshot first: a handler may dispose itself or register another owner
    // without changing which owners observe this already-started eviction.
    for (const handler of [...this.sessionCleanupHandlers]) {
      try {
        void Promise.resolve(handler(conversationId, session)).catch(
          (error) => {
            this.logger.error(
              `Session cleanup handler failed for ${conversationId}: ${String(error)}`
            )
          }
        )
      } catch (error) {
        this.logger.error(
          `Session cleanup handler failed for ${conversationId}: ${String(error)}`
        )
      }
    }
  }

  /**
   * One conservative activity predicate shared by automatic expiry and the
   * destructive clear-all path. Neither operation may evict a live graph
   * turn, a provider/backend request, or a client interaction in flight.
   */
  private isSessionBusy(
    conversationId: string,
    session: SessionRecord
  ): boolean {
    const stream = this.sessionStream.getStreamRecord(conversationId)
    const activeTurnSignal = this.getCurrentTurnAbortSignal(conversationId)
    if (
      this.activeGraphTurns.has(conversationId) ||
      (activeTurnSignal != null && !activeTurnSignal.aborted) ||
      this.pendingToolCallCount(session.conversationId) > 0 ||
      (stream?.pendingInteractionQueries.size ?? 0) > 0 ||
      this.listRunningSubagentRuns(conversationId).length > 0 ||
      session.deferredControlContinuations.length > 0
    ) {
      return true
    }
    for (const probe of this.sessionBusyProbes) {
      try {
        if (probe(conversationId, session)) return true
      } catch (error) {
        // A failed probe must preserve the session; deleting a potentially
        // active provider stream is strictly worse than postponing cleanup.
        this.logger.warn(
          `Session busy probe failed for ${conversationId}; preserving session: ${String(error)}`
        )
        return true
      }
    }
    return false
  }

  /**
   * Register a callback fired whenever a session transitions from
   * "has pending tool calls / interaction queries" to "fully idle".
   *
   * Wired by `cursor-connect-stream` to drain
   * `session.deferredControlContinuations` — control-frame
   * continuations (queued ask answers, background task completions,
   * …) that arrived during a non-idle window and were parked to
   * avoid sending an upstream request with an unmatched
   * `function_call`.
   *
   * Fires only on the idle transition edge (`wasPending && !nowPending`),
   * never on idle → idle no-ops. The callback is invoked synchronously
   * from the consume site; if the callback awaits, it does so on its
   * own microtask — the manager itself never blocks.
   */
  registerPendingWorkBecameIdleHandler(
    handler: (conversationId: string, session: SessionRecord) => void
  ): void {
    this.onPendingWorkBecameIdleHandler = handler
  }

  /**
   * Internal helper: invoke `onPendingWorkBecameIdleHandler` exactly
   * once per "non-idle → idle" transition for `session`. Callers pass
   * `wasPending` snapshotted *before* the mutation so this can detect
   * the edge. Idempotent when `wasPending` was already `false` or the
   * session is still non-idle after the mutation.
   */
  notifyIfBecameIdleAfter(session: SessionRecord, wasPending: boolean): void {
    if (!wasPending) return
    if (!this.onPendingWorkBecameIdleHandler) return
    const conversationId = session.conversationId
    const stillPending =
      this.pendingToolCallCount(conversationId) > 0 ||
      this.sessionStream.hasBlockingInteractionQueries(conversationId)
    if (stillPending) return
    try {
      this.onPendingWorkBecameIdleHandler(conversationId, session)
    } catch (err) {
      this.logger.error(
        `onPendingWorkBecameIdle handler for ${conversationId} threw: ${
          (err as Error)?.message || String(err)
        }`
      )
    }
  }

  onModuleDestroy(): void {
    this.persistAllSessions()

    for (const timer of this.scheduledPersistTimers.values()) {
      clearTimeout(timer)
    }
    this.scheduledPersistTimers.clear()

    clearInterval(this.cleanupInterval)
    clearInterval(this.persistFlushInterval)
    // PersistenceService handles DB cleanup
  }

  private cleanupOldPersistedSessions(): void {
    if (!this.persistence.isReady) return
    const cutoff = Date.now() - this.PERSISTED_SESSION_TTL_MS
    try {
      const expired = this.sessionPersistence
        .listSessions()
        .filter((row) => row.lastActivityAt < cutoff)
      if (expired.length === 0) return
      for (const row of expired) {
        this.sessionPersistence.deleteSession(row.conversationId)
        this.deleteToolResultStorage(row.conversationId)
      }
      this.logger.log(
        `Cleaned up ${expired.length} expired persisted session(s)`
      )
    } catch (error) {
      this.logger.error(
        `Failed to cleanup persisted sessions: ${String(error)}`
      )
    }
  }

  schedulePersist(conversationId: string): void {
    const existingTimer = this.scheduledPersistTimers.get(conversationId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.scheduledPersistTimers.delete(conversationId)
      try {
        this.persistSession(conversationId)
      } catch (error) {
        // A debounced flush has no synchronous caller to fail. Keep the
        // mounted session visible, but never hide a rejected durable write.
        this.logger.error(
          `Scheduled session persistence failed for ${conversationId}: ${String(error)}`
        )
      }
    }, this.PERSIST_DEBOUNCE_MS)
    timer.unref?.()
    this.scheduledPersistTimers.set(conversationId, timer)
  }

  clearScheduledPersist(conversationId: string): void {
    const timer = this.scheduledPersistTimers.get(conversationId)
    if (!timer) return
    clearTimeout(timer)
    this.scheduledPersistTimers.delete(conversationId)
  }

  /**
   * Synchronously flush a mounted session snapshot to SQLite, bypassing the
   * `schedulePersist` debounce.
   *
   * Fresh bootstrap commits the parent row before it publishes any in-memory
   * record. This remains the synchronous boundary for mutations made after
   * mount and immediately before a downstream turn writes foreign-keyed rows.
   *
   * `TurnLifecycle.spawn` calls this method right before its first
   * `appendEvent({kind:"spawned"})` so `turn_events` cannot violate the
   * FK at insert time. Callers that hold no in-memory session
   * (synthetic-compaction turns) may invoke this safely — it is a no-op
   * when the conversation is unknown.
   */
  flushPersistImmediate(conversationId: string): void {
    this.clearScheduledPersist(conversationId)
    const session = this.sessions.get(conversationId)
    if (!session) return
    this.persistMountedSessionSnapshot(conversationId, session)
  }

  private persistAllSessions(): void {
    for (const conversationId of this.sessions.keys()) {
      this.persistSession(conversationId)
    }
    this.cleanupOldPersistedSessions()
  }

  /**
   * Persist a session that is currently mounted in `this.sessions`.
   *
   * Lookup-by-id is intentional here: this is the API used by the hot
   * write path (schedulePersist debounce, turn-completion flushes, etc.)
   * where the caller knows the id but does not hold the live object —
   * the in-memory map is the source of truth, not the parameter.
   *
   * Direct holders use `persistMountedSessionSnapshot`, which requires its
   * matching mounted context record instead of silently omitting a write.
   */
  persistSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (!session) return
    this.persistMountedSessionSnapshot(conversationId, session)
  }

  persistTodos(conversationId: string, todos: SessionTodoItem[]): void {
    try {
      this.sessionPersistence.replaceTodos(
        ConversationId.of(conversationId),
        todos.map(
          (todo): SessionTodo => ({
            conversationId: ConversationId.of(conversationId),
            id: todo.id,
            content: todo.content,
            status: todo.status,
            createdAt: todo.createdAt,
            updatedAt: todo.updatedAt,
            dependencies: [...todo.dependencies],
          })
        )
      )
    } catch (error) {
      this.logger.error(
        `Failed to persist todos for ${conversationId}: ${String(error)}`
      )
      throw error
    }
  }

  getGoalState(conversationId: string): BridgeGoalState | undefined {
    return this.sessions.get(conversationId)?.goalState
  }

  setGoalState(
    conversationId: string,
    goalState: BridgeGoalState | undefined
  ): void {
    const session = this.sessions.get(conversationId)
    if (!session) {
      throw new Error(
        `Cannot persist goal state for missing session ${conversationId}`
      )
    }
    session.goalState = goalState
    this.persistSession(conversationId)
  }

  private loadPersistedTodos(conversationId: string): SessionTodoItem[] {
    return this.sessionPersistence
      .listTodos(ConversationId.of(conversationId))
      .map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
        dependencies: [...todo.dependencies],
      }))
  }

  private loadRestoredOpenToolLedger(
    conversationId: ConversationId,
    openRuntimeEdges: ReturnType<ToolCallLedger["listOpen"]>,
    persistedGraph: readonly PersistedMessage[]
  ): PersistedPendingToolCall[] {
    if (openRuntimeEdges.length === 0) {
      return []
    }
    if (openRuntimeEdges.some((entry) => entry.origin !== "runtime")) {
      throw new Error(
        `Restored runtime tool projection received a non-runtime ledger edge for ${conversationId}`
      )
    }
    const toolUses = this.loadDurableRuntimeToolUses(
      conversationId,
      persistedGraph
    )
    const restored = openRuntimeEdges.map(
      (entry, index): PersistedPendingToolCall => {
        if (!entry.turnId) {
          throw new Error(
            `Restored runtime tool edge has no turn owner: conversation=${conversationId} ` +
              `toolCallId=${entry.toolUseId}`
          )
        }
        const toolUse = toolUses.get(entry.toolUseId)
        if (!toolUse) {
          throw new Error(
            `Restored runtime tool edge has no durable tool_use block: conversation=${conversationId} ` +
              `toolCallId=${entry.toolUseId}`
          )
        }
        if (toolUse.toolName !== entry.toolName) {
          throw new Error(
            `Restored runtime tool edge has conflicting tool names: conversation=${conversationId} ` +
              `toolCallId=${entry.toolUseId} ledger=${entry.toolName} graph=${toolUse.toolName}`
          )
        }
        if (!toolUse.sourceMessage.turnId) {
          throw new Error(
            `Restored runtime tool edge source has no graph turn: conversation=${conversationId} ` +
              `toolCallId=${entry.toolUseId} sourceUuid=${toolUse.sourceMessage.uuid}`
          )
        }
        if (toolUse.sourceMessage.turnId !== entry.turnId) {
          throw new Error(
            `Restored runtime tool edge turn ownership mismatch: conversation=${conversationId} ` +
              `toolCallId=${entry.toolUseId} ledgerTurn=${entry.turnId} ` +
              `graphTurn=${toolUse.sourceMessage.turnId}`
          )
        }
        const dispatches = this.execDispatchStore.findActiveByToolCall(
          conversationId,
          entry.toolUseId
        )
        const sidechainOwner = this.resolveSubagentSidechainToolOwner(
          conversationId,
          entry.toolUseId,
          toolUse.sourceMessage
        )
        const execution = this.resolveRestoredToolExecution(
          dispatches,
          sidechainOwner !== undefined
        )
        const skillActivationReceipts =
          this.readDurableToolSkillActivationReceipts(
            conversationId,
            entry.toolUseId,
            toolUse.sourceMessage
          )
        const hookAdditionalContexts =
          this.readDurableToolHookAdditionalContexts(
            conversationId,
            entry.toolUseId,
            toolUse.sourceMessage
          )
        return {
          turnId: entry.turnId,
          toolCallId: entry.toolUseId,
          toolName: entry.toolName,
          toolInput: toolUse.toolInput,
          modelCallId: "",
          startedEmitted: true,
          sentAt: entry.openedAt,
          execIds: dispatches.map((dispatch) => dispatch.execId),
          executionOwner: "client",
          executionStatus: execution.status,
          executionRecoveryReason: execution.reason,
          executionOrder: entry.openMessageSeq || index + 1,
          ...(skillActivationReceipts.length > 0
            ? { skillActivationReceipts }
            : {}),
          ...(hookAdditionalContexts.length > 0
            ? { hookAdditionalContexts }
            : {}),
          ...(sidechainOwner ? { sidechainOwner } : {}),
          dispatches: dispatches.map((dispatch) => ({
            streamEpoch: dispatch.streamEpoch,
            execId: dispatch.execId,
            protocolExecId: dispatch.protocolExecId,
            state: dispatch.state,
            dispatchKind: dispatch.dispatchKind,
            queuedAt: dispatch.queuedAt,
            dispatchingAt: dispatch.dispatchingAt,
            dispatchedAt: dispatch.dispatchedAt,
          })),
        }
      }
    )
    if (restored.length > 0) {
      this.logger.warn(
        `[context-restore] reconstructed ${restored.length} open runtime tool edge(s) ` +
          `from durable graph and exec dispatch state for ${conversationId}`
      )
    }
    return restored
  }

  /**
   * Tool input is durable graph data, not restart fallback data. Reconstruct
   * it exactly so a late client result follows the same formatter and edit
   * path as it would have before the process restarted.
   */
  private loadDurableRuntimeToolUses(
    conversationId: ConversationId,
    persistedGraph: readonly PersistedMessage[]
  ): Map<string, DurableRuntimeToolUse> {
    const toolUses = new Map<string, DurableRuntimeToolUse>()
    for (const message of persistedGraph) {
      if (message.role !== "assistant") continue
      let blocks: ContentBlock[]
      try {
        blocks = normalizeContent(message.content as MessageContent)
      } catch (error) {
        throw new Error(
          `Cannot decode durable assistant content while restoring ${conversationId}: ${String(error)}`
        )
      }
      for (const block of blocks) {
        if (!isToolUseBlock(block)) continue
        if (toolUses.has(block.id)) {
          throw new Error(
            `Duplicate durable tool_use id while restoring ${conversationId}: ${block.id}`
          )
        }
        toolUses.set(block.id, {
          toolName: block.name,
          toolInput: structuredClone(block.input),
          sourceMessage: message,
        })
      }
    }
    return toolUses
  }

  /**
   * Cold recovery may observe a main-graph Exec envelope after its outbound
   * write began but before the bridge durably recorded the client terminal.
   * Such a frame is delivery-uncertain and cannot be replayed without risking
   * duplicate execution. Park every potentially sent main dispatch in one
   * graph transaction; Cursor's official interrupted-pending resolution (or
   * the original exact terminal frame) is then its only settlement authority.
   * Queued frames remain replayable because their write never began.
   */
  private parkRestoredMainClientDispatches(
    conversationId: ConversationId,
    openRuntimeEdges: ReturnType<ToolCallLedger["listOpen"]>,
    persistedGraph: readonly PersistedMessage[],
    recoveredAt: number = Date.now()
  ): number {
    if (openRuntimeEdges.length === 0) return 0
    if (!Number.isSafeInteger(recoveredAt) || recoveredAt <= 0) {
      throw new Error(
        "parkRestoredMainClientDispatches: recoveredAt must be a positive epoch"
      )
    }
    const toolUses = this.loadDurableRuntimeToolUses(
      conversationId,
      persistedGraph
    )
    return this.messageStore.runInTransaction(conversationId, (txn) => {
      let parked = 0
      for (const entry of openRuntimeEdges) {
        const toolUse = toolUses.get(entry.toolUseId)
        if (!toolUse) {
          throw new Error(
            `Restored runtime tool edge has no durable tool_use block: ` +
              `conversation=${conversationId} toolCallId=${entry.toolUseId}`
          )
        }
        if (toolUse.sourceMessage.isSidechain === true) {
          continue
        }
        const dispatches = this.execDispatchStore.findActiveByToolCall(
          conversationId,
          entry.toolUseId
        )
        for (const dispatch of dispatches) {
          if (
            dispatch.state !== "dispatching" &&
            dispatch.state !== "dispatched"
          ) {
            continue
          }
          this.execDispatchStore.awaitInterruptedResolutionInTransaction(
            txn,
            dispatch,
            recoveredAt
          )
          parked += 1
        }
      }
      return parked
    })
  }

  /**
   * Recover candidate skill transitions from the durable assistant tool_use
   * that opened this exact ledger edge. Older graph rows legitimately omit
   * the metadata; malformed current metadata is rejected rather than guessed.
   */
  private readDurableToolSkillActivationReceipts(
    conversationId: ConversationId,
    toolCallId: string,
    source: PersistedMessage
  ): readonly CursorSkillActivationReceipt[] {
    const raw = source.metadata?.[CURSOR_SKILL_ACTIVATION_RECEIPTS_METADATA_KEY]
    if (raw === undefined) return []
    if (!Array.isArray(raw)) {
      throw new Error(
        `Invalid durable skill activation metadata for ${conversationId}/${toolCallId}: expected an array`
      )
    }

    const byToolCallId = new Map<
      string,
      readonly CursorSkillActivationReceipt[]
    >()
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `Invalid durable skill activation metadata entry for ${conversationId}/${toolCallId}`
        )
      }
      const value = entry as Record<string, unknown>
      const rawToolCallId = value.toolCallId
      const rawReceipts = value.receipts
      if (
        typeof rawToolCallId !== "string" ||
        !rawToolCallId.trim() ||
        rawToolCallId !== rawToolCallId.trim() ||
        rawToolCallId.includes("\u0000") ||
        !Array.isArray(rawReceipts) ||
        byToolCallId.has(rawToolCallId)
      ) {
        throw new Error(
          `Invalid durable skill activation metadata shape for ${conversationId}/${toolCallId}`
        )
      }
      const receipts: CursorSkillActivationReceipt[] = []
      const names = new Set<string>()
      for (const rawReceipt of rawReceipts) {
        if (
          !rawReceipt ||
          typeof rawReceipt !== "object" ||
          Array.isArray(rawReceipt)
        ) {
          throw new Error(
            `Invalid durable skill activation receipt for ${conversationId}/${rawToolCallId}`
          )
        }
        const receipt = rawReceipt as Record<string, unknown>
        const skillName = receipt.skillName
        const reason = receipt.reason
        if (
          typeof skillName !== "string" ||
          !skillName.trim() ||
          typeof reason !== "string" ||
          !reason.trim() ||
          names.has(skillName)
        ) {
          throw new Error(
            `Invalid durable skill activation receipt shape for ${conversationId}/${rawToolCallId}`
          )
        }
        names.add(skillName)
        receipts.push(
          Object.freeze({
            skillName,
            reason,
          })
        )
      }
      byToolCallId.set(rawToolCallId, receipts)
    }
    return byToolCallId.get(toolCallId) ?? []
  }

  private readDurableToolHookAdditionalContexts(
    conversationId: ConversationId,
    toolCallId: string,
    source: PersistedMessage
  ): readonly CursorHookAdditionalContextReceipt[] {
    const raw = source.metadata?.[CURSOR_HOOK_ADDITIONAL_CONTEXTS_METADATA_KEY]
    if (raw === undefined) return []
    if (!Array.isArray(raw)) {
      throw new Error(
        `Invalid durable hook context metadata for ${conversationId}/${toolCallId}: expected an array`
      )
    }
    const matching = raw.filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `Invalid durable hook context metadata entry for ${conversationId}/${toolCallId}`
        )
      }
      return (entry as Record<string, unknown>).toolCallId === toolCallId
    })
    if (matching.length > 1) {
      throw new Error(
        `Duplicate durable hook context metadata for ${conversationId}/${toolCallId}`
      )
    }
    if (matching.length === 0) return []
    const contexts = (matching[0] as Record<string, unknown>).contexts
    if (!Array.isArray(contexts)) {
      throw new Error(
        `Invalid durable hook contexts for ${conversationId}/${toolCallId}`
      )
    }
    return contexts.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `Invalid durable hook context for ${conversationId}/${toolCallId}`
        )
      }
      const value = entry as Record<string, unknown>
      if (
        typeof value.hookEventName !== "string" ||
        !isCursorHookAdditionalContextEvent(value.hookEventName) ||
        typeof value.content !== "string" ||
        !value.content.length
      ) {
        throw new Error(
          `Invalid durable hook context shape for ${conversationId}/${toolCallId}`
        )
      }
      return Object.freeze({
        hookEventName: value.hookEventName,
        content: value.content,
      })
    })
  }

  /**
   * Classify a restored tool edge from the message row that opened it.
   *
   * The sidechain path is intentionally fail-closed: an incomplete branch
   * identity is never downgraded to a parent tool call, because that would
   * let a late client terminal mutate the wrong graph after restart.
   */
  private resolveSubagentSidechainToolOwner(
    conversationId: ConversationId,
    toolCallId: string,
    source: PersistedMessage
  ): SubagentSidechainToolOwner | undefined {
    if (source.isSidechain !== true) {
      const leakedSidechainFields = [
        source.threadId,
        source.branchId,
        source.agentId,
        source.forkSourceUuid,
      ].filter((value) => value !== undefined)
      if (
        leakedSidechainFields.length > 0 ||
        source.forkLineage !== undefined
      ) {
        throw new Error(
          `Restored parent tool edge carries sidechain identity fields: ` +
            `conversation=${conversationId} toolCallId=${toolCallId} sourceUuid=${source.uuid}`
        )
      }
      return undefined
    }

    const turnId = source.turnId
    const forkLineage = source.forkLineage
    let threadId: string
    let branchId: string
    let agentId: string
    let forkSourceUuid: string
    let exactForkLineage: string[]
    try {
      threadId = requireExactDurableIdentifier(
        source.threadId,
        "Restored sidechain thread id"
      )
      branchId = requireExactDurableIdentifier(
        source.branchId,
        "Restored sidechain branch id"
      )
      agentId = requireExactDurableIdentifier(
        source.agentId,
        "Restored sidechain agent id"
      )
      forkSourceUuid = requireExactDurableIdentifier(
        source.forkSourceUuid,
        "Restored sidechain fork source UUID"
      )
      exactForkLineage = Array.isArray(forkLineage)
        ? forkLineage.map((value, index) =>
            requireExactDurableIdentifier(
              value,
              `Restored sidechain fork lineage ${index}`
            )
          )
        : []
    } catch {
      throw new Error(
        `Restored sidechain tool edge has incomplete graph identity: ` +
          `conversation=${conversationId} toolCallId=${toolCallId} sourceUuid=${source.uuid}`
      )
    }
    if (!turnId || exactForkLineage.length === 0) {
      throw new Error(
        `Restored sidechain tool edge has incomplete graph identity: ` +
          `conversation=${conversationId} toolCallId=${toolCallId} sourceUuid=${source.uuid}`
      )
    }
    if (!exactForkLineage.includes(forkSourceUuid)) {
      throw new Error(
        `Restored sidechain tool edge fork lineage omits its fork source: ` +
          `conversation=${conversationId} toolCallId=${toolCallId} sourceUuid=${source.uuid}`
      )
    }
    return {
      agentId,
      threadId,
      branchId,
      turnId,
      forkSourceUuid,
      forkLineage: exactForkLineage,
      sourceToolAssistantUuid: source.uuid,
    }
  }

  /**
   * A parked, potentially delivered request is deliberately non-terminal and
   * must never be replayed on a new stream. Its original client identity
   * remains authoritative until a real terminal frame or an official
   * interrupted-pending resolution is received.
   */
  private resolveRestoredToolExecution(
    dispatches: readonly ExecDispatchRecord[],
    isRecoveredSidechain: boolean
  ): {
    status: ToolExecutionStatus
    reason: ToolExecutionRecoveryReason
  } {
    if (
      dispatches.some(
        (dispatch) => dispatch.state === "awaiting_interrupted_resolution"
      )
    ) {
      return {
        status: "awaitingClientResult",
        reason: isRecoveredSidechain
          ? "subagent_restart"
          : "interrupted_pending_resolution",
      }
    }
    if (
      dispatches.some(
        (dispatch) =>
          dispatch.state === "dispatching" || dispatch.state === "dispatched"
      )
    ) {
      return {
        status: "awaitingClientResult",
        reason: isRecoveredSidechain ? "subagent_restart" : "session_restore",
      }
    }
    return {
      status: "pending",
      reason: "session_restore",
    }
  }

  /**
   * Persist a mounted session's normalized state as one transaction. Graph
   * writes have their own append API, while this method owns the session row
   * and mutable domain projection that accompany it.
   */
  private persistMountedSessionSnapshot(
    conversationId: string,
    session: SessionRecord
  ): void {
    if (session.conversationId !== conversationId) {
      throw new Error(
        `Cannot persist ${conversationId}: session belongs to ${session.conversationId}`
      )
    }
    const context = this.contextState.getContextRecord(conversationId)
    if (!context) {
      throw new Error(
        `Cannot persist ${conversationId}: ContextStateRecord is not mounted`
      )
    }
    const cid = ConversationId.of(conversationId)
    this.messageStore.runInTransaction(cid, (txn) => {
      this.persistSessionSnapshotInTransaction(txn, session, context)
    })
  }

  private persistSessionSnapshotInTransaction(
    txn: SessionTxn,
    session: SessionRecord,
    context: ContextStateRecord
  ): void {
    const cid = ConversationId.of(session.conversationId)
    if (txn.conversationId !== cid) {
      throw new Error(
        `Cannot persist session snapshot: transaction conversation ${txn.conversationId} does not match ${cid}`
      )
    }
    this.sessionPersistence.persistSnapshotInTransaction(
      txn,
      this.createSessionPersistenceSnapshot(session, context)
    )
  }

  private serializeSessionConfig(
    session: SessionRecord
  ): SerializedSessionConfig {
    const config: SerializedSessionConfig = {
      version: CURRENT_SESSION_SNAPSHOT_VERSION,
      codexProviderIdentity: session.codexProviderIdentity,
      lastAssistantBackend: session.lastAssistantBackend,
      lastAssistantModel: session.lastAssistantModel,
      thinkingLevel: session.thinkingLevel,
      thinkingDetailsRequested: session.thinkingDetailsRequested,
      isAgentic: session.isAgentic,
      supportedTools: [...session.supportedTools],
      mcpToolDefs: session.mcpToolDefs,
      useWeb: session.useWeb,
      requestContextEnv: session.requestContextEnv,
      workspace: session.workspace
        ? serializeSessionWorkspace(session.workspace)
        : null,
      cursorManagedReadResources: serializeCursorManagedReadResources(
        session.cursorManagedReadResources
      ),
      codeChunks: session.codeChunks,
      cursorCommands: session.cursorCommands,
      customSystemPrompt: session.customSystemPrompt,
      hooksAdditionalContext: session.hooksAdditionalContext,
      ...(session.goalState
        ? { goalState: serializeBridgeGoalState(session.goalState) }
        : {}),
      ...(session.isRootProjectConversation !== undefined
        ? { isRootProjectConversation: session.isRootProjectConversation }
        : {}),
      explicitContext: session.explicitContext,
      contextTokenLimit: session.contextTokenLimit,
      contextTokenLimitSource: session.contextTokenLimitSource,
      contextMaxMode: session.contextMaxMode,
      usedContextTokens: session.usedContextTokens,
      requestedMaxOutputTokens: session.requestedMaxOutputTokens,
      requestedModelParameters: session.requestedModelParameters,
    }
    return config
  }

  private createSessionPersistenceSnapshot(
    session: SessionRecord,
    context: ContextStateRecord
  ): SessionPersistenceSnapshot {
    const cid = ConversationId.of(session.conversationId)
    const updatedAt = Date.now()
    return {
      row: this.createSessionRow(session),
      fileStates: Array.from(context.fileStates.entries()).flatMap(
        ([path, fileState]) => {
          const size = getSessionFileStateSize(
            fileState.beforeContent,
            fileState.afterContent
          )
          if (
            !isSessionFileStateWithinLimit(
              fileState.beforeContent,
              fileState.afterContent
            )
          ) {
            this.logger.warn(
              `Skipping oversized file state persistence for ${session.conversationId} ${path}: ` +
                describeSessionFileStateLimit(size.beforeBytes, size.afterBytes)
            )
            return []
          }
          return [
            {
              conversationId: cid,
              path,
              beforeContent: Buffer.from(fileState.beforeContent),
              afterContent: Buffer.from(fileState.afterContent),
              updatedAt,
            },
          ]
        }
      ),
      readPaths: Array.from(context.readPaths).map((readPath) => ({
        conversationId: cid,
        path: readPath,
        readAt: updatedAt,
      })),
      messageBlobs: context.messageBlobIds.map((blobId) => ({
        conversationId: cid,
        blobId,
        addedAt: updatedAt,
      })),
      todos: context.todos.map(
        (todo): SessionTodo => ({
          conversationId: cid,
          id: todo.id,
          content: todo.content,
          status: todo.status,
          createdAt: todo.createdAt,
          updatedAt: todo.updatedAt,
          dependencies: [...todo.dependencies],
        })
      ),
    }
  }

  private createSessionRow(session: SessionRecord): SessionRow {
    return {
      conversationId: ConversationId.of(session.conversationId),
      createdAt: session.createdAt.getTime(),
      lastActivityAt: session.lastActivityAt.getTime(),
      model: session.model,
      config: this.serializeSessionConfig(session),
    }
  }

  private loadPersistedSessionState(
    row: SessionRow,
    graph: LoadedPersistedSessionGraph,
    restoredPendingToolCalls: readonly PersistedPendingToolCall[]
  ): PersistedChatSession {
    const conversationId = row.conversationId as string
    const config = this.readCurrentSessionConfig(row)
    const fileStates = this.sessionPersistence
      .listFileStates(row.conversationId)
      .map((fileState) => ({
        path: fileState.path,
        beforeContent: fileState.beforeContent.toString(),
        afterContent: fileState.afterContent.toString(),
      }))
    const readPaths = this.sessionPersistence
      .listReadPaths(row.conversationId)
      .map((readPath) => readPath.path)
    const messageBlobIds = this.sessionPersistence
      .listMessageBlobs(row.conversationId)
      .map((blob) => blob.blobId)

    return {
      version: CURRENT_SESSION_SNAPSHOT_VERSION,
      conversationId,
      messages: [...graph.projectedMainMessages],
      model: row.model,
      codexProviderIdentity: config.codexProviderIdentity,
      lastAssistantBackend: config.lastAssistantBackend,
      lastAssistantModel: config.lastAssistantModel,
      thinkingLevel: config.thinkingLevel,
      thinkingDetailsRequested: config.thinkingDetailsRequested,
      isAgentic: config.isAgentic,
      supportedTools: [...config.supportedTools],
      mcpToolDefs: config.mcpToolDefs,
      useWeb: config.useWeb,
      requestContextEnv: config.requestContextEnv,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      restoredPendingToolCalls: [...restoredPendingToolCalls],
      workspace: config.workspace,
      cursorManagedReadResources: config.cursorManagedReadResources,
      codeChunks: config.codeChunks,
      cursorCommands: config.cursorCommands,
      customSystemPrompt: config.customSystemPrompt,
      hooksAdditionalContext: config.hooksAdditionalContext,
      goalState: config.goalState,
      isRootProjectConversation: config.isRootProjectConversation,
      explicitContext: config.explicitContext,
      contextTokenLimit: config.contextTokenLimit,
      contextTokenLimitSource: config.contextTokenLimitSource,
      contextMaxMode: config.contextMaxMode,
      usedContextTokens: config.usedContextTokens,
      requestedMaxOutputTokens: config.requestedMaxOutputTokens,
      requestedModelParameters: config.requestedModelParameters,
      readPaths,
      fileStates,
      messageBlobIds,
      todos: this.loadPersistedTodos(conversationId),
    }
  }

  private readCurrentSessionConfig(row: SessionRow): RestoredSessionConfig {
    return decodeSerializedSessionConfig(row.config, String(row.conversationId))
  }

  private loadPersistedGraph(
    conversationId: ConversationId
  ): LoadedPersistedSessionGraph {
    const rawMessages = this.messageStore.getMessages(conversationId)
    const revisionsByMessageUuid = new Map<
      string,
      ReturnType<MessageStore["getAllMessageRevisions"]>
    >()
    for (const revision of this.messageStore.getAllMessageRevisions(
      conversationId
    )) {
      const revisions = revisionsByMessageUuid.get(revision.messageUuid)
      if (revisions) {
        revisions.push(revision)
      } else {
        revisionsByMessageUuid.set(revision.messageUuid, [revision])
      }
    }
    const projectedMainMessages = rawMessages
      // A sub-agent branch is persisted in the same conversation graph for
      // audit and branch-local replay, but never becomes parent prompt state
      // after a cold restore. Child runners load their own `thread_id` via
      // ContextStateService.getSubagentGraphMessages instead.
      .filter((message) => message.isSidechain !== true)
      .map((message) =>
        applyMessageRevisionProjection(
          projectPersistedMessageToSessionMessage(message),
          revisionsByMessageUuid.get(message.uuid) ?? []
        )
      )
    return {
      rawMessages,
      projectedMainMessages,
    }
  }

  /** Restore one owner-scoped provider-neutral compact layout. */
  private restoreContextProjectionFromStore(
    owner: ProjectionOwner,
    state: ContextConversationState,
    graphRecords: readonly ContextTranscriptRecord[],
    snipBoundaryRecords: readonly ContextTranscriptRecord[],
    activeHead: ContextProjectionHead
  ): boolean {
    const restored = this.contextProjectionStore.restore(owner, activeHead)
    if (!restored) {
      throw new Error(
        `Generic projection active head has no durable layout for ` +
          `${owner.conversationId}/${owner.ownerKey}`
      )
    }
    const rebuilt = rebuildContextProjectionRecords({
      graphRecords,
      snipBoundaryRecords,
      restored,
    })
    state.records = rebuilt.records
    state.compactionHistory = deriveCompactionHistoryFromTranscript(
      rebuilt.records
    )
    state.activeCompactionId = rebuilt.activeCommit.id
    state.compactionEpoch = rebuilt.generation
    state.lastAppliedCompaction = {
      recordCount: rebuilt.records.length,
      attachmentFingerprint: this.requireProjectionAttachmentFingerprint(
        rebuilt.activeCommit,
        owner.conversationId
      ),
      appliedAt: rebuilt.activeCommit.createdAt,
      compactionId: rebuilt.activeCommit.id,
      epoch: rebuilt.generation,
    }
    state.graphWatermarkUuid = graphRecords.at(-1)?.id
    delete state.toolResultReplacementState
    return true
  }

  /**
   * Rebuild an owner-scoped Claude projection before it is mounted. The
   * provider layout remains distinct from the full graph used by the UI; only
   * `ContextConversationState.records` becomes Claude's exact active window.
   *
   * The mutation tail follows a strict detached sequence: recover the head,
   * prepare its unconsumed append-only tail, materialize a local next state,
   * CAS the durable watermark, then publish the completed state to the caller.
   * A failure leaves every lifecycle registry untouched.
   */
  private restoreClaudeProjectionFromStore(
    owner: ProjectionOwner,
    state: ContextConversationState,
    graphRecords: readonly ContextTranscriptRecord[],
    snipBoundaryRecords: readonly ContextTranscriptRecord[]
  ): boolean {
    const ref = createProviderProjectionRef({
      owner,
      provider: "claude",
      localKey: CLAUDE_CONVERSATION_PROJECTION_LOCAL_KEY,
    })
    const restored = this.claudeProjectionStore.restore(ref)
    if (!restored) return false

    const rebuiltRecords = rebuildClaudeProjectionRecords({
      graphRecords,
      snipBoundaryRecords,
      restored,
    })
    const drain = this.claudeProjectionStore.prepareMutationDrain(ref)
    if (drain.expectedHeadRevision !== restored.providerHeadRevision) {
      throw new Error(
        `Claude cold restore observed a changed provider head for ${owner.conversationId}/${owner.ownerKey}`
      )
    }
    const nextReplacementState =
      this.claudeProjectionStore.materializePreparedMutationDrain(drain)
    const activeCommit = getActiveCompactCommitFromTranscript(rebuiltRecords)
    const nextLastAppliedCompaction = activeCommit
      ? {
          recordCount: rebuiltRecords.length,
          attachmentFingerprint: this.requireProjectionAttachmentFingerprint(
            activeCommit,
            owner.conversationId
          ),
          appliedAt: activeCommit.createdAt,
          compactionId: activeCommit.id,
          epoch: restored.generation,
        }
      : undefined

    // This is the durable commit boundary. A newer tail may exist after the
    // prepared target, but it remains unconsumed for the next explicit drain.
    this.claudeProjectionStore.commitPreparedMutationDrain(drain)

    state.records = rebuiltRecords
    state.compactionHistory =
      deriveCompactionHistoryFromTranscript(rebuiltRecords)
    state.activeCompactionId = activeCommit?.id
    state.compactionEpoch = restored.generation
    state.lastAppliedCompaction = nextLastAppliedCompaction
    state.toolResultReplacementState = nextReplacementState
    state.graphWatermarkUuid = graphRecords.at(-1)?.id
    return true
  }

  private requireProjectionAttachmentFingerprint(
    commit: ContextCompactionCommit,
    conversationId: ConversationId
  ): string {
    const fingerprint = commit.attachmentFingerprint?.trim()
    if (!fingerprint) {
      throw new Error(
        `Context projection restore compact ${commit.id} has no attachment fingerprint for ${conversationId}`
      )
    }
    if (!Number.isSafeInteger(commit.createdAt) || commit.createdAt <= 0) {
      throw new Error(
        `Context projection restore compact ${commit.id} has invalid createdAt for ${conversationId}`
      )
    }
    return fingerprint
  }

  private loadPersistedSession(
    conversationId: string
  ): SessionRecord | undefined {
    try {
      const row = this.sessionPersistence.loadSession(
        ConversationId.of(conversationId)
      )
      if (!row) return undefined

      if (Date.now() - row.lastActivityAt > this.PERSISTED_SESSION_TTL_MS) {
        this.deletePersistedSession(conversationId)
        this.deleteToolResultStorage(conversationId)
        return undefined
      }

      // Cold recovery has one graph owner and must run before open-ledger
      // reconstruction. It atomically terminalizes stale sub-agent runs,
      // writes their parent delivery/memory, and parks any previously-sent
      // sidechain exec for Cursor's official interrupted resolution. Mounting first
      // would expose those inner edges to ordinary pending-tool recovery.
      const coldSubagentRecovery =
        this.contextState.reconcileStaleSubagentRunsBeforeMount(
          row.conversationId
        )
      if (
        coldSubagentRecovery.interruptedRuns > 0 ||
        coldSubagentRecovery.deliveredParentResults > 0 ||
        coldSubagentRecovery.abortedUnwrittenSidechainToolCalls > 0 ||
        coldSubagentRecovery.parkedSidechainClientTerminals > 0
      ) {
        this.logger.warn(
          `[context-restore] reconciled stale sub-agent work before mount ` +
            `conversation=${conversationId} interrupted=${coldSubagentRecovery.interruptedRuns} ` +
            `parentDeliveries=${coldSubagentRecovery.deliveredParentResults} ` +
            `unwrittenSidechain=${coldSubagentRecovery.abortedUnwrittenSidechainToolCalls} ` +
            `parkedClientTerminals=${coldSubagentRecovery.parkedSidechainClientTerminals}`
        )
      }

      const openRuntimeEdges = this.toolCallLedger
        .listOpen(row.conversationId)
        .filter((entry) => entry.origin === "runtime")
      const persistedGraph = this.loadPersistedGraph(row.conversationId)
      const parkedMainClientDispatches = this.parkRestoredMainClientDispatches(
        row.conversationId,
        openRuntimeEdges,
        persistedGraph.rawMessages
      )
      if (parkedMainClientDispatches > 0) {
        this.logger.warn(
          `[context-restore] parked ${parkedMainClientDispatches} potentially sent main client dispatch(es) ` +
            `for official interrupted-pending resolution conversation=${conversationId}`
        )
      }
      const restoredPendingToolCalls = this.loadRestoredOpenToolLedger(
        row.conversationId,
        openRuntimeEdges,
        persistedGraph.rawMessages
      )
      const persisted = this.loadPersistedSessionState(
        row,
        persistedGraph,
        restoredPendingToolCalls
      )

      const restored = this.parsePersistedSession(persisted)
      this.loadConfiguredWorkspaceGrants(restored.session)
      const session = this.mountRestoredSession(restored)
      const ctx = restored.context
      this.logger.log(
        `>>> Restored persisted session: ${conversationId} ` +
          `(messages=${ctx.mainProjection.messages.length}, records=${ctx.mainProjection.messageRecords.length}, turns=${ctx.turns.length}, pending=${this.pendingToolCallCount(conversationId)})`
      )
      this.schedulePersist(conversationId)
      return session
    } catch (error) {
      this.logger.error(
        `Failed to load persisted session ${conversationId}: ${String(error)}`
      )
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private mountRestoredSession(restored: RestoredSessionBundle): SessionRecord {
    const conversationId = restored.session.conversationId
    const preparedPending = this.prepareRestoredPendingToolCalls(restored)
    const session = this.publishDetachedSession(restored, preparedPending)
    if (preparedPending.length > 0) {
      this.logger.warn(
        `[context-restore] waiting for ${preparedPending.length} durable tool terminal(s): ` +
          `conversation=${conversationId}`
      )
    }
    return session
  }

  /**
   * Rebuild only the runtime indexes that are required to consume a genuine
   * client terminal frame. The durable graph and exec outbox remain the source
   * of truth; no restart path creates an abort result or guesses a terminal
   * state. Old numeric exec ids are intentionally not copied into the
   * stream-local map because that map has no epoch dimension.
   */
  private prepareRestoredPendingToolCalls(
    restored: RestoredSessionBundle
  ): Array<PendingToolEntry<PendingToolCall>> {
    const { session, stream, restoredPendingToolCalls } = restored
    const conversationId = ConversationId.of(session.conversationId)
    const seen = new Set<string>()
    const prepared: Array<PendingToolEntry<PendingToolCall>> = []
    for (const recovered of restoredPendingToolCalls) {
      const turnId = TurnId.of(recovered.turnId)
      const toolCallId = requireExactDurableIdentifier(
        recovered.toolCallId,
        "SessionLifecycleService durable pending toolCallId"
      )
      if (seen.has(toolCallId)) {
        throw new Error(
          `Duplicate restored pending tool call: conversation=${session.conversationId} ` +
            `toolCallId=${toolCallId}`
        )
      }
      seen.add(toolCallId)
      if (!this.toolCallLedger.isOpen(conversationId, toolCallId)) {
        throw new Error(
          `Restored pending tool call no longer has an open ledger edge: ` +
            `conversation=${session.conversationId} toolCallId=${toolCallId}`
        )
      }
      const pending: PendingToolCall = {
        toolCallId,
        toolName: recovered.toolName,
        toolInput: structuredClone(recovered.toolInput),
        historyToolName: recovered.historyToolName,
        historyToolInput: recovered.historyToolInput
          ? structuredClone(recovered.historyToolInput)
          : undefined,
        codexToolCallType: recovered.codexToolCallType,
        skillActivationReceipts: recovered.skillActivationReceipts?.map(
          (receipt) => ({ ...receipt })
        ),
        hookAdditionalContexts: recovered.hookAdditionalContexts?.map(
          (context) => ({ ...context })
        ),
        toolFamilyHint: recovered.toolFamilyHint,
        modelCallId: recovered.modelCallId,
        startedEmitted: recovered.startedEmitted,
        sentAt: new Date(recovered.sentAt),
        execIds: new Set(recovered.execIds),
        editApplyWarning: recovered.editApplyWarning,
        editFailureContext: recovered.editFailureContext,
        editNoopReason: recovered.editNoopReason,
        beforeContent: recovered.beforeContent,
        shellStreamOutput: recovered.shellStreamOutput
          ? structuredClone(recovered.shellStreamOutput)
          : undefined,
        streamId: stream.currentStreamId,
        sidechainOwner: recovered.sidechainOwner
          ? {
              ...recovered.sidechainOwner,
              forkLineage: [...recovered.sidechainOwner.forkLineage],
            }
          : undefined,
        executionOwner: recovered.executionOwner,
        executionStatus: recovered.executionStatus,
        executionRecoveryReason: recovered.executionRecoveryReason,
        executionOrder: recovered.executionOrder,
      }
      prepared.push({
        conversationId,
        turnId,
        toolCallId,
        toolName: recovered.toolName,
        startedAt: recovered.sentAt,
        payload: pending,
      })
    }
    return prepared
  }

  private deletePersistedSession(conversationId: string): void {
    try {
      this.sessionPersistence.deleteSession(ConversationId.of(conversationId))
    } catch (error) {
      this.logger.error(
        `Failed to delete persisted session ${conversationId}: ${String(error)}`
      )
    }
  }

  private deleteToolResultStorage(conversationId: string): void {
    try {
      this.toolResultStorage.deleteConversation(conversationId)
    } catch (error) {
      this.logger.warn(
        `Failed to delete stored tool results for ${conversationId}: ${String(error)}`
      )
    }
  }

  private createEmptyToolMetrics(): SessionToolMetrics {
    return {
      completedCalls: 0,
      shellCalls: 0,
      editCalls: 0,
      mcpCalls: 0,
      otherCalls: 0,
      totalDurationMs: 0,
      lastCompletedAt: null,
    }
  }

  private createEmptyTopLevelAgentTurnState(): SessionTopLevelAgentTurnState {
    return {
      llmTurnCount: 1,
      codexContextRevision: 0,
      continuationBudget: {
        continuationCount: 0,
        lastHistoryTokens: 0,
        lastDeltaTokens: 0,
        startedAt: Date.now(),
      },
    }
  }

  classifyToolCall(
    toolCall: Pick<PendingToolCall, "toolName" | "toolFamilyHint">
  ): "shell" | "edit" | "mcp" | "other" {
    const toolName = toolCall.toolName.toLowerCase()
    if (
      toolCall.toolFamilyHint === "edit" ||
      toolName === "edit_file_v2" ||
      toolName === "edit"
    ) {
      return "edit"
    }
    if (toolCall.toolFamilyHint === "mcp") {
      return "mcp"
    }
    if (
      toolName.includes("run_terminal_command") ||
      toolName.includes("write_shell_stdin")
    ) {
      return "shell"
    }
    return "other"
  }

  private toDiffLines(content: string): string[] {
    if (!content) return []
    const lines = content.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop()
    }
    return lines
  }

  private countLineDelta(
    beforeContent: string,
    afterContent: string
  ): { linesAdded: number; linesRemoved: number } {
    const beforeLines = this.toDiffLines(beforeContent)
    const afterLines = this.toDiffLines(afterContent)

    let prefix = 0
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix++
    }

    let beforeEnd = beforeLines.length - 1
    let afterEnd = afterLines.length - 1
    while (
      beforeEnd >= prefix &&
      afterEnd >= prefix &&
      beforeLines[beforeEnd] === afterLines[afterEnd]
    ) {
      beforeEnd--
      afterEnd--
    }

    const beforeRemaining = beforeLines.slice(prefix, beforeEnd + 1)
    const afterRemaining = afterLines.slice(prefix, afterEnd + 1)

    if (beforeRemaining.length === 0 || afterRemaining.length === 0) {
      return {
        linesAdded: afterRemaining.length,
        linesRemoved: beforeRemaining.length,
      }
    }

    const maxCells = 1_000_000
    if (beforeRemaining.length * afterRemaining.length > maxCells) {
      return {
        linesAdded: afterRemaining.length,
        linesRemoved: beforeRemaining.length,
      }
    }

    let previous: number[] = new Array<number>(afterRemaining.length + 1).fill(
      0
    )
    for (const beforeLine of beforeRemaining) {
      const current: number[] = new Array<number>(
        afterRemaining.length + 1
      ).fill(0)
      for (let index = 1; index <= afterRemaining.length; index++) {
        current[index] =
          beforeLine === afterRemaining[index - 1]
            ? (previous[index - 1] ?? 0) + 1
            : Math.max(previous[index] ?? 0, current[index - 1] ?? 0)
      }
      previous = current
    }

    const lcsLength: number = previous[afterRemaining.length] ?? 0
    return {
      linesAdded: afterRemaining.length - lcsLength,
      linesRemoved: beforeRemaining.length - lcsLength,
    }
  }

  private getSessionLineChangeStats(context: ContextStateRecord): {
    linesAdded: number
    linesRemoved: number
  } {
    let linesAdded = 0
    let linesRemoved = 0

    for (const state of context.fileStates.values()) {
      const delta = this.countLineDelta(state.beforeContent, state.afterContent)
      linesAdded += delta.linesAdded
      linesRemoved += delta.linesRemoved
    }

    return { linesAdded, linesRemoved }
  }

  private buildAnalyticsEntry(
    conversationId: string,
    session: SessionRecord,
    context: ContextStateRecord,
    loaded: boolean,
    now: number
  ): ChatSessionAnalyticsEntry {
    const lineStats = this.getSessionLineChangeStats(context)
    const idleMs = Math.max(0, now - session.lastActivityAt.getTime())
    const contextTokenLimit =
      typeof session.contextTokenLimit === "number" &&
      Number.isSafeInteger(session.contextTokenLimit) &&
      session.contextTokenLimit > 0
        ? session.contextTokenLimit
        : null
    const usedContextTokens =
      typeof session.usedContextTokens === "number" &&
      Number.isSafeInteger(session.usedContextTokens) &&
      session.usedContextTokens >= 0
        ? session.usedContextTokens
        : null
    const requestedMaxOutputTokens =
      typeof session.requestedMaxOutputTokens === "number" &&
      Number.isSafeInteger(session.requestedMaxOutputTokens) &&
      session.requestedMaxOutputTokens > 0
        ? session.requestedMaxOutputTokens
        : null
    const contextMaxMode =
      typeof session.contextMaxMode === "boolean"
        ? session.contextMaxMode
        : null
    const contextUsagePct =
      contextTokenLimit && usedContextTokens != null && contextTokenLimit > 0
        ? Math.round((usedContextTokens / contextTokenLimit) * 1000) / 10
        : null

    return {
      conversationId,
      loaded,
      active: idleMs < this.ACTIVE_SESSION_WINDOW_MS,
      model: session.model || "(unknown)",
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      idleMs,
      pendingToolCalls: this.pendingToolCallCount(session.conversationId),
      completedToolCalls: context.toolMetrics.completedCalls,
      shellToolCalls: context.toolMetrics.shellCalls,
      editToolCalls: context.toolMetrics.editCalls,
      mcpToolCalls: context.toolMetrics.mcpCalls,
      otherToolCalls: context.toolMetrics.otherCalls,
      totalToolDurationMs: context.toolMetrics.totalDurationMs,
      avgToolDurationMs:
        context.toolMetrics.completedCalls > 0
          ? Math.round(
              (context.toolMetrics.totalDurationMs /
                context.toolMetrics.completedCalls) *
                10
            ) / 10
          : null,
      readFiles: context.readPaths.size,
      editedFiles: context.fileStates.size,
      linesAdded: lineStats.linesAdded,
      linesRemoved: lineStats.linesRemoved,
      contextTokenLimit,
      contextMaxMode,
      usedContextTokens,
      contextUsagePct,
      requestedMaxOutputTokens,
      ...this.deriveRunningSubagentMetrics(conversationId),
    }
  }

  createTranscriptRecord(
    message: SessionMessage,
    createdAt: number = Date.now()
  ): ContextTranscriptRecord {
    return {
      id: message.uuid,
      ...(message.parentUuid ? { parentUuid: message.parentUuid } : {}),
      ...(message.logicalParentUuid
        ? { logicalParentUuid: message.logicalParentUuid }
        : {}),
      ...(message.sourceToolAssistantUuid
        ? { sourceToolAssistantUuid: message.sourceToolAssistantUuid }
        : {}),
      ...(message.provider ? { provider: message.provider } : {}),
      ...(message.providerMessageId
        ? { providerMessageId: message.providerMessageId }
        : {}),
      ...(message.blockOccurrence !== undefined
        ? { blockIndex: message.blockOccurrence }
        : {}),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.branchId ? { branchId: message.branchId } : {}),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      ...(message.isSidechain ? { isSidechain: true } : {}),
      ...(message.forkSourceUuid
        ? { forkSourceUuid: message.forkSourceUuid }
        : {}),
      ...(message.forkLineage ? { forkLineage: [...message.forkLineage] } : {}),
      ...(message.excludedFromProviderProjection
        ? { excludedFromProviderProjection: true }
        : {}),
      role: message.message.role,
      kind: "message",
      content: message.message.content,
      createdAt,
      ...(message.type === "assistant" && message.message.id
        ? { messageId: message.message.id }
        : {}),
      ...(message.type === "user" && message.isMeta ? { isMeta: true } : {}),
    }
  }

  /**
   * Build a SessionMessage for a typed Cursor history fragment. Uses a
   * deterministic timestamp so imported graph order remains stable even when
   * the complete history arrives in one event-loop turn.
   */
  makeFreshSessionMessage(
    role: "user" | "assistant",
    content: MessageContent,
    seedTime: number = Date.now(),
    metadata?: Record<string, unknown>
  ): SessionMessage {
    return makeSessionMessage(role, content, {
      timestamp: new Date(seedTime).toISOString(),
      metadata,
    })
  }

  /**
   * Seed a completely empty durable graph under an already-open session
   * transaction. Both fresh bootstrap and the deferred control-first import
   * persist their complete domain snapshot in this same transaction.
   */
  private persistInitialTranscriptMessagesInTransaction(
    txn: SessionTxn,
    messages: SessionMessage[]
  ): SessionMessage[] {
    const conversationId = txn.conversationId
    if (this.messageStore.hasMessages(conversationId)) {
      throw new Error(
        `persistInitialTranscriptMessages: durable graph is not empty for ${conversationId}`
      )
    }
    if (messages.length === 0) {
      return []
    }
    if (
      !messages.every(
        (message) => message.metadata?.source === "cursor_conversation_history"
      )
    ) {
      throw new Error(
        "persistInitialTranscriptMessages: only typed Cursor conversation_history may seed an empty graph"
      )
    }
    const acceptedMessages: SessionMessage[] = []
    for (const message of messages) {
      const blocks = this.messageContentToBlocks(message.message.content)
      const timestamp = Date.parse(message.timestamp)
      let previousFragmentUuid: string | undefined
      if (message.type === "assistant") {
        for (let index = 0; index < blocks.length; index++) {
          const block = blocks[index]!
          if (block.type === "tool_result" || block.type === "cache_edits") {
            continue
          }
          const result = this.messageStore.appendAssistantBlock(txn, block, {
            metadata: message.metadata,
            provider: message.provider,
            providerMessageId: message.providerMessageId ?? message.message.id,
            logicalParentUuid: message.logicalParentUuid ?? message.uuid,
            parentUuid: previousFragmentUuid ?? message.parentUuid,
            threadId: message.threadId,
            branchId: message.branchId,
            agentId: message.agentId,
            isSidechain: message.isSidechain,
            forkSourceUuid: message.forkSourceUuid,
            forkLineage: message.forkLineage,
            blockOccurrence: index,
            timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
          })
          previousFragmentUuid = result.recordUuid
          acceptedMessages.push(
            projectPersistedMessageToSessionMessage(result.message)
          )
          if (isToolUseBlock(block)) {
            this.toolCallLedger.open(txn, {
              toolUseId: block.id,
              toolName: block.name,
              origin: "cursor_history",
              openMessageSeq: result.seq,
            })
          }
        }
        continue
      }

      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!
        if (isToolResultBlock(block)) {
          if (!this.toolCallLedger.isOpen(conversationId, block.tool_use_id)) {
            throw new Error(
              `persistInitialTranscriptMessages: refusing unmatched tool_result ` +
                `conversation=${conversationId} toolUseId=${block.tool_use_id}`
            )
          }
          const result = this.messageStore.appendToolResultBlock(txn, block, {
            metadata: message.metadata,
            logicalParentUuid: message.logicalParentUuid ?? message.uuid,
            parentUuid: previousFragmentUuid ?? message.parentUuid,
            provider: message.provider,
            providerMessageId: message.providerMessageId,
            threadId: message.threadId,
            branchId: message.branchId,
            agentId: message.agentId,
            isSidechain: message.isSidechain,
            forkSourceUuid: message.forkSourceUuid,
            forkLineage: message.forkLineage,
            blockOccurrence: index,
            timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
          })
          previousFragmentUuid = result.recordUuid
          acceptedMessages.push(
            projectPersistedMessageToSessionMessage(result.message)
          )
        } else {
          const result = this.messageStore.appendUserMessage(txn, [block], {
            isMeta: message.isMeta,
            metadata: message.metadata,
            logicalParentUuid: message.logicalParentUuid ?? message.uuid,
            parentUuid: previousFragmentUuid ?? message.parentUuid,
            sourceToolAssistantUuid: message.sourceToolAssistantUuid,
            provider: message.provider,
            providerMessageId: message.providerMessageId,
            threadId: message.threadId,
            branchId: message.branchId,
            agentId: message.agentId,
            isSidechain: message.isSidechain,
            forkSourceUuid: message.forkSourceUuid,
            forkLineage: message.forkLineage,
            blockOccurrence: index,
            timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
          })
          previousFragmentUuid = result.recordUuid
          acceptedMessages.push(
            projectPersistedMessageToSessionMessage(result.message)
          )
        }
      }
    }
    return acceptedMessages
  }

  /**
   * Build the first active graph projection while the fresh context record is
   * still detached. The committed graph is its only input; parser envelopes
   * never become mounted transcript state.
   */
  private prepareDetachedInitialGraphProjection(
    context: ContextStateRecord,
    messages: SessionMessage[]
  ): PreparedInitialGraphProjection {
    this.assertEmptyInitialGraphProjection(
      context,
      "prepareDetachedInitialGraphProjection"
    )

    const records = messages.map((message) => {
      const createdAt = Date.parse(message.timestamp)
      return this.createTranscriptRecord(
        message,
        Number.isFinite(createdAt) ? createdAt : Date.now()
      )
    })
    const events: SessionTranscriptEvent[] = []
    let nextSeq = 1
    for (const record of records) {
      const built = this.buildTranscriptEventsForRecord(record, nextSeq)
      events.push(...built)
      nextSeq += built.length
    }

    return {
      messages: [...messages],
      generation: messages.length,
      messageRecords: records,
      contextState: this.createContextState(records),
      transcriptEvents: events,
      nextTranscriptEventSeq: nextSeq,
    }
  }

  private assertEmptyInitialGraphProjection(
    context: ContextStateRecord,
    owner: string
  ): void {
    if (
      context.mainProjection.generation !== 0 ||
      context.mainProjection.messages.length > 0 ||
      context.mainProjection.messageRecords.length > 0 ||
      context.mainProjection.transcriptEvents.length > 0
    ) {
      throw new Error(
        `${owner}: refusing to replace a non-empty initial graph projection`
      )
    }
  }

  private messageContentToBlocks(content: MessageContent): ContentBlock[] {
    return Array.isArray(content)
      ? (content as ContentBlock[])
      : [{ type: "text", text: typeof content === "string" ? content : "" }]
  }

  createContextState(
    records: ContextTranscriptRecord[],
    sessionMemory?: readonly ContextSessionMemoryEntry[]
  ): ContextConversationState {
    return {
      records: [...records],
      compactionHistory: [],
      activeCompactionId: undefined,
      compactionEpoch: 0,
      lastAppliedCompaction: undefined,
      usageLedger: {},
      toolResultReplacementState: {
        seenToolUseIds: [],
        replacementByToolUseId: {},
        storedByToolUseId: {},
        records: [],
      },
      sessionMemory: (sessionMemory || []).map((entry) => ({ ...entry })),
      graphWatermarkUuid: records.slice().reverse().find(isMessageRecord)?.id,
    }
  }

  private syncMessagesFromRecords(
    records: ContextTranscriptRecord[]
  ): SessionMessage[] {
    return records.filter(isMessageRecord).map((record) =>
      makeSessionMessage(record.role, record.content, {
        uuid: record.id,
        timestamp: new Date(record.createdAt).toISOString(),
        messageId: record.messageId,
        isMeta: record.isMeta,
        parentUuid: record.parentUuid,
        logicalParentUuid: record.logicalParentUuid,
        sourceToolAssistantUuid: record.sourceToolAssistantUuid,
        provider: record.provider,
        providerMessageId: record.providerMessageId,
        blockOccurrence: record.blockIndex,
        turnId: record.turnId,
        threadId: record.threadId,
        branchId: record.branchId,
        agentId: record.agentId,
        isSidechain: record.isSidechain,
        forkSourceUuid: record.forkSourceUuid,
        forkLineage: record.forkLineage,
        excludedFromProviderProjection: record.excludedFromProviderProjection,
      })
    )
  }

  private rebuildTranscriptEventsFromRecords(
    records: ContextTranscriptRecord[]
  ): {
    events: SessionTranscriptEvent[]
    nextSeq: number
  } {
    const events: SessionTranscriptEvent[] = []
    let nextSeq = 1
    for (const record of records) {
      if (!isMessageRecord(record)) continue
      const built = this.buildTranscriptEventsForRecord(record, nextSeq)
      events.push(...built)
      nextSeq += built.length
    }
    return { events, nextSeq }
  }

  appendTranscriptEvent(
    session: SessionRecord,
    event: Omit<SessionTranscriptEvent, "id" | "seq" | "createdAt"> & {
      createdAt?: number
    }
  ): SessionTranscriptEvent {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    const seq = ctx.mainProjection.nextTranscriptEventSeq || 1
    const fullEvent: SessionTranscriptEvent = {
      id: `evt_${seq}_${crypto.randomUUID()}`,
      seq,
      createdAt: event.createdAt ?? Date.now(),
      ...event,
    }
    ctx.mainProjection.transcriptEvents.push(fullEvent)
    ctx.mainProjection.nextTranscriptEventSeq = seq + 1
    return fullEvent
  }

  buildTranscriptEventsForRecord(
    record: ContextTranscriptRecord,
    startSeq: number
  ): SessionTranscriptEvent[] {
    const events: SessionTranscriptEvent[] = []
    const turnId = record.turnId
    const base = {
      recordId: record.id,
      role: record.role,
      messageId: record.messageId,
      contentChars: this.countContentChars(record.content),
      createdAt: record.createdAt,
      turnId,
    }
    events.push({
      id: `evt_${startSeq}_${crypto.randomUUID()}`,
      seq: startSeq,
      kind: record.role === "assistant" ? "assistant_message" : "user_message",
      ...base,
    })

    let nextSeq = startSeq + 1
    for (const block of normalizeContent(record.content)) {
      if (isToolUseBlock(block)) {
        events.push({
          id: `evt_${nextSeq}_${crypto.randomUUID()}`,
          seq: nextSeq,
          kind: "tool_use",
          recordId: record.id,
          role: record.role,
          messageId: record.messageId,
          toolUseId: block.id,
          toolName: block.name,
          createdAt: record.createdAt,
          turnId,
        })
        nextSeq += 1
      } else if (isToolResultBlock(block)) {
        events.push({
          id: `evt_${nextSeq}_${crypto.randomUUID()}`,
          seq: nextSeq,
          kind: "tool_result",
          recordId: record.id,
          role: record.role,
          toolUseId: block.tool_use_id,
          contentChars: this.countContentChars(block.content),
          createdAt: record.createdAt,
          turnId,
        })
        nextSeq += 1
      }
    }

    return events
  }

  countContentChars(content: MessageContent): number {
    if (typeof content === "string") {
      return content.length
    }
    return safeJsonStringify(content, {
      maxDepth: 8,
      maxArrayItems: 200,
      maxObjectKeys: 100,
      maxStringLength: 8 * 1024,
    }).length
  }

  shouldFlushMessageImmediately(message: SessionMessage): boolean {
    if (message.type !== "user" || message.isMeta) {
      return false
    }
    return !normalizeContent(message.message.content).some(isToolResultBlock)
  }

  syncContextRecordsFromMessageRecords(
    state: ContextConversationState,
    messageRecords: ContextTranscriptRecord[]
  ): void {
    const activeCommit = getActiveCompactCommitFromTranscript(state.records)
    const visibleById = new Map(
      messageRecords.map((record) => [record.id, record])
    )
    const knownMessageIds = new Set<string>()
    const synced = state.records.map((record) => {
      if (!isMessageRecord(record)) return record
      knownMessageIds.add(record.id)
      const visible = visibleById.get(record.id)
      return visible ? { ...visible, kind: "message" as const } : record
    })
    const excludedMessageIds = new Set<string>()
    for (const record of state.records) {
      if (!isSnipBoundaryRecord(record)) continue
      for (const recordId of record.snipMetadata?.removedRecordIds ?? []) {
        excludedMessageIds.add(recordId)
      }
    }
    const graphWatermarkUuid =
      state.graphWatermarkUuid === undefined
        ? undefined
        : requireExactDurableIdentifier(
            state.graphWatermarkUuid,
            "Claude graph watermark"
          )
    let continuationRecords: ContextTranscriptRecord[]
    if (graphWatermarkUuid) {
      const graphWatermarkIndex = messageRecords.findIndex(
        (record) => record.id === graphWatermarkUuid
      )
      if (graphWatermarkIndex < 0) {
        throw new Error(
          `Claude graph watermark ${graphWatermarkUuid} is missing from the mounted durable graph`
        )
      }
      continuationRecords = messageRecords.slice(graphWatermarkIndex + 1)
    } else {
      if (state.records.length > 0) {
        throw new Error(
          "Mounted context projection has records but no durable main-graph watermark"
        )
      }
      const lastVisibleIndex = messageRecords.reduce(
        (lastIndex, record, index) =>
          knownMessageIds.has(record.id) ? index : lastIndex,
        -1
      )
      continuationRecords =
        lastVisibleIndex >= 0
          ? messageRecords.slice(lastVisibleIndex + 1)
          : messageRecords
    }
    const appended = continuationRecords.filter(
      (record) =>
        !knownMessageIds.has(record.id) && !excludedMessageIds.has(record.id)
    )
    state.records = [
      ...synced,
      ...appended.map((record) => ({
        ...record,
        kind: "message" as const,
      })),
    ]
    state.compactionHistory = deriveCompactionHistoryFromTranscript(
      state.records
    )
    state.activeCompactionId = activeCommit?.id
    state.graphWatermarkUuid = messageRecords.at(-1)?.id
  }

  /**
   * Read-only restore construction. It never touches the lifecycle,
   * ContextState or SessionStream registries, so analytics can inspect a
   * durable row without creating live transient state.
   */
  private parsePersistedSession(
    persisted: PersistedChatSession
  ): RestoredSessionBundle {
    const createdAt = new Date(persisted.createdAt)
    const lastActivityAt = new Date(persisted.lastActivityAt)
    const messageRecords = persisted.messages.map((message, index) =>
      this.createTranscriptRecord(message, createdAt.getTime() + index * 1000)
    )
    const conversationId = ConversationId.of(persisted.conversationId)
    const snipBoundaryRecords = materializeSnipBoundaryRecords({
      graphRecords: messageRecords,
      events: this.snipBoundaryStore.list(conversationId),
    })
    const sessionMemory =
      this.sessionMemoryEvents.listMaterialized(conversationId)
    // Session configuration never owns a mutable context JSON mirror. The
    // main graph and provider-neutral layout events build the initial detached
    // state, then an installed Claude head replaces only the provider context
    // window before this bundle can become visible.
    const mainContextState = this.createContextState(
      mergeSnipBoundariesIntoGraph({
        graphRecords: messageRecords,
        boundaryRecords: snipBoundaryRecords,
      }),
      sessionMemory
    )
    const mainOwner = createMainProjectionOwner(conversationId)
    const activeMainProjectionHead = this.contextProjectionHeads.get(mainOwner)
    if (activeMainProjectionHead) {
      this.restoreContextProjectionFromStore(
        mainOwner,
        mainContextState,
        messageRecords,
        snipBoundaryRecords,
        activeMainProjectionHead
      )
    }
    this.restoreClaudeProjectionFromStore(
      mainOwner,
      mainContextState,
      messageRecords,
      snipBoundaryRecords
    )
    const transcriptEventState =
      this.rebuildTranscriptEventsFromRecords(messageRecords)
    const topLevelAgentTurnState = this.createEmptyTopLevelAgentTurnState()

    // The active projection is rebuilt directly from the durable graph
    // records. Lifecycle keeps no transcript mirror.
    const sessionMessages = this.syncMessagesFromRecords(messageRecords)

    const mainProjection: MountedContextProjection = {
      owner: mainOwner,
      messages: sessionMessages,
      generation: sessionMessages.length,
      messageRecords,
      transcriptEvents: transcriptEventState.events,
      nextTranscriptEventSeq: transcriptEventState.nextSeq,
      contextState: mainContextState,
      usedTokens: 0,
    }
    const childProjections = this.restoreChildMountedProjections(conversationId)

    const contextRecord = this.buildContextRecordFromPersisted(
      persisted,
      mainProjection,
      childProjections,
      topLevelAgentTurnState
    )
    const streamRecord = this.buildStreamRecordFromPersisted()

    const session: SessionLifecycleRecord = {
      conversationId: persisted.conversationId,
      model: persisted.model,
      codexProviderIdentity: persisted.codexProviderIdentity,
      lastAssistantBackend: persisted.lastAssistantBackend,
      // Subagent model overrides are request-scoped (Cursor re-sends them
      // on every AgentRunRequest), so we don't persist them.  A reloaded
      // session starts empty and the next AgentRunRequest will refresh
      // it via getOrCreateSession.
      subagentModelOverrides: EMPTY_SUBAGENT_MODEL_OVERRIDES,
      selectedSubagentModels: EMPTY_SELECTED_SUBAGENT_MODELS,
      lastAssistantModel: persisted.lastAssistantModel,
      thinkingLevel: persisted.thinkingLevel,
      thinkingDetailsRequested: persisted.thinkingDetailsRequested,
      isAgentic: persisted.isAgentic,
      supportedTools: freezeCacheKeyArray(persisted.supportedTools, []),
      // discoveredTools is intentionally not persisted: a tool's full
      // schema is cheaper to re-discover (one extra inline turn) than
      // to keep the schema set in sync across SQLite restarts and
      // upstream-side schema changes.  Always start fresh on restore.
      discoveredTools: new Set<string>(),
      mcpToolDefs: freezeCacheKeyArray(persisted.mcpToolDefs),
      useWeb: persisted.useWeb,
      requestContextEnv: persisted.requestContextEnv,
      createdAt,
      lastActivityAt,
      workspace: persisted.workspace === null ? undefined : persisted.workspace,
      cursorManagedReadResources: persisted.cursorManagedReadResources,
      codeChunks: persisted.codeChunks,
      // Cursor rules are request-scoped and re-sent by Cursor on each
      // user/resume action. Restoring them from persisted session state causes
      // stale/duplicated default rules to leak across turns.
      cursorRules: undefined,
      skillOptions: undefined,
      selectedCursorRulePaths: undefined,
      selectedCursorRuleNames: undefined,
      activeCursorSkillNames: [],
      cursorCommands: persisted.cursorCommands,
      customSystemPrompt: persisted.customSystemPrompt,
      hooksAdditionalContext: persisted.hooksAdditionalContext,
      goalState: persisted.goalState,
      isRootProjectConversation: persisted.isRootProjectConversation,
      explicitContext: persisted.explicitContext,
      contextTokenLimit: persisted.contextTokenLimit,
      contextTokenLimitSource: persisted.contextTokenLimitSource,
      contextMaxMode: persisted.contextMaxMode,
      usedContextTokens: persisted.usedContextTokens,
      requestedMaxOutputTokens: persisted.requestedMaxOutputTokens,
      requestedModelParameters: persisted.requestedModelParameters,
      // Cursor re-advertises hooks_config on each request/reattach. A restored
      // process must not execute a stale project hook selection before that.
      hookConfiguredSteps: Object.freeze([]),
      // Config grants are reconciled from the current primary root after the
      // session mounts; persisted config grants only describe the exact
      // snapshot that was previously active.
      configuredWorkspaceGrantsLoadedForPrimary: undefined,
      // Intentionally NOT rehydrated — the IDE re-sends any unconsumed
      // ConversationAction frames (e.g. asyncAskQuestionCompletion)
      // after bidi-stream restart, so a persisted entry would just
      // duplicate the replayed frame.
      deferredControlContinuations: [],
    }

    return {
      session,
      context: contextRecord,
      stream: streamRecord,
      restoredPendingToolCalls: persisted.restoredPendingToolCalls,
    }
  }

  /**
   * Cold-mount every durable child branch from its own graph, layout head and
   * branch receipt. Parent UI/session memory never becomes child input.
   */
  private restoreChildMountedProjections(
    conversationId: ConversationId
  ): Map<string, MountedContextProjection> {
    const projections = new Map<string, MountedContextProjection>()
    for (const run of this.subagentRunStore.listInConversation(
      conversationId
    )) {
      const owner = this.subagentBranches.createProjectionOwnerForAgent(
        conversationId,
        run.agentId
      )
      const branch = this.subagentBranches.readProjectionBranch(owner)
      const messages = this.contextState.getSubagentGraphMessages(
        String(conversationId),
        branch
      )
      const records = messages.map((message) => {
        const createdAt = Date.parse(message.timestamp)
        return this.createTranscriptRecord(
          message,
          Number.isFinite(createdAt) ? createdAt : Date.now()
        )
      })
      const state = this.createContextState(records)
      const activeHead = this.contextProjectionHeads.get(owner)
      if (activeHead) {
        this.restoreContextProjectionFromStore(
          owner,
          state,
          records,
          [],
          activeHead
        )
      }
      this.restoreClaudeProjectionFromStore(owner, state, records, [])
      const transcriptEvents = this.rebuildTranscriptEventsFromRecords(records)
      const snapshot = this.subagentBranches.readProjectionBranchSnapshot(owner)
      const projection: MountedContextProjection = {
        owner,
        messages,
        generation: messages.length,
        messageRecords: records,
        transcriptEvents: transcriptEvents.events,
        nextTranscriptEventSeq: transcriptEvents.nextSeq,
        contextState: state,
        usedTokens: 0,
        branchSnapshot: snapshot,
      }
      if (projections.has(owner.ownerKey)) {
        throw new Error(
          `SessionLifecycleService: duplicate child projection owner during restore ` +
            `conversation=${conversationId} owner=${owner.ownerKey}`
        )
      }
      projections.set(owner.ownerKey, projection)
    }
    return projections
  }

  /** Build a detached context restore bundle from current durable tables. */
  private buildContextRecordFromPersisted(
    persisted: PersistedChatSession,
    mainProjection: MountedContextProjection,
    childProjections: Map<string, MountedContextProjection>,
    topLevelAgentTurnState: SessionTopLevelAgentTurnState
  ): ContextStateRecord {
    return {
      mainProjection,
      childProjections,
      taskBudgetState: undefined,
      topLevelAgentTurnState,
      readPaths: new Set(persisted.readPaths),
      readSnapshots: [],
      fileStates: new Map(
        persisted.fileStates.map((state) => [
          state.path,
          {
            beforeContent: state.beforeContent,
            afterContent: state.afterContent,
          },
        ])
      ),
      toolMetrics: this.createEmptyToolMetrics(),
      messageBlobIds: [...persisted.messageBlobIds],
      turns: [],
      currentAssistantMessage: undefined,
      stepId: 0,
      execId: this.execDispatchStore.nextExecIdAfterHistory(
        ConversationId.of(persisted.conversationId)
      ),
      todos: [...persisted.todos],
    }
  }

  /** In-flight stream ownership is never restored across a process restart. */
  private buildStreamRecordFromPersisted(): SessionStreamRecord {
    return {
      pendingToolCallByExecId: new Map(),
      retiredToolCallByExecId: new Map(),
      currentStreamId: crypto.randomUUID(),
      editPathHolderByPath: new Map(),
      editPathQueueByPath: new Map(),
      pendingInteractionQueries: new Map(),
      interactionQueryId: 0,
    }
  }

  /**
   * Fresh Cursor sessions import only typed `conversation_history`. The
   * current action's prepend/current user fields belong to the real graph
   * turn and are appended by CursorConnectStream after it opens that turn.
   */
  private projectFreshCursorHistoryMessages(
    initialRequest?: ParsedCursorRequest
  ): SessionMessage[] {
    const wire = initialRequest?.cursorWire
    if (!getCursorUserMessageAction(wire)) {
      return []
    }
    const wireFrameRef = initialRequest?.cursorWireFrameRef
    if (!wireFrameRef) {
      throw new Error(
        "Fresh Cursor history cannot seed the durable graph before its inbound wire frame is stored"
      )
    }
    const projection = projectCursorFreshHistoryBootstrap({
      history: wire?.userMessageActionHistory ?? [],
      conversationState: wire?.conversationState,
      wireFrameRef,
    })
    const seedTime = Date.now()
    return projection.messages.map((message, index) =>
      this.makeFreshSessionMessage(
        message.role,
        message.content,
        seedTime + index,
        message.metadata
      )
    )
  }

  /**
   * A control-first attachment can create an empty local session before its
   * first real UserMessageAction arrives. Seed only the still-empty durable
   * graph once; never replace a graph from an inbound history envelope.
   */
  private persistDeferredCursorHistoryBootstrap(
    conversationId: string,
    session: SessionLifecycleRecord,
    context: ContextStateRecord,
    initialRequest?: ParsedCursorRequest
  ): PreparedInitialGraphProjection | undefined {
    if (
      context.mainProjection.messages.length > 0 ||
      context.mainProjection.generation !== 0
    ) {
      return undefined
    }
    this.assertEmptyInitialGraphProjection(
      context,
      "persistDeferredCursorHistoryBootstrap"
    )

    const messages = this.projectFreshCursorHistoryMessages(initialRequest)
    const cid = ConversationId.of(conversationId)
    if (messages.length === 0) {
      if (this.messageStore.hasMessages(cid)) {
        throw new Error(
          `persistDeferredCursorHistoryBootstrap: persisted graph exists but active projection is empty for ${conversationId}`
        )
      }
      return undefined
    }

    return this.messageStore.runInTransaction(cid, (txn) => {
      const acceptedMessages =
        this.persistInitialTranscriptMessagesInTransaction(txn, messages)
      if (acceptedMessages.length === 0) {
        throw new Error(
          `persistDeferredCursorHistoryBootstrap: failed to persist typed Cursor history for ${conversationId}`
        )
      }
      const prepared = this.prepareDetachedInitialGraphProjection(
        context,
        acceptedMessages
      )
      this.persistSessionSnapshotInTransaction(txn, session, {
        ...context,
        mainProjection: {
          ...context.mainProjection,
          ...prepared,
        },
      })
      return prepared
    })
  }

  private createDetachedFreshSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): FreshSessionBootstrap {
    const initialUsedContextTokens = requireOptionalNonNegativeSafeInteger(
      initialRequest?.usedContextTokens,
      "initial request usedContextTokens"
    )
    assertContextTokenLimitProvenance({
      contextTokenLimit: initialRequest?.contextTokenLimit,
      contextTokenLimitSource: initialRequest?.contextTokenLimitSource,
    })
    const initialWorkspace = resolveSessionWorkspaceRefresh({
      current: undefined,
      request: initialRequest,
      refreshScope: resolveSessionRequestRefreshScope(initialRequest),
    })
    const initialHistory =
      this.projectFreshCursorHistoryMessages(initialRequest)

    // The three records are constructed together but remain detached until
    // the complete durable bootstrap transaction has committed.
    const lifecycleRecord: SessionLifecycleRecord = {
      conversationId,
      model: initialRequest?.model || "claude-sonnet-4.5",
      codexProviderIdentity: createCodexRootProviderIdentity(),
      lastAssistantBackend: undefined,
      subagentModelOverrides:
        initialRequest?.subagentModelOverrides ??
        EMPTY_SUBAGENT_MODEL_OVERRIDES,
      selectedSubagentModels:
        initialRequest?.selectedSubagentModels ??
        EMPTY_SELECTED_SUBAGENT_MODELS,
      lastAssistantModel: undefined,
      lastToolUseSummary: undefined,
      thinkingLevel:
        initialRequest?.thinkingLevel === undefined
          ? 0
          : requireThinkingLevel(
              initialRequest.thinkingLevel,
              "initial request thinkingLevel"
            ),
      thinkingDetailsRequested:
        initialRequest?.thinkingDetailsRequested === true,
      isAgentic: initialRequest?.isAgentic || false,
      supportedTools: freezeCacheKeyArray(initialRequest?.supportedTools, []),
      discoveredTools: new Set<string>(),
      deferredToolCatalog: undefined,
      preparedToolBuild: undefined,
      mcpToolDefs: freezeCacheKeyArray(initialRequest?.mcpToolDefs),
      browserContext: undefined,
      useWeb: initialRequest?.useWeb || false,
      requestContextEnv: initialRequest?.requestContextEnv,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      workspace: initialWorkspace.workspace,
      cursorManagedReadResources:
        initialRequest?.cursorManagedReadResources ?? Object.freeze([]),
      codeChunks: initialRequest?.codeChunks,
      cursorRules: initialRequest?.cursorRules,
      skillOptions: initialRequest?.skillOptions,
      selectedCursorRulePaths: initialRequest?.selectedCursorRulePaths,
      selectedCursorRuleNames: initialRequest?.selectedCursorRuleNames,
      activeCursorSkillNames: [],
      cursorCommands: initialRequest?.cursorCommands,
      customSystemPrompt: initialRequest?.customSystemPrompt,
      hooksAdditionalContext: initialRequest?.hooksAdditionalContext,
      goalState: initialRequest?.goalState,
      isRootProjectConversation: initialRequest?.isRootProjectConversation,
      explicitContext: initialRequest?.explicitContext,
      contextTokenLimit: initialRequest?.contextTokenLimit,
      contextTokenLimitSource: initialRequest?.contextTokenLimitSource,
      contextMaxMode: initialRequest?.contextMaxMode,
      usedContextTokens: initialUsedContextTokens,
      requestedMaxOutputTokens: initialRequest?.requestedMaxOutputTokens,
      requestedModelParameters: initialRequest?.requestedModelParameters,
      hookConfiguredSteps: Object.freeze([
        ...(initialRequest?.hookConfiguredSteps ?? []),
      ]),
      configuredWorkspaceGrantsLoadedForPrimary: undefined,
      deferredControlContinuations: [],
    }

    const contextRecord: ContextStateRecord = {
      mainProjection: {
        owner: createMainProjectionOwner(ConversationId.of(conversationId)),
        messages: [],
        generation: 0,
        messageRecords: [],
        transcriptEvents: [],
        nextTranscriptEventSeq: 1,
        contextState: this.createContextState([]),
        usedTokens: initialUsedContextTokens ?? 0,
      },
      childProjections: new Map(),
      taskBudgetState: undefined,
      topLevelAgentTurnState: this.createEmptyTopLevelAgentTurnState(),
      readPaths: new Set(),
      readSnapshots: [],
      fileStates: new Map(),
      toolMetrics: this.createEmptyToolMetrics(),
      messageBlobIds: [],
      turns: [],
      currentAssistantMessage: undefined,
      stepId: 0,
      execId: 1,
      pendingRequestContextLedger: undefined,
      todos: [],
    }

    const streamRecord: SessionStreamRecord = {
      pendingToolCallByExecId: new Map(),
      retiredToolCallByExecId: new Map(),
      currentStreamId: crypto.randomUUID(),
      editPathHolderByPath: new Map(),
      editPathQueueByPath: new Map(),
      pendingInteractionQueries: new Map(),
      interactionQueryId: 0,
    }

    return {
      session: lifecycleRecord,
      context: contextRecord,
      stream: streamRecord,
      initialHistory,
    }
  }

  private assertSessionMountSlotAvailable(conversationId: string): void {
    const cid = ConversationId.of(conversationId)
    if (
      this.sessions.has(conversationId) ||
      this.contextState.getContextRecord(conversationId) ||
      this.sessionStream.getStreamRecord(conversationId) ||
      this.pendingByConversation.has(cid) ||
      this.pendingByTurn.has(cid)
    ) {
      throw new Error(
        `Cannot mount session ${conversationId}: a live record or pending index already exists`
      )
    }
  }

  /**
   * Commit the parent row, imported transcript graph, first projection, and
   * mutable domain snapshot as one SQLite transaction. Nothing is mounted
   * until this returns successfully.
   */
  private persistFreshSessionBootstrap(bootstrap: FreshSessionBootstrap): void {
    const { session, context, initialHistory } = bootstrap
    const conversationId = session.conversationId
    const cid = ConversationId.of(conversationId)
    this.assertSessionMountSlotAvailable(conversationId)

    this.messageStore.runInTransaction(cid, (txn) => {
      // The graph has a foreign key to sessions, so its parent row must be
      // accepted first but remains rollback-bound to the rest of bootstrap.
      this.sessionPersistence.upsertSessionInTransaction(
        txn,
        this.createSessionRow(session)
      )
      const acceptedMessages =
        this.persistInitialTranscriptMessagesInTransaction(txn, initialHistory)
      if (initialHistory.length > 0 && acceptedMessages.length === 0) {
        throw new Error(
          `Cannot bootstrap fresh session ${conversationId}: initial Cursor history was not accepted into the durable graph`
        )
      }

      context.mainProjection = {
        ...context.mainProjection,
        ...this.prepareDetachedInitialGraphProjection(
          context,
          acceptedMessages
        ),
      }
      this.sessionPersistence.replaceDomainStateInTransaction(
        txn,
        this.createSessionPersistenceSnapshot(session, context)
      )
    })
  }

  /** Publish every live owner together; a failed publication leaves none. */
  private publishDetachedSession(
    bundle: Pick<RestoredSessionBundle, "session" | "context" | "stream">,
    pending: readonly PendingToolEntry<PendingToolCall>[] = []
  ): SessionRecord {
    const { session, context, stream } = bundle
    const conversationId = session.conversationId
    const cid = ConversationId.of(conversationId)
    this.assertSessionMountSlotAvailable(conversationId)

    try {
      this.contextState.createInitialRecord(conversationId, context)
      this.sessionStream.createInitialRecord(conversationId, stream)
      this.sessions.set(conversationId, session)
      for (const entry of pending) {
        this.pendingToolRegister(entry)
      }
    } catch (error) {
      this.pendingByConversation.delete(cid)
      this.pendingByTurn.delete(cid)
      this.sessions.delete(conversationId)
      this.contextState.deleteRecord(conversationId)
      this.sessionStream.deleteRecord(conversationId)
      throw error
    }

    return session
  }

  /**
   * Touch session activity timestamp to keep long-lived tool/interaction turns alive.
   */
  touchSession(conversationId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    session.lastActivityAt = new Date()
    return true
  }

  /**
   * Emit an advisory log when a session has no MCP tool definitions attached.
   * `mcp_*` user-facing tools (`mcp_tool` / `list_mcp_resources` /
   * `read_mcp_resource` / `mcp_auth`) all rely on at least one MCP server being
   * configured upstream by the Cursor / Claude Code client. When none are
   * declared, those tools will reliably return `unavailable` — so we surface
   * a one-shot debug hint pointing at the user's MCP config rather than
   * leaving smoke / regression runs to silently misdiagnose this as a bridge
   * failure. The log is per-session-state, so it never spams.
   */
  private mcpAdvisoryEmitted = new WeakSet<SessionRecord>()
  private logMcpAdvisoryIfMissing(
    session: SessionRecord,
    reason: "fresh_session" | "session_reuse"
  ): void {
    const defs = session.mcpToolDefs
    if (Array.isArray(defs) && defs.length > 0) {
      // Definitions present — drop any earlier advisory so a future
      // configuration-removed transition can re-log.
      this.mcpAdvisoryEmitted.delete(session)
      return
    }
    if (this.mcpAdvisoryEmitted.has(session)) return
    this.mcpAdvisoryEmitted.add(session)
    this.logger.warn(
      `[mcp-advisory] conversation=${session.conversationId} ` +
        `reason=${reason}: no MCP servers declared by client; ` +
        "mcp_tool / list_mcp_resources / read_mcp_resource / mcp_auth will " +
        "return unavailable. Configure MCP servers in the Cursor / Claude " +
        "Code client (e.g. ~/.cursor/mcp.json) to enable them."
    )
  }

  markSessionDirty(conversationId: string): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return true
  }

  /**
   * Derive one request refresh without mutating the mounted session. A
   * control-first history import persists these candidates with its graph;
   * every other request publishes them directly and schedules the normal
   * snapshot write.
   */
  private prepareSessionRequestRefresh(
    session: SessionLifecycleRecord,
    context: ContextStateRecord,
    initialRequest?: ParsedCursorRequest
  ): PreparedSessionRequestRefresh {
    const incomingThinkingLevel =
      initialRequest?.thinkingLevel === undefined
        ? undefined
        : requireThinkingLevel(
            initialRequest.thinkingLevel,
            "request refresh thinkingLevel"
          )
    const incomingUsedContextTokens = requireOptionalNonNegativeSafeInteger(
      initialRequest?.usedContextTokens,
      "request refresh usedContextTokens"
    )
    const preparedSession: SessionLifecycleRecord = { ...session }
    const preparedContext: ContextStateRecord = {
      ...context,
      mainProjection: {
        ...context.mainProjection,
        contextState: structuredClone(context.mainProjection.contextState),
      },
    }
    const refreshScope = resolveSessionRequestRefreshScope(initialRequest)
    const canRefreshProvidedFields = refreshScope !== "control"
    const canClearRequestScopedFields =
      canClearSessionRequestScopedFields(initialRequest)
    const matchedResumeReferences = matchResumeWorkspaceReferences(
      session.workspace,
      initialRequest?.resumeWorkspaceReferences
    )
    if (
      initialRequest?.resumeWorkspaceReferences &&
      initialRequest.resumeWorkspaceReferences.length !==
        matchedResumeReferences.length
    ) {
      this.logger.debug(
        `Ignored ${initialRequest.resumeWorkspaceReferences.length - matchedResumeReferences.length} resume workspace reference(s) outside the already-bound IDE root set`
      )
    }
    const workspaceRefresh = resolveSessionWorkspaceRefresh({
      current: session.workspace,
      request: initialRequest,
      refreshScope,
    })
    preparedSession.workspace = workspaceRefresh.workspace
    preparedSession.cursorManagedReadResources =
      resolveSessionManagedReadResourcesRefresh({
        current: session.cursorManagedReadResources,
        request: initialRequest,
      })
    if (
      workspaceRefresh.reloadConfiguredWorkspaceGrants ||
      !workspaceRefresh.workspace
    ) {
      preparedSession.configuredWorkspaceGrantsLoadedForPrimary = undefined
    }
    const contextWindowTransition = resolveSessionContextWindowTransition({
      current: {
        model: session.model,
        contextTokenLimit: session.contextTokenLimit,
        contextTokenLimitSource: session.contextTokenLimitSource,
        contextMaxMode: session.contextMaxMode,
      },
      incoming: {
        model: initialRequest?.model,
        contextTokenLimit: initialRequest?.contextTokenLimit,
        contextTokenLimitSource: initialRequest?.contextTokenLimitSource,
        contextMaxMode: initialRequest?.contextMaxMode,
      },
      canRefreshProvidedFields,
      canClearRequestScopedFields,
    })

    preparedSession.lastActivityAt = new Date()
    preparedSession.model = contextWindowTransition.model
    preparedSession.contextTokenLimit =
      contextWindowTransition.contextTokenLimit
    preparedSession.contextTokenLimitSource =
      contextWindowTransition.contextTokenLimitSource
    preparedSession.contextMaxMode = contextWindowTransition.contextMaxMode
    if (contextWindowTransition.modelChanged) {
      preparedContext.mainProjection = {
        ...preparedContext.mainProjection,
        usedTokens: 0,
      }
      preparedContext.pendingRequestContextLedger = undefined
      preparedContext.mainProjection.contextState = {
        ...context.mainProjection.contextState,
        usageLedger: {},
      }
    }

    if (canClearRequestScopedFields && initialRequest) {
      preparedSession.subagentModelOverrides =
        initialRequest.subagentModelOverrides ?? EMPTY_SUBAGENT_MODEL_OVERRIDES
    } else if (
      canRefreshProvidedFields &&
      initialRequest?.subagentModelOverrides
    ) {
      preparedSession.subagentModelOverrides =
        initialRequest.subagentModelOverrides
    }
    if (canClearRequestScopedFields && initialRequest) {
      preparedSession.selectedSubagentModels =
        initialRequest.selectedSubagentModels ?? EMPTY_SELECTED_SUBAGENT_MODELS
    } else if (
      canRefreshProvidedFields &&
      initialRequest?.selectedSubagentModels
    ) {
      preparedSession.selectedSubagentModels =
        initialRequest.selectedSubagentModels
    }
    if (canClearRequestScopedFields && incomingThinkingLevel !== undefined) {
      preparedSession.thinkingLevel = incomingThinkingLevel
    }
    if (
      canClearRequestScopedFields &&
      initialRequest?.thinkingDetailsRequested !== undefined
    ) {
      preparedSession.thinkingDetailsRequested =
        initialRequest.thinkingDetailsRequested === true
    }
    if (canClearRequestScopedFields && initialRequest?.supportedTools) {
      preparedSession.supportedTools = freezeCacheKeyArray(
        initialRequest.supportedTools,
        []
      )
    } else if (
      canRefreshProvidedFields &&
      (initialRequest?.supportedTools?.length ?? 0) > 0
    ) {
      preparedSession.supportedTools = freezeCacheKeyArray(
        Array.from(
          new Set([
            ...session.supportedTools,
            ...(initialRequest?.supportedTools ?? []),
          ])
        ),
        []
      )
    }
    if (canClearRequestScopedFields && initialRequest) {
      preparedSession.mcpToolDefs =
        initialRequest.mcpToolDefs !== undefined
          ? freezeCacheKeyArray(initialRequest.mcpToolDefs)
          : undefined
    } else if (
      canRefreshProvidedFields &&
      initialRequest?.mcpToolDefs !== undefined
    ) {
      preparedSession.mcpToolDefs = freezeCacheKeyArray(
        initialRequest.mcpToolDefs
      )
    }
    if (canClearRequestScopedFields && initialRequest?.useWeb !== undefined) {
      preparedSession.useWeb = initialRequest.useWeb
    } else if (canRefreshProvidedFields && initialRequest?.useWeb === true) {
      preparedSession.useWeb = true
    }
    if (canClearRequestScopedFields && initialRequest) {
      preparedSession.requestContextEnv = initialRequest.requestContextEnv
    } else if (canRefreshProvidedFields) {
      if (initialRequest?.requestContextEnv) {
        preparedSession.requestContextEnv = initialRequest.requestContextEnv
      }
    }
    if (canClearRequestScopedFields && initialRequest) {
      preparedSession.cursorRules = initialRequest.cursorRules
      preparedSession.skillOptions = initialRequest.skillOptions
      preparedSession.selectedCursorRulePaths =
        initialRequest.selectedCursorRulePaths
      preparedSession.selectedCursorRuleNames =
        initialRequest.selectedCursorRuleNames
    } else if (canRefreshProvidedFields) {
      if (initialRequest?.cursorRules !== undefined) {
        preparedSession.cursorRules = initialRequest.cursorRules
      }
      if (initialRequest?.skillOptions !== undefined) {
        preparedSession.skillOptions = initialRequest.skillOptions
      }
      if (initialRequest?.selectedCursorRulePaths !== undefined) {
        preparedSession.selectedCursorRulePaths =
          initialRequest.selectedCursorRulePaths
      }
      if (initialRequest?.selectedCursorRuleNames !== undefined) {
        preparedSession.selectedCursorRuleNames =
          initialRequest.selectedCursorRuleNames
      }
    }
    if (canClearRequestScopedFields && initialRequest) {
      preparedSession.cursorCommands = initialRequest.cursorCommands
      preparedSession.customSystemPrompt = initialRequest.customSystemPrompt
      preparedSession.explicitContext = initialRequest.explicitContext
      preparedSession.requestedMaxOutputTokens =
        initialRequest.requestedMaxOutputTokens
      preparedSession.requestedModelParameters =
        initialRequest.requestedModelParameters
      preparedSession.hookConfiguredSteps = Object.freeze([
        ...(initialRequest.hookConfiguredSteps ?? []),
      ])
    } else if (canRefreshProvidedFields) {
      if (initialRequest?.cursorCommands !== undefined) {
        preparedSession.cursorCommands = initialRequest.cursorCommands
      }
      if (initialRequest?.customSystemPrompt !== undefined) {
        preparedSession.customSystemPrompt = initialRequest.customSystemPrompt
      }
      if (initialRequest?.explicitContext !== undefined) {
        preparedSession.explicitContext = initialRequest.explicitContext
      }
      if (initialRequest?.requestedMaxOutputTokens !== undefined) {
        preparedSession.requestedMaxOutputTokens =
          initialRequest.requestedMaxOutputTokens
      }
      if (initialRequest?.requestedModelParameters !== undefined) {
        preparedSession.requestedModelParameters =
          initialRequest.requestedModelParameters
      }
      if (initialRequest?.hookConfiguredSteps !== undefined) {
        preparedSession.hookConfiguredSteps = Object.freeze([
          ...initialRequest.hookConfiguredSteps,
        ])
      }
    }
    // SessionStart context lives for the Cursor composer session. A later
    // request may omit the field without revoking it; an explicitly present
    // empty string clears it.
    if (initialRequest?.hooksAdditionalContext !== undefined) {
      preparedSession.hooksAdditionalContext =
        initialRequest.hooksAdditionalContext
    }
    // Inbound ConversationStateStructure.goal_state is authoritative when the
    // client reattaches with an explicit goal record. Omitting the field keeps
    // the durable session projection.
    if (initialRequest?.goalState !== undefined) {
      preparedSession.goalState = initialRequest.goalState
    }
    // Same authority rule as goal_state: an explicit inbound flag wins;
    // omission keeps the durable session projection.
    if (initialRequest?.isRootProjectConversation !== undefined) {
      preparedSession.isRootProjectConversation =
        initialRequest.isRootProjectConversation
    }
    if (canRefreshProvidedFields && incomingUsedContextTokens !== undefined) {
      preparedSession.usedContextTokens = incomingUsedContextTokens
      preparedContext.mainProjection.usedTokens = incomingUsedContextTokens
    }

    return {
      session: preparedSession,
      context: preparedContext,
      canRefreshProvidedFields,
      resetUsageLedger: contextWindowTransition.modelChanged,
      reloadConfiguredWorkspaceGrants:
        workspaceRefresh.reloadConfiguredWorkspaceGrants,
    }
  }

  private applyPreparedSessionRequestRefresh(
    session: SessionLifecycleRecord,
    context: ContextStateRecord,
    prepared: PreparedSessionRequestRefresh
  ): void {
    Object.assign(session, prepared.session)
    context.mainProjection.usedTokens =
      prepared.context.mainProjection.usedTokens
    context.pendingRequestContextLedger =
      prepared.context.pendingRequestContextLedger
    if (prepared.resetUsageLedger) {
      context.mainProjection.contextState.usageLedger = {}
    }
  }

  /**
   * Create or get existing session
   */
  getOrCreateSession(
    conversationId: string,
    initialRequest?: ParsedCursorRequest
  ): SessionRecord {
    let session = this.getSession(conversationId)
    let persistedDuringCall = false

    if (!session) {
      const bootstrap = this.createDetachedFreshSession(
        conversationId,
        initialRequest
      )
      this.loadConfiguredWorkspaceGrants(bootstrap.session)
      this.persistFreshSessionBootstrap(bootstrap)
      persistedDuringCall = true
      session = this.publishDetachedSession(bootstrap)
      this.logMcpAdvisoryIfMissing(session, "fresh_session")
      this.logger.log(
        `>>> Created new session: ${conversationId} (model: ${session.model})`
      )
    } else {
      const ctx = this.contextState.getContextRecord(conversationId)!
      const preparedRefresh = this.prepareSessionRequestRefresh(
        session,
        ctx,
        initialRequest
      )
      const preparedProjection = this.persistDeferredCursorHistoryBootstrap(
        conversationId,
        preparedRefresh.session,
        preparedRefresh.context,
        initialRequest
      )

      // From this point forward every durable initialization fact is already
      // committed. Publishing is field assignment only; no relation is
      // re-read or inferred from live state.
      this.applyPreparedSessionRequestRefresh(session, ctx, preparedRefresh)
      if (preparedProjection) {
        ctx.mainProjection = {
          ...ctx.mainProjection,
          ...preparedProjection,
        }
        persistedDuringCall = true
      }
      if (preparedRefresh.canRefreshProvidedFields) {
        this.logMcpAdvisoryIfMissing(session, "session_reuse")
      }
      this.loadConfiguredWorkspaceGrants(session)

      this.logger.log(
        `>>> Using existing session: ${conversationId} ` +
          `(messages=${ctx.mainProjection.messages.length}, records=${ctx.mainProjection.messageRecords.length}, blobIds=${ctx.messageBlobIds.length}, turns=${ctx.turns.length}, pending=${this.pendingToolCallCount(session.conversationId)})`
      )
    }

    if (!persistedDuringCall) {
      this.schedulePersist(conversationId)
    }
    return session
  }

  /**
   * Returns the active graph turn for a conversation. The turn supervisor
   * uses this to establish the happens-before edge before starting a
   * superseding turn.
   */
  getActiveGraphTurnId(conversationId: string): TurnId | undefined {
    return this.activeGraphTurns.get(conversationId)
  }

  /**
   * Open a durable-graph turn. Opening a turn never creates an in-memory
   * transcript staging area: each accepted fragment is appended directly by
   * ContextStateService and linked to this turn id.
   */
  beginGraphTurn(conversationId: string, turnId: TurnId): void {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(`beginGraphTurn: no session ${conversationId}`)
    }
    const activeTurnId = this.activeGraphTurns.get(conversationId)
    if (activeTurnId) {
      if (activeTurnId === turnId) {
        return
      }
      throw new Error(
        `beginGraphTurn: conversation ${conversationId} still has active ` +
          `turn ${activeTurnId} while opening ${turnId}; its terminal graph ` +
          `transaction did not finalize before the superseding turn began.`
      )
    }
    this.activeGraphTurns.set(conversationId, turnId)
  }

  /**
   * Commit a graph turn. All fragments were already durable when accepted;
   * completing the turn only releases ownership of the turn id.
   */
  commitGraphTurn(conversationId: string, turnId: TurnId): void {
    const activeTurnId = this.activeGraphTurns.get(conversationId)
    if (!activeTurnId) return
    if (activeTurnId !== turnId) {
      throw new Error(
        `commitGraphTurn: active turn belongs to ${activeTurnId} ` +
          `(given=${turnId}); terminal ordering is broken.`
      )
    }
    this.activeGraphTurns.delete(conversationId)
  }

  /**
   * Abort a graph turn without deleting accepted fragments. Durable tool-edge
   * termination and pending-runtime cleanup are owned by
   * TurnCleanupCoordinator after ContextState commits the abort transaction;
   * this method only releases the active graph-turn identity.
   */
  abortGraphTurn(conversationId: string, turnId: TurnId): void {
    const activeTurnId = this.activeGraphTurns.get(conversationId)
    if (!activeTurnId) return
    if (activeTurnId !== turnId) {
      throw new Error(
        `abortGraphTurn: active turn belongs to ${activeTurnId} ` +
          `(given=${turnId}); terminal ordering is broken.`
      )
    }
    this.activeGraphTurns.delete(conversationId)
  }

  addPendingToolCall(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolFamilyHint?: "mcp" | "edit" | "web_fetch",
    modelCallId: string = "",
    historyToolName?: string,
    historyToolInput?: Record<string, unknown>,
    codexToolCallType?: "function" | "custom" | "tool_search",
    // Optional caller-supplied turnId. When omitted the resolver
    // installed by CursorConnectStreamService is queried.
    _turnId?: TurnId,
    sidechainOwner?: SubagentSidechainToolOwner,
    skillActivationReceipts: readonly CursorSkillActivationReceipt[] = [],
    clientLifecycleSuppression?: PendingToolClientLifecycleSuppression,
    hookAdditionalContexts: readonly CursorHookAdditionalContextReceipt[] = []
  ): void {
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (session) {
      // For edit tools, beforeContent is captured later in the
      // read_result → writeArgs handshake (see CursorConnectStreamService
      // handleToolResult). The read_result payload carries the
      // client-reported pre-edit content of the file, which is the only
      // value that is consistent with the post-edit content emitted in the
      // subsequent write_result. Reading the bridge host's local fs here
      // would produce stale or wrong content in SSH remote-development
      // workflows (issue #5), so we leave beforeContent unset until the
      // protocol-supplied truth arrives.
      const beforeContent: string | undefined = undefined

      const payload: PendingToolCall = {
        toolCallId,
        toolName,
        toolInput,
        historyToolName,
        historyToolInput,
        codexToolCallType,
        ...(skillActivationReceipts.length > 0
          ? {
              skillActivationReceipts: skillActivationReceipts.map(
                (receipt) => ({ ...receipt })
              ),
            }
          : {}),
        ...(hookAdditionalContexts.length > 0
          ? {
              hookAdditionalContexts: hookAdditionalContexts.map((context) => ({
                ...context,
              })),
            }
          : {}),
        ...(clientLifecycleSuppression
          ? {
              clientLifecycleSuppression: {
                ...clientLifecycleSuppression,
              },
            }
          : {}),
        toolFamilyHint,
        modelCallId,
        startedEmitted: false,
        sentAt: new Date(),
        execIds: new Set(),
        beforeContent,
        streamId: stream.currentStreamId,
        executionStatus: "pending",
        executionOrder: this.assistantToolBatch.bumpToolExecutionOrderCounter(
          session.conversationId
        ),
        ...(sidechainOwner
          ? {
              sidechainOwner: {
                ...sidechainOwner,
                forkLineage: [...sidechainOwner.forkLineage],
              },
            }
          : {}),
      }
      const turnId =
        _turnId ?? this.resolveTurnIdForConversation(conversationId)
      if (!turnId) {
        throw new Error(
          `addPendingToolCall: no turnId resolvable for ${conversationId}`
        )
      }
      this.pendingToolRegister<PendingToolCall>({
        conversationId: ConversationId.of(conversationId),
        turnId,
        toolCallId,
        toolName,
        startedAt: Date.now(),
        payload,
      })
      session.lastActivityAt = new Date()
      this.logger.debug(
        `Added pending tool call: ${toolCallId} (${toolName}) for session ${conversationId}` +
          (sidechainOwner ? ` [subagent=${sidechainOwner.agentId}]` : "")
      )
      this.schedulePersist(conversationId)
    }
  }

  getPendingToolCallIds(conversationId: string): string[] {
    return this.listPendingToolCallIds(conversationId)
  }

  // The five assistant-tool-batch methods (startAssistantToolBatch,
  // addAssistantToolBatchTools, settleAssistantToolBatchTool,
  // hasUnsettledAssistantToolBatchForBackend,
  // claimAssistantToolBatchContinuation) live on
  // AssistantToolBatchService now. Callers inject and call that
  // service directly — no facade is preserved here on purpose.

  getPendingToolCallIdsByStream(
    conversationId: string,
    streamId: string
  ): string[] {
    const session = this.getSession(conversationId)
    if (!session || !streamId) return []

    const pendingIds: string[] = []
    for (const [toolCallId, pendingToolCall] of this.listPendingToolCallEntries(
      session.conversationId
    )) {
      if (pendingToolCall.streamId === streamId) {
        pendingIds.push(toolCallId)
      }
    }
    return pendingIds
  }

  /**
   * Get and remove pending tool call
   */
  private detachPendingToolCall(
    session: SessionRecord,
    toolCallId: string
  ): PendingToolCall | undefined {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    const toolCall = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!toolCall) {
      return undefined
    }

    for (const execId of toolCall.execIds) {
      this.markRetiredToolExecId(stream, execId, toolCall)
      stream.pendingToolCallByExecId.delete(execId)
    }
    for (const [execId, mappedToolCallId] of stream.pendingToolCallByExecId) {
      if (mappedToolCallId === toolCallId) {
        this.markRetiredToolExecId(stream, execId, toolCall)
        stream.pendingToolCallByExecId.delete(execId)
      }
    }
    this.resolvePendingToolCallEntry(session.conversationId, toolCallId)
    // Phase H7a: view.delete() auto-resolves in the store mirror.
    session.lastActivityAt = new Date()

    // 释放 path-level edit serialization slot（若该工具是 edit_file_v2）。
    // detach 出口统一处理，覆盖 consume / clear / 异常路径，避免后续同 path
    // edit 永久阻塞。注意：detach 自身不会派发下一个 readArgs —— 该动作只
    // 应在"成功 consume"路径触发，避免在死流上把 queue 里的 edit 也带飞。
    this.clearEditPathSlot(session, toolCall)

    return toolCall
  }

  private markRetiredToolExecId(
    stream: SessionStreamRecord,
    execId: number,
    toolCall: PendingToolCall
  ): void {
    if (!Number.isFinite(execId) || execId <= 0) return
    const now = Date.now()
    stream.retiredToolCallByExecId.set(Math.floor(execId), {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      retiredAt: now,
    })
    this.pruneRetiredToolExecIds(stream, now)
  }

  private pruneRetiredToolExecIds(
    stream: SessionStreamRecord,
    now = Date.now()
  ): void {
    const cutoff = now - this.RETIRED_EXEC_ID_TTL_MS
    for (const [execId, retired] of stream.retiredToolCallByExecId) {
      if (retired.retiredAt < cutoff) {
        stream.retiredToolCallByExecId.delete(execId)
      }
    }
    while (
      stream.retiredToolCallByExecId.size > this.MAX_RETIRED_EXEC_ID_MAPPINGS
    ) {
      const oldestExecId = stream.retiredToolCallByExecId.keys().next().value
      if (oldestExecId === undefined) break
      stream.retiredToolCallByExecId.delete(oldestExecId)
    }
  }

  /**
   * 释放某个 toolCallId 对 path 串行槽的占用，并把它从所有等待队列中剥离。
   *
   * 由 detachPendingToolCall 在出口调用，覆盖 consume / clear / 异常 三类路径。
   */
  private clearEditPathSlot(
    session: SessionRecord,
    toolCall: PendingToolCall
  ): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    const path = toolCall.editPath
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\u0000")
    ) {
      // 即使没有 editPath，也把 toolCallId 从所有 queue 中扫一遍以防遗漏。
      // edit_file_v2 一定有 path，这里只是兜底。
      this.removeToolCallFromAllEditQueues(session, toolCall.toolCallId)
      return
    }

    const holder = stream.editPathHolderByPath.get(path)
    if (holder === toolCall.toolCallId) {
      stream.editPathHolderByPath.delete(path)
    }

    const queue = stream.editPathQueueByPath.get(path)
    if (queue) {
      const filtered = queue.filter(
        (item) => item.toolCallId !== toolCall.toolCallId
      )
      if (filtered.length === 0) {
        stream.editPathQueueByPath.delete(path)
      } else if (filtered.length !== queue.length) {
        stream.editPathQueueByPath.set(path, filtered)
      }
    }
  }

  private removeToolCallFromAllEditQueues(
    session: SessionRecord,
    toolCallId: string
  ): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    for (const [path, queue] of stream.editPathQueueByPath) {
      const filtered = queue.filter((item) => item.toolCallId !== toolCallId)
      if (filtered.length === 0) {
        stream.editPathQueueByPath.delete(path)
      } else if (filtered.length !== queue.length) {
        stream.editPathQueueByPath.set(path, filtered)
      }
    }
    for (const [path, holderId] of stream.editPathHolderByPath) {
      if (holderId === toolCallId) {
        stream.editPathHolderByPath.delete(path)
      }
    }
  }

  /**
   * 批量清空所有 path 串行状态。仅用于 stale pending 整批回收场景
   * （旧 BiDi 流已关闭，pending 全部作废，holder 与 queue 都不再有意义）。
   */
  private clearAllEditPathSlots(session: SessionRecord): void {
    const stream = this.sessionStream.getStreamRecord(session.conversationId)!
    stream.editPathHolderByPath.clear()
    stream.editPathQueueByPath.clear()
  }

  consumePendingToolCall(
    conversationId: string,
    toolCallId: string
  ): PendingToolCall | undefined {
    const session = this.getSession(conversationId)
    if (session) {
      // Snapshot pending state before mutation so notifyIfBecameIdle
      // can see the non-idle → idle edge if this consume is the last
      // outstanding work item.
      const wasPending =
        this.pendingToolCallCount(conversationId) > 0 ||
        this.sessionStream.hasBlockingInteractionQueries(conversationId)
      const pendingEntry = this.pendingToolGet<PendingToolCall>(
        ConversationId.of(conversationId),
        toolCallId
      )
      const toolCall = this.detachPendingToolCall(session, toolCallId)
      if (toolCall) {
        // Result handlers append their durable graph fact before consuming the
        // pending entry. Therefore this settle transition means the result is
        // already available to the next provider request.
        const batch =
          this.assistantToolBatch.getActiveAssistantToolBatchSnapshot(
            conversationId
          )
        if (batch && batch.graphTurnId === pendingEntry?.turnId) {
          this.assistantToolBatch.settleAssistantToolBatchTool(
            conversationId,
            toolCallId,
            {
              topLevelTurnId: batch.topLevelTurnId,
              graphTurnId: batch.graphTurnId,
            }
          )
        }
        this.logger.debug(
          `Consumed tool call: ${toolCallId} for session ${conversationId}`
        )
        this.schedulePersist(conversationId)
        this.notifyIfBecameIdleAfter(session, wasPending)
        return toolCall
      }
    }
    return undefined
  }

  clearPendingToolCall(
    conversationId: string,
    toolCallId: string,
    reason?: string
  ): PendingToolCall | undefined {
    const session = this.getSession(conversationId)
    if (!session) return undefined

    // Snapshot before mutation (see consumePendingToolCall).
    const wasPending =
      this.pendingToolCallCount(conversationId) > 0 ||
      this.sessionStream.hasBlockingInteractionQueries(conversationId)

    const pendingEntry = this.pendingToolGet<PendingToolCall>(
      ConversationId.of(conversationId),
      toolCallId
    )
    const toolCall = this.detachPendingToolCall(session, toolCallId)
    if (!toolCall) return undefined

    // Settle this tool in the batch barrier (same as consumePendingToolCall).
    const batch =
      this.assistantToolBatch.getActiveAssistantToolBatchSnapshot(
        conversationId
      )
    if (batch && batch.graphTurnId === pendingEntry?.turnId) {
      this.assistantToolBatch.settleAssistantToolBatchTool(
        conversationId,
        toolCallId,
        {
          topLevelTurnId: batch.topLevelTurnId,
          graphTurnId: batch.graphTurnId,
        }
      )
    }

    const reasonSuffix = reason ? ` (${reason})` : ""
    this.logger.warn(
      `Cleared pending tool call: ${toolCallId} for session ${conversationId}${reasonSuffix}`
    )
    this.schedulePersist(conversationId)
    this.notifyIfBecameIdleAfter(session, wasPending)
    return toolCall
  }

  registerPendingToolExecId(
    conversationId: string,
    toolCallId: string,
    execIdNumber: number
  ): boolean {
    const exactConversationId = ConversationId.of(conversationId)
    const exactToolCallId = requireExactDurableIdentifier(
      toolCallId,
      "registerPendingToolExecId toolCallId"
    )
    const stream = this.sessionStream.getStreamRecord(exactConversationId)!
    const session = this.getSession(exactConversationId)
    if (!session) return false
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return false

    const pending = this.getPendingToolCall(
      session.conversationId,
      exactToolCallId
    )
    if (!pending) {
      this.logger.warn(
        `registerPendingToolExecId: pending tool call not found: ${exactToolCallId}`
      )
      return false
    }

    const normalizedExecId = Math.floor(execIdNumber)
    stream.pendingToolCallByExecId.set(normalizedExecId, exactToolCallId)
    pending.execIds.add(normalizedExecId)
    session.lastActivityAt = new Date()
    this.logger.debug(
      `Mapped execId=${normalizedExecId} -> toolCallId=${exactToolCallId} for session ${exactConversationId}`
    )
    this.schedulePersist(exactConversationId)
    return true
  }

  markPendingToolCallStarted(conversationId: string, toolCallId: string): void {
    const session = this.getSession(conversationId)
    if (!session) return
    const pending = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!pending) return
    session.lastActivityAt = new Date()
    pending.startedEmitted = true
    this.schedulePersist(conversationId)
  }

  updatePendingToolExecution(
    conversationId: string,
    toolCallId: string,
    update: {
      executionOwner?: ToolExecutionOwner
      executionStatus?: ToolExecutionStatus
      executionRecoveryReason?: ToolExecutionRecoveryReason
      executionOrder?: number
    }
  ): boolean {
    const session = this.getSession(conversationId)
    if (!session) return false
    const pending = this.getPendingToolCall(session.conversationId, toolCallId)
    if (!pending) return false

    if (update.executionOwner) {
      pending.executionOwner = update.executionOwner
    }
    if (update.executionStatus) {
      pending.executionStatus = update.executionStatus
    }
    if (update.executionRecoveryReason) {
      pending.executionRecoveryReason = update.executionRecoveryReason
    }
    if (
      typeof update.executionOrder === "number" &&
      Number.isFinite(update.executionOrder)
    ) {
      pending.executionOrder = Math.max(0, Math.floor(update.executionOrder))
    }
    session.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
    return true
  }

  getPendingToolCallIdByExecId(
    conversationId: string,
    execIdNumber: number
  ): string | undefined {
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (!session) return undefined
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return undefined
    return stream.pendingToolCallByExecId.get(Math.floor(execIdNumber))
  }

  getRetiredToolExecMapping(
    conversationId: string,
    execIdNumber: number
  ): RetiredToolExecMapping | undefined {
    const stream = this.sessionStream.getStreamRecord(conversationId)
    const session = this.getSession(conversationId)
    if (!stream || !session) return undefined
    if (!Number.isFinite(execIdNumber) || execIdNumber <= 0) return undefined
    this.pruneRetiredToolExecIds(stream)
    return stream.retiredToolCallByExecId.get(Math.floor(execIdNumber))
  }

  consumePendingToolCallByExecId(
    conversationId: string,
    execIdNumber: number
  ): PendingToolCall | undefined {
    const toolCallId = this.getPendingToolCallIdByExecId(
      conversationId,
      execIdNumber
    )
    if (!toolCallId) return undefined
    return this.consumePendingToolCall(conversationId, toolCallId)
  }

  /**
   * Clear all stale pending tool calls from a session.
   * Used when a new chat turn arrives on a fresh BiDi stream but old pending
   * tool calls from a previous (now-closed) stream are still lingering.
   * Returns the number of cleared entries.
   */
  clearStalePendingToolCalls(conversationId: string): number {
    const stream = this.sessionStream.getStreamRecord(conversationId)!
    const session = this.getSession(conversationId)
    if (!session || this.pendingToolCallCount(session.conversationId) === 0)
      return 0

    const count = this.pendingToolCallCount(session.conversationId)
    const clearedIds = this.listPendingToolCallIds(session.conversationId)
    for (const [, pendingToolCall] of this.listPendingToolCallEntries(
      session.conversationId
    )) {
      for (const execId of pendingToolCall.execIds) {
        this.markRetiredToolExecId(stream, execId, pendingToolCall)
      }
    }

    this.clearAllPendingToolCalls(session.conversationId)
    stream.pendingToolCallByExecId.clear()
    // Phase H7a: view.clear() auto-resolves all entries in the
    // store mirror.
    // Also clear the batch barrier — all pending tools are being discarded.
    this.assistantToolBatch.clearAssistantToolBatch(session.conversationId)
    // Drop every path-level edit serialization slot. The pending tool calls
    // tied to the old BiDi stream are gone, so the holders/queues that
    // referenced them must not survive into the next turn.
    this.clearAllEditPathSlots(session)
    session.lastActivityAt = new Date()

    this.logger.warn(
      `Cleared ${count} stale pending tool call(s) for session ${conversationId}: ${clearedIds.join(", ")}`
    )
    this.schedulePersist(conversationId)
    return count
  }

  /**
   * Returns the AbortSignal bound to the conversation's currently
   * active leaf turn (chat ParentTurn, foreground sub-agent, or the
   * bidi-umbrella when no chat turn is in flight). Callers capture
   * the signal at the start of the operation and pass it through
   * every await. When the supervisor cancels the leaf — supersede,
   * bidi-close, user-cancel, parent-cancel, shutdown — the signal
   * aborts and every still-listening await throws synchronously on
   * its next `throwIfAborted` or signal-aware fetch.
   *
   * Returns `undefined` when no turn is active for the conversation
   * (idle session, hydration before first attach, unit-test paths
   * that did not install the resolver). Callers in those situations
   * fall back to a fresh AbortController so their await chain can
   * still run, but without supersede semantics.
   */
  getCurrentTurnAbortSignal(conversationId: string): AbortSignal | undefined {
    return this.activeTurnSignalResolver?.(conversationId)
  }

  /**
   * Get session
   */
  getSession(conversationId: string): SessionLifecycleRecord | undefined {
    return (
      this.sessions.get(conversationId) ||
      this.loadPersistedSession(conversationId)
    )
  }

  searchConversations(
    query: string,
    limit: number
  ): {
    hits: Array<{
      conversationId: string
      title: string
      updatedAtMs: number
      snippet: string
    }>
    truncated: boolean
    partial: boolean
  } {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      throw new Error("Conversation search query is required")
    }

    const normalizedLimit = Math.min(Math.max(Math.floor(limit), 1), 50)
    const maxScannedSessions = 200
    const candidates = this.sessionPersistence.listSessions()
    const partial = candidates.length > maxScannedSessions
    const hits: Array<{
      conversationId: string
      title: string
      updatedAtMs: number
      snippet: string
    }> = []

    for (const candidate of candidates.slice(0, maxScannedSessions)) {
      const messages = this.messageStore.getMessages(candidate.conversationId)
      const searchableMessages = messages
        .filter((message) => !message.isMeta)
        .map((message) => ({
          role: message.role,
          text: extractText(message.content as LooseMessageContent).trim(),
        }))
        .filter((message) => message.text.length > 0)
      const searchableText = searchableMessages
        .map((message) => message.text)
        .join("\n")
      const matchIndex = searchableText.toLowerCase().indexOf(normalizedQuery)
      if (matchIndex < 0) continue

      const firstUserMessage = searchableMessages.find(
        (message) => message.role === "user"
      )?.text
      const titleSource = firstUserMessage || searchableMessages[0]?.text || ""
      const title = (titleSource.split(/\r?\n/, 1)[0] || "").slice(0, 120)
      const snippetStart = Math.max(0, matchIndex - 120)
      const snippetEnd = Math.min(
        searchableText.length,
        matchIndex + normalizedQuery.length + 180
      )
      hits.push({
        conversationId: candidate.conversationId,
        title,
        updatedAtMs: candidate.lastActivityAt,
        snippet: searchableText.slice(snippetStart, snippetEnd),
      })
      if (hits.length > normalizedLimit) break
    }

    return {
      hits: hits.slice(0, normalizedLimit),
      truncated: hits.length > normalizedLimit,
      partial,
    }
  }

  // ─── Lifecycle-domain field accessors ─────────────────────────
  // step 4 终结: caller 不再 `session.xxx`,通过这些 method 访问
  // SessionLifecycleFields 字段。physical record 仍是单 SessionRecord
  // 对象(performance: hot-path zero-copy reads), 但 accessor 是
  // single point of mutation.

  getModel(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.model
  }
  setModel(conversationId: string, model: string): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.model = model
    this.markSessionDirty(conversationId)
  }
  getSupportedTools(conversationId: string): string[] {
    return this.getSession(conversationId)?.supportedTools ?? []
  }
  setSupportedTools(conversationId: string, tools: string[]): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.supportedTools = tools
  }
  getMcpToolDefs(
    conversationId: string
  ): ParsedCursorRequest["mcpToolDefs"] | undefined {
    return this.getSession(conversationId)?.mcpToolDefs
  }
  setMcpToolDefs(
    conversationId: string,
    mcpToolDefs: ParsedCursorRequest["mcpToolDefs"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.mcpToolDefs = mcpToolDefs
  }
  getCursorRules(
    conversationId: string
  ): ParsedCursorRequest["cursorRules"] | undefined {
    return this.getSession(conversationId)?.cursorRules
  }
  setCursorRules(
    conversationId: string,
    rules: ParsedCursorRequest["cursorRules"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.cursorRules = rules
  }
  getSkillOptions(
    conversationId: string
  ): ParsedCursorRequest["skillOptions"] | undefined {
    return this.getSession(conversationId)?.skillOptions
  }
  setSkillOptions(
    conversationId: string,
    skillOptions: ParsedCursorRequest["skillOptions"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.skillOptions = skillOptions
  }
  getCustomSystemPrompt(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.customSystemPrompt
  }
  setCustomSystemPrompt(
    conversationId: string,
    prompt: string | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.customSystemPrompt = prompt
  }
  getRequestContextEnv(
    conversationId: string
  ): ParsedCursorRequest["requestContextEnv"] | undefined {
    return this.getSession(conversationId)?.requestContextEnv
  }
  setRequestContextEnv(
    conversationId: string,
    env: ParsedCursorRequest["requestContextEnv"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.requestContextEnv = env
  }
  getDiscoveredTools(conversationId: string): Set<string> {
    return this.getSession(conversationId)?.discoveredTools ?? new Set<never>()
  }
  addDiscoveredTool(conversationId: string, toolName: string): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.discoveredTools.add(toolName)
    this.markSessionDirty(conversationId)
  }
  getDeferredToolCatalog(
    conversationId: string
  ): DeferredToolDescriptor[] | undefined {
    return this.getSession(conversationId)?.deferredToolCatalog
  }
  setDeferredToolCatalog(
    conversationId: string,
    catalog: DeferredToolDescriptor[] | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.deferredToolCatalog = catalog
  }
  getPreparedToolBuild(
    conversationId: string
  ): SessionPreparedToolBuild | undefined {
    return this.getSession(conversationId)?.preparedToolBuild
  }
  setPreparedToolBuild(
    conversationId: string,
    build: SessionPreparedToolBuild | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.preparedToolBuild = build
  }
  getSubagentModelOverrides(conversationId: string): SubagentModelOverridesMap {
    return (
      this.getSession(conversationId)?.subagentModelOverrides ??
      EMPTY_SUBAGENT_MODEL_OVERRIDES
    )
  }
  setSubagentModelOverrides(
    conversationId: string,
    overrides: SubagentModelOverridesMap
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.subagentModelOverrides = overrides
  }
  getThinkingLevel(conversationId: string): CursorThinkingLevel {
    return this.getSession(conversationId)?.thinkingLevel ?? 0
  }
  setThinkingLevel(conversationId: string, level: CursorThinkingLevel): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.thinkingLevel = requireThinkingLevel(level, "setThinkingLevel")
  }
  getThinkingDetailsRequested(conversationId: string): boolean {
    return this.getSession(conversationId)?.thinkingDetailsRequested ?? false
  }
  setThinkingDetailsRequested(conversationId: string, value: boolean): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.thinkingDetailsRequested = value
  }
  getIsAgentic(conversationId: string): boolean {
    return this.getSession(conversationId)?.isAgentic ?? false
  }
  setIsAgentic(conversationId: string, value: boolean): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.isAgentic = value
  }
  getUseWeb(conversationId: string): boolean {
    return this.getSession(conversationId)?.useWeb ?? false
  }
  setUseWeb(conversationId: string, value: boolean): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.useWeb = value
  }
  getCreatedAt(conversationId: string): Date | undefined {
    return this.getSession(conversationId)?.createdAt
  }
  getLastActivityAt(conversationId: string): Date | undefined {
    return this.getSession(conversationId)?.lastActivityAt
  }
  touchLastActivityAt(conversationId: string): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.lastActivityAt = new Date()
  }
  getLastAssistantBackend(conversationId: string): BackendType | undefined {
    return this.getSession(conversationId)?.lastAssistantBackend
  }
  getLastAssistantModel(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.lastAssistantModel
  }
  getLastToolUseSummary(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.lastToolUseSummary
  }
  setLastToolUseSummary(
    conversationId: string,
    summary: string | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.lastToolUseSummary = summary
  }
  getDeferredControlContinuations(
    conversationId: string
  ): SessionRecord["deferredControlContinuations"] {
    return this.getSession(conversationId)?.deferredControlContinuations ?? []
  }
  enqueueDeferredControlContinuation(
    conversationId: string,
    entry: SessionRecord["deferredControlContinuations"][number]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.deferredControlContinuations.push(entry)
  }
  drainDeferredControlContinuations(
    conversationId: string
  ): SessionRecord["deferredControlContinuations"] {
    const s = this.getSession(conversationId)
    if (!s) return []
    const drained = [...s.deferredControlContinuations]
    s.deferredControlContinuations.length = 0
    return drained
  }
  takeDeferredControlContinuations(
    conversationId: string,
    predicate: (
      entry: SessionRecord["deferredControlContinuations"][number]
    ) => boolean
  ): SessionRecord["deferredControlContinuations"] {
    const session = this.getSession(conversationId)
    if (!session) return []
    const matched: SessionRecord["deferredControlContinuations"] = []
    const retained: SessionRecord["deferredControlContinuations"] = []
    for (const entry of session.deferredControlContinuations) {
      if (predicate(entry)) {
        matched.push(entry)
      } else {
        retained.push(entry)
      }
    }
    if (matched.length === 0) return matched
    session.deferredControlContinuations = retained
    this.touchLastActivityAt(conversationId)
    return matched
  }
  clearDeferredControlContinuations(
    conversationId: string,
    reason: string
  ): number {
    const s = this.getSession(conversationId)
    if (!s) return 0
    const count = s.deferredControlContinuations.length
    if (count === 0) return 0
    s.deferredControlContinuations.length = 0
    this.logger.warn(
      `Cleared ${count} deferred control continuation(s) for ${conversationId}: ${reason}`
    )
    this.schedulePersist(conversationId)
    return count
  }
  getRequestedMaxOutputTokens(conversationId: string): number | undefined {
    return this.getSession(conversationId)?.requestedMaxOutputTokens
  }
  setRequestedMaxOutputTokens(
    conversationId: string,
    value: number | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.requestedMaxOutputTokens = value
  }
  getRequestedModelParameters(
    conversationId: string
  ): Record<string, string> | undefined {
    return this.getSession(conversationId)?.requestedModelParameters
  }
  setRequestedModelParameters(
    conversationId: string,
    params: Record<string, string> | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.requestedModelParameters = params
  }
  getContextTokenLimit(conversationId: string): number | undefined {
    return this.getSession(conversationId)?.contextTokenLimit
  }
  setContextTokenLimit(
    conversationId: string,
    value: number | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.contextTokenLimit = value
  }
  getContextMaxMode(conversationId: string): boolean | undefined {
    return this.getSession(conversationId)?.contextMaxMode
  }
  setContextMaxMode(conversationId: string, value: boolean | undefined): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.contextMaxMode = value
  }
  getUsedContextTokens(conversationId: string): number | undefined {
    return this.getSession(conversationId)?.usedContextTokens
  }
  setUsedContextTokens(
    conversationId: string,
    value: number | undefined
  ): void {
    const normalized = requireOptionalNonNegativeSafeInteger(
      value,
      "setUsedContextTokens"
    )
    const s = this.getSession(conversationId)
    if (!s) return
    const context = this.contextState.getContextRecord(conversationId)
    if (!context) {
      throw new Error(
        `Cannot set used context tokens for ${conversationId}: context projection is not mounted`
      )
    }
    s.usedContextTokens = normalized
    context.mainProjection.usedTokens = normalized ?? 0
    s.lastActivityAt = new Date()
    this.schedulePersist(conversationId)
  }
  getActiveCursorSkillNames(conversationId: string): string[] | undefined {
    return this.getSession(conversationId)?.activeCursorSkillNames
  }
  setActiveCursorSkillNames(
    conversationId: string,
    names: string[] | undefined
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.activeCursorSkillNames = names
  }
  getCodeChunks(
    conversationId: string
  ): ParsedCursorRequest["codeChunks"] | undefined {
    return this.getSession(conversationId)?.codeChunks
  }
  setCodeChunks(
    conversationId: string,
    chunks: ParsedCursorRequest["codeChunks"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.codeChunks = chunks
  }
  getCursorCommands(
    conversationId: string
  ): ParsedCursorRequest["cursorCommands"] | undefined {
    return this.getSession(conversationId)?.cursorCommands
  }
  setCursorCommands(
    conversationId: string,
    commands: ParsedCursorRequest["cursorCommands"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.cursorCommands = commands
  }
  getSelectedCursorRulePaths(
    conversationId: string
  ): ParsedCursorRequest["selectedCursorRulePaths"] | undefined {
    return this.getSession(conversationId)?.selectedCursorRulePaths
  }
  setSelectedCursorRulePaths(
    conversationId: string,
    paths: ParsedCursorRequest["selectedCursorRulePaths"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.selectedCursorRulePaths = paths
  }
  getSelectedCursorRuleNames(
    conversationId: string
  ): ParsedCursorRequest["selectedCursorRuleNames"] | undefined {
    return this.getSession(conversationId)?.selectedCursorRuleNames
  }
  setSelectedCursorRuleNames(
    conversationId: string,
    names: ParsedCursorRequest["selectedCursorRuleNames"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.selectedCursorRuleNames = names
  }
  getExplicitContext(conversationId: string): string | undefined {
    return this.getSession(conversationId)?.explicitContext
  }
  setExplicitContext(conversationId: string, value: string | undefined): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.explicitContext = value
  }
  getBrowserContext(
    conversationId: string
  ): SessionRecord["browserContext"] | undefined {
    return this.getSession(conversationId)?.browserContext
  }
  setBrowserContext(
    conversationId: string,
    ctx: SessionRecord["browserContext"]
  ): void {
    const s = this.getSession(conversationId)
    if (!s) return
    s.browserContext = ctx
  }

  /**
   * Iterate every in-memory session. Public so SessionStreamService /
   * other domain services can run cross-session sweeps (overdue
   * deadlines, stale shell streams, async-ask followup rollup) without
   * reaching into the private sessions map.
   */
  iterateSessions(): IterableIterator<[string, SessionLifecycleRecord]> {
    return this.sessions.entries()
  }

  /**
   * Domain-typed record accessors. Each returns a view of the
   * physical session record narrowed to the domain that owns the
   * fields. Caller code that needs cross-domain reads must call the
   * accessor for each domain it touches, eliminating the legacy
   * `session.everything` anti-pattern at the type layer.
   */
  getLifecycleRecord(
    conversationId: string
  ): SessionLifecycleRecord | undefined {
    return this.getSession(conversationId)
  }
  getContextRecord(conversationId: string): ContextStateRecord | undefined {
    return this.contextState.getContextRecord(conversationId)
  }

  /**
   * Explicitly remount a child after a durable execution-lease handoff. This
   * is not a hot-state fallback: every field is reconstructed from the child
   * branch's durable graph, generic layout head and current head/lease
   * receipt before it replaces the stale mounted projection.
   */
  remountSubagentProjection(
    conversationId: string,
    branch: SubagentGraphBranch
  ): MountedContextProjection {
    const cid = ConversationId.of(conversationId)
    if (branch.conversationId !== cid) {
      throw new Error(
        `SessionLifecycleService.remountSubagentProjection: branch belongs to ` +
          `${branch.conversationId}, not ${conversationId}`
      )
    }
    if (!this.contextState.getContextRecord(conversationId)) {
      throw new Error(
        `SessionLifecycleService.remountSubagentProjection: context is not mounted ` +
          `conversation=${conversationId}`
      )
    }
    const owner = this.subagentBranches.createProjectionOwner(branch)
    const durableBranch = this.subagentBranches.readProjectionBranch(owner)
    assertSameProjectionOwner(
      owner,
      this.subagentBranches.createProjectionOwner(durableBranch),
      "SessionLifecycleService.remountSubagentProjection"
    )
    if (durableBranch.turnId !== branch.turnId) {
      throw new Error(
        `SessionLifecycleService.remountSubagentProjection: branch execution lease changed ` +
          `conversation=${conversationId} agentId=${branch.agentId}`
      )
    }
    const messages = this.contextState.getSubagentGraphMessages(
      conversationId,
      durableBranch
    )
    const messageRecords = messages.map((message) => {
      const createdAt = Date.parse(message.timestamp)
      return this.createTranscriptRecord(
        message,
        Number.isFinite(createdAt) ? createdAt : Date.now()
      )
    })
    const contextState = this.createContextState(messageRecords)
    const activeHead = this.contextProjectionHeads.get(owner)
    if (activeHead) {
      this.restoreContextProjectionFromStore(
        owner,
        contextState,
        messageRecords,
        [],
        activeHead
      )
    }
    this.restoreClaudeProjectionFromStore(
      owner,
      contextState,
      messageRecords,
      []
    )
    const events = this.rebuildTranscriptEventsFromRecords(messageRecords)
    const projection: MountedContextProjection = {
      owner,
      messages,
      generation: messages.length,
      messageRecords,
      transcriptEvents: events.events,
      nextTranscriptEventSeq: events.nextSeq,
      contextState,
      usedTokens: 0,
      branchSnapshot: this.subagentBranches.readProjectionBranchSnapshot(owner),
    }
    this.contextState.applyPreparedMountedProjectionInstall(
      this.contextState.prepareMountedProjectionInstall(
        conversationId,
        projection
      )
    )
    return projection
  }
  getStreamRecord(conversationId: string): SessionStreamRecord | undefined {
    return this.sessionStream.getStreamRecord(conversationId)
  }

  /**
   * List currently in-memory session ids along with a small bundle of
   * activity / token metadata so the dashboard can offer a "compact this
   * session" picker.  Persisted-but-not-loaded sessions are intentionally
   * skipped — bringing them into memory would happen anyway when the
   * dashboard issues a manual compaction request, and listing every
   * historical session would bloat the response.
   */
  listSessionSummaries(): Array<{
    conversationId: string
    model: string
    messageCount: number
    transcriptRecordCount: number
    activeCompactionId?: string
    compactionEpoch: number
    lastActivityAt: string
  }> {
    const summaries: Array<
      ReturnType<SessionLifecycleService["buildSessionSummary"]>
    > = []
    for (const [conversationId, session] of this.sessions) {
      summaries.push(this.buildSessionSummary(conversationId, session))
    }
    summaries.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime()
    )
    return summaries
  }

  private buildSessionSummary(
    conversationId: string,
    session: SessionRecord
  ): {
    conversationId: string
    model: string
    messageCount: number
    transcriptRecordCount: number
    activeCompactionId?: string
    compactionEpoch: number
    lastActivityAt: string
  } {
    const ctx = this.contextState.getContextRecord(session.conversationId)!
    return {
      conversationId,
      model: session.model || "",
      messageCount: ctx.mainProjection.messages.length,
      transcriptRecordCount: ctx.mainProjection.messageRecords.length,
      activeCompactionId: ctx.mainProjection.contextState.activeCompactionId,
      compactionEpoch: ctx.mainProjection.contextState.compactionEpoch ?? 0,
      lastActivityAt: session.lastActivityAt.toISOString(),
    }
  }

  /**
   * Delete session
   */
  deleteSession(conversationId: string): void {
    const session = this.sessions.get(conversationId)
    if (session) {
      const stream = this.sessionStream.getStreamRecord(session.conversationId)
      if (stream) stream.pendingInteractionQueries.clear()
      this.invokeSessionCleanupHandlers(conversationId, session)
    }
    this.clearScheduledPersist(conversationId)
    // Step 4 物理拆: fan-out 到三个 service 各自的 record map,否则
    // context/stream record 在 lifecycle delete 后泄漏。
    this.sessions.delete(conversationId)
    this.activeGraphTurns.delete(conversationId)
    this.contextState.deleteRecord(conversationId)
    this.sessionStream.deleteRecord(conversationId)
    this.deletePersistedSession(conversationId)
    this.deleteToolResultStorage(conversationId)
    this.logger.log(`Deleted session: ${conversationId}`)
  }

  clearAllSessionCaches(): ClearSessionCacheResult {
    const warnings: string[] = []
    const loadedSessionIds = Array.from(this.sessions.keys())

    // Refuse mid-flight: clearing while a turn runner is active would
    // tear down session / context / stream records under the running
    // request. The user sees a warning and the operation is a no-op.
    const busySessionIds = loadedSessionIds.filter((conversationId) => {
      const session = this.sessions.get(conversationId)
      return session ? this.isSessionBusy(conversationId, session) : false
    })

    if (busySessionIds.length > 0) {
      warnings.push(
        `Refused to clear cache because ${busySessionIds.length} active session(s) still have running or pending work.`
      )
      return {
        clearedLoadedSessions: 0,
        clearedPersistedSessions: 0,
        clearedToolResultDirs: 0,
        warnings,
      }
    }

    // 1. Drop every in-memory record in lifecycle / context-state /
    //    session-stream. We deliberately do not call `deleteSession`
    //    here because that fan-out also issues per-conversation SQL
    //    DELETEs and per-conversation rmSyncs, which is O(N²) when we
    //    are about to truncate everything anyway.
    let clearedLoadedSessions = 0
    for (const conversationId of loadedSessionIds) {
      const session = this.sessions.get(conversationId)
      if (session) {
        const stream = this.sessionStream.getStreamRecord(
          session.conversationId
        )
        if (stream) stream.pendingInteractionQueries.clear()
        this.invokeSessionCleanupHandlers(conversationId, session)
      }
      this.clearScheduledPersist(conversationId)
      this.sessions.delete(conversationId)
      this.activeGraphTurns.delete(conversationId)
      this.contextState.deleteRecord(conversationId)
      this.sessionStream.deleteRecord(conversationId)
      clearedLoadedSessions++
    }

    // 2. Truncate every conversation-owned table in the current graph schema
    //    through SessionPersistenceService. If the persistence layer is not
    //    ready yet (very early in boot), there is nothing on disk to clear.
    let clearedPersistedSessions = 0
    if (this.persistence.isReady) {
      try {
        const persistedTotal = this.sessionPersistence.deleteAllSessions()
        // The dashboard payload reports "persisted-only" sessions
        // separately, so subtract the in-memory set from the total.
        clearedPersistedSessions = Math.max(
          0,
          persistedTotal - clearedLoadedSessions
        )
      } catch (error) {
        this.logger.error(
          `Failed to truncate persisted session cache: ${String(error)}`
        )
        warnings.push(
          `Failed to fully clear persisted session cache: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    // 3. Remove every tool-result spool directory, including orphan
    //    directories whose conversation row no longer exists.
    let clearedToolResultDirs = 0
    try {
      clearedToolResultDirs = this.toolResultStorage.clearAll().clearedDirCount
    } catch (error) {
      this.logger.warn(
        `Failed to clear tool-results directory: ${String(error)}`
      )
      warnings.push(
        `Failed to clear tool-results directory: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.logger.log(
      `Cleared session caches (loaded=${clearedLoadedSessions} persisted=${clearedPersistedSessions} toolDirs=${clearedToolResultDirs})`
    )

    return {
      clearedLoadedSessions,
      clearedPersistedSessions,
      clearedToolResultDirs,
      warnings,
    }
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now()
    let cleanedCount = 0

    for (const [conversationId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt.getTime() <= this.SESSION_TIMEOUT) {
        continue
      }
      if (this.isSessionBusy(conversationId, session)) {
        this.logger.debug(
          `Skipping cleanup for active session ${conversationId}`
        )
        continue
      }

      this.clearScheduledPersist(conversationId)
      this.invokeSessionCleanupHandlers(conversationId, session)
      this.sessions.delete(conversationId)
      this.activeGraphTurns.delete(conversationId)
      this.contextState.deleteRecord(conversationId)
      this.sessionStream.deleteRecord(conversationId)
      cleanedCount++
    }

    if (cleanedCount > 0) {
      this.logger.log(`Cleaned up ${cleanedCount} expired session(s)`)
    }
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number
    activeSessions: number
    oldestSession: Date | null
  } {
    const now = Date.now()
    let activeSessions = 0
    let oldestSession: Date | null = null

    for (const session of this.sessions.values()) {
      if (
        now - session.lastActivityAt.getTime() <
        this.ACTIVE_SESSION_WINDOW_MS
      ) {
        activeSessions++
      }
      if (!oldestSession || session.createdAt < oldestSession) {
        oldestSession = session.createdAt
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      oldestSession,
    }
  }

  listPersistedSessionActivitySummaries(): PersistedSessionActivitySummary[] {
    if (!this.persistence.isReady) return []
    return this.sessionPersistence.listSessionActivitySummaries()
  }

  getAnalyticsSummary(limit = 12): ChatSessionAnalyticsSummary {
    const now = Date.now()
    const sessions = new Map<
      string,
      {
        session: SessionRecord
        context: ContextStateRecord
        loaded: boolean
      }
    >()

    for (const [conversationId, session] of this.sessions.entries()) {
      const context = this.contextState.getContextRecord(conversationId)
      if (!context) {
        this.logger.error(
          `Skipping analytics for ${conversationId}: mounted session has no ContextStateRecord`
        )
        continue
      }
      sessions.set(conversationId, { session, context, loaded: true })
    }

    if (this.persistence.isReady) {
      try {
        for (const summary of this.sessionPersistence.listSessions()) {
          const conversationId = summary.conversationId as string
          if (sessions.has(conversationId)) continue
          try {
            const row = this.sessionPersistence.loadSession(
              ConversationId.of(conversationId)
            )
            if (!row) continue
            const persisted = this.loadPersistedSessionState(
              row,
              this.loadPersistedGraph(row.conversationId),
              []
            )

            const restored = this.parsePersistedSession(persisted)
            sessions.set(conversationId, {
              session: restored.session,
              context: restored.context,
              loaded: false,
            })
          } catch (error) {
            this.logger.warn(
              `Failed to deserialize analytics session ${conversationId}: ${String(error)}`
            )
          }
        }
      } catch (error) {
        this.logger.warn(
          `Failed to load persisted session analytics: ${String(error)}`
        )
      }
    }

    const entries = Array.from(sessions.entries())
      .map(([conversationId, value]) =>
        this.buildAnalyticsEntry(
          conversationId,
          value.session,
          value.context,
          value.loaded,
          now
        )
      )
      .sort(
        (left, right) =>
          Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
      )

    let lastActivityAt: string | null = null
    let activeSessions = 0
    let loadedSessions = 0
    let pendingToolCalls = 0
    let completedToolCalls = 0
    let totalToolDurationMs = 0
    let readFiles = 0
    let editedFiles = 0
    let linesAdded = 0
    let linesRemoved = 0

    for (const entry of entries) {
      if (entry.active) activeSessions++
      if (entry.loaded) loadedSessions++
      pendingToolCalls += entry.pendingToolCalls
      completedToolCalls += entry.completedToolCalls
      totalToolDurationMs += entry.totalToolDurationMs
      readFiles += entry.readFiles
      editedFiles += entry.editedFiles
      linesAdded += entry.linesAdded
      linesRemoved += entry.linesRemoved
      if (
        !lastActivityAt ||
        Date.parse(entry.lastActivityAt) > Date.parse(lastActivityAt)
      ) {
        lastActivityAt = entry.lastActivityAt
      }
    }

    return {
      timestamp: new Date(now).toISOString(),
      totals: {
        totalSessions: entries.length,
        activeSessions,
        loadedSessions,
        persistedOnlySessions: Math.max(0, entries.length - loadedSessions),
        pendingToolCalls,
        completedToolCalls,
        totalToolDurationMs,
        avgToolDurationMs:
          completedToolCalls > 0
            ? Math.round((totalToolDurationMs / completedToolCalls) * 10) / 10
            : null,
        readFiles,
        editedFiles,
        linesAdded,
        linesRemoved,
        lastActivityAt,
      },
      sessions: entries.slice(0, Math.max(1, limit)),
    }
  }

  /**
   * Running child execution is a durable run state.  The process keeps no
   * parallel child-context registry: graph counters are projected directly
   * from the run's immutable branch.
   */
  private listRunningSubagentRuns(conversationId: string): SubagentRunRecord[] {
    return this.subagentRunStore
      .listInConversation(ConversationId.of(conversationId))
      .filter((run) => run.status === "running")
  }

  private deriveRunningSubagentMetrics(conversationId: string): {
    subAgentTurns: number
    subAgentToolCalls: number
  } {
    let subAgentTurns = 0
    let subAgentToolCalls = 0
    for (const run of this.listRunningSubagentRuns(conversationId)) {
      const metrics = deriveSubagentGraphExecutionMetrics(
        this.contextState.getSubagentGraphMessages(
          conversationId,
          subagentGraphBranchFromRun(run)
        )
      )
      subAgentTurns += metrics.turnCount
      subAgentToolCalls += metrics.toolCallCount
    }
    return { subAgentTurns, subAgentToolCalls }
  }

  /** Return the lifecycle's explicit workspace state, if this session has one. */
  getWorkspace(conversationId: string): SessionWorkspaceState | undefined {
    return this.getSession(conversationId)?.workspace
  }

  /** The durable scope snapshot exposed to REST diagnostics. */
  getWorkspaceScopeSnapshot(conversationId: string) {
    return this.getSession(conversationId)?.workspace?.scope.toFrozenSnapshot()
  }

  /** Every executable root with its authority source. */
  getWorkspaceRootSources(conversationId: string) {
    const workspace = this.getSession(conversationId)?.workspace
    return workspace ? describeWorkspaceRoots(workspace) : []
  }

  /**
   * Publish one successful CreatePlanResult as an exact read-only capability
   * before its tool result is returned to the model.
   */
  registerCursorManagedPlanReadResource(
    conversationId: string,
    toolCallId: string,
    planUri: string
  ): CursorManagedReadResource {
    const session = this.getSession(conversationId)
    if (!session) {
      throw new Error(
        `Cannot register Cursor plan resource for missing session ${conversationId}`
      )
    }
    const next = upsertCursorManagedPlanReadResource(
      session.cursorManagedReadResources,
      { id: toolCallId, path: planUri }
    )
    session.cursorManagedReadResources = next.resources
    this.markSessionDirty(conversationId)
    return next.resource
  }

  /**
   * Validate a REST grant batch off-record, then install one fresh immutable
   * Scope. A grant cannot establish a session workspace: the IDE declaration
   * must exist first.
   */
  addWorkspaceGrants(
    conversationId: string,
    rawPaths: readonly string[]
  ): readonly WorkspaceGrant[] | null {
    const session = this.getSession(conversationId)
    if (!session?.workspace) return null
    try {
      const result = applyWorkspaceGrantBatch(
        session.workspace,
        rawPaths,
        "session",
        Date.now()
      )
      session.workspace = result.state
      this.markSessionDirty(conversationId)
      return result.grants
    } catch (error) {
      if (error instanceof WorkspaceSessionStateError) return null
      throw error
    }
  }

  /** Validate and remove a grant batch in one immutable Scope replacement. */
  removeWorkspaceGrants(
    conversationId: string,
    rawPaths: readonly string[]
  ): readonly WorkspaceGrant[] | null {
    const session = this.getSession(conversationId)
    if (!session?.workspace) return null
    try {
      const result = removeWorkspaceGrantBatch(session.workspace, rawPaths)
      session.workspace = result.state
      if (result.removed.length > 0) this.markSessionDirty(conversationId)
      return result.removed
    } catch (error) {
      if (error instanceof WorkspaceSessionStateError) return null
      throw error
    }
  }

  /**
   * Load the exact `.cursor/agent-vibes.json` schema for the current primary
   * root. Config grants are first cleared so malformed or removed config
   * fails closed instead of retaining prior filesystem authority.
   */
  private loadConfiguredWorkspaceGrants(session: SessionRecord): void {
    const workspace = session.workspace
    if (!workspace) return
    const primaryRoot = workspace.scope.primaryRoot
    if (session.configuredWorkspaceGrantsLoadedForPrimary === primaryRoot) {
      return
    }

    // A reload starts from session grants only. This also removes persisted
    // config grants before a missing or malformed file can be observed.
    session.workspace = replaceConfiguredWorkspaceGrants(
      workspace,
      [],
      Date.now()
    )
    session.configuredWorkspaceGrantsLoadedForPrimary = primaryRoot

    const configPath = path.join(primaryRoot, ".cursor", "agent-vibes.json")
    if (!fs.existsSync(configPath)) return

    try {
      const configured = parseConfiguredWorkspaceGrantFile(
        JSON.parse(fs.readFileSync(configPath, "utf8"))
      )
      session.workspace = replaceConfiguredWorkspaceGrants(
        session.workspace,
        configured,
        Date.now()
      )
    } catch (error) {
      this.logger.warn(
        `Failed to load strict workspace config ${configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}
