import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common"
import * as fs from "fs"
import * as path from "path"
import {
  type ContextStateRecord,
  type MountedContextProjection,
  makeSessionMessage,
  projectPersistedMessageToSessionMessage,
  type MessageContent,
  type PendingToolCall,
  type SessionMessage,
  type SessionMessageInit,
  type SessionReadSnapshot,
  type SessionTodoItem,
  type SessionToolMetrics,
  type SessionTopLevelAgentTurnState,
  type SessionTranscriptEvent,
  SessionLifecycleService,
} from "./session-lifecycle.service"
import {
  applyTaskBudgetCompactionDeduction,
  type SessionTaskBudgetState,
  syncSessionTaskBudgetTotal,
  toTaskBudgetParam,
  type TaskBudgetParam,
} from "./task-budget-state"
import type {
  ContextConversationState,
  ContextToolResultReplacementMutation,
  ContextTranscriptRecord,
  ContextUsageLedgerState,
  ContextUsageSnapshot,
  ContentBlock,
  SessionMemorySourceKind,
} from "../../../context/types"
import {
  buildSubAgentMemorySourceEventId,
  createSubAgentCompletionArtifact,
} from "../../../context/sub-agent-memory-formatter"
import {
  assertContextUsageSnapshot,
  contextUsageInputTokenCount,
  requireNonNegativeSafeIntegerTokenCount,
} from "../../../context/context-usage-contract"
import type { BackendType } from "../../../llm/shared/model-router.service"
import { ConversationId, type TurnId } from "../turn/turn.types"
import { safeJsonStringify } from "../safe-json"
import {
  describeSessionFileStateLimit,
  getSessionFileStateSize,
  isSessionFileStateWithinLimit,
} from "./file-state-limits"
import { MessageStore, type PersistedMessage } from "./message-store.service"
import type { SubagentGraphBranch } from "./subagent-graph"
import {
  SubagentBranchStore,
  type SubagentBranchAppendPlan,
  type SubagentBranchWriteAuthority,
} from "./subagent-branch-store.service"
import { requireCanonicalSubagentCompletionArtifact } from "../subagents/subagent-completion-artifact"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import {
  assertProjectionOwner,
  assertSameProjectionOwner,
  createClaudeProjectionRefFromGraphProvider,
  createMainProjectionOwner,
  type ProjectionProvider,
  type ProjectionOwner,
  type SubagentProjectionBranchSnapshot,
  type SubagentProjectionOwner,
} from "./projection-owner"
import {
  STALE_SUBAGENT_RUN_INTERRUPTION_MESSAGE,
  SubagentRunStore,
  type CreateSubagentRunInput,
  type SubagentRunRecord,
  type TerminalizeSubagentRunInput,
} from "./subagent-run-store.service"
import {
  applyMessageRevisionProjection,
  ASYNC_TOOL_RESULT_RESOLUTION_REVISION,
  PROVIDER_PROJECTION_EXCLUSION_REVISION,
  TOOL_RESULT_STRUCTURED_CONTENT_REVISION,
} from "./message-revision-projection"
import {
  ToolCallLedger,
  type AbortReason,
  type SessionTxn,
  type ToolCallLedgerOrigin,
} from "./tool-call-ledger.service"
import { SessionMemoryEventStore } from "./session-memory-event-store.service"
import { ExecDispatchStore } from "./exec-dispatch-store.service"
import { ExecDispatchSerializerService } from "./exec-dispatch-serializer.service"
import type { CodexGraphResponseCommit } from "./codex-projection-store.service"
import {
  ClaudeProjectionMutationLog,
  type PersistedClaudeProjectionMutation,
} from "./claude-projection-mutation-log.service"
import type {
  SubagentTerminalDeliveryCommit,
  SubagentTerminalGraphCommit,
} from "../subagents/subagent-terminal-delivery"
import { decodeSubagentTerminalDeliveries } from "../subagents/subagent-terminal-delivery"
import {
  BackgroundCommandStore,
  type BackgroundShellCompletionIdentity,
} from "./background-command-store.service"
import {
  AsyncUserInteractionStore,
  type AcceptAsyncAskQuestionResolutionResult,
  type AsyncAskQuestionResolution,
  type OpenAsyncAskQuestionInput,
} from "./async-user-interaction-store.service"

export interface GraphAppendFragment {
  recordId: string
  messageSeq: number
}

export interface GraphAppendResult {
  fragments: readonly GraphAppendFragment[]
  /** Exact runtime projection prepared from the rows accepted by the txn. */
  projectedMessages: readonly SessionMessage[]
  /** Exact append-only Claude mutations committed beside their graph receipt. */
  claudeProjectionMutations: readonly PersistedClaudeProjectionMutation[]
}

interface PreparedMountedGraphProjection {
  mount: PreparedMountedProjectionInstall
  flushImmediately: boolean
}

/**
 * A mount transfer whose complete ownership and durable-branch validation
 * already succeeded. Applying it is intentionally only an in-memory map
 * assignment, so an accepted durable graph/projection commit cannot be
 * reported as failed by a later database read.
 */
export interface PreparedMountedProjectionInstall {
  readonly context: ContextStateRecord
  readonly projection: MountedContextProjection
}

/**
 * One exact client-exec terminal transition that must commit with the
 * corresponding tool_result graph edge and ledger close.
 */
export interface TerminalExecDispatchCommit {
  toolCallId: string
  streamEpoch: string
  execId: number
  protocolExecId: string
  disposition: "settled" | "cancelled"
  terminalReason: string
}

/**
 * A late client terminal for an inner sidechain exec whose provider worker
 * was interrupted by a bridge restart.  This is deliberately distinct from
 * a normal sub-agent append: the run is already terminal and this commit
 * must never make the provider loop runnable again.
 */
export interface RecoveredSubagentClientTerminalCommit {
  branch: SubagentGraphBranch
  toolCallId: string
  /** Exact assistant graph row that opened this inner tool edge. */
  sourceToolAssistantUuid: string
  terminalExecDispatch: TerminalExecDispatchCommit
  /** Durable protocol audit kept out of model-facing terminal content. */
  toolResultMetadata?: Record<string, unknown>
  /** Canonical terminal outcome; every child tool result carries the bit. */
  isError: boolean
}

/**
 * Receipt from the only cold-mount reconciliation boundary. The values are
 * durable transitions, not optimistic transport counters.
 */
export interface ColdSubagentRecoveryResult {
  interruptedRuns: number
  deliveredParentResults: number
  abortedUnwrittenSidechainToolCalls: number
  cancelledUnwrittenExecDispatches: number
  parkedSidechainClientTerminals: number
}

export interface AppendSubagentGraphMessageOptions {
  /** Stable logical provider identity, never a transport backend. */
  provider?: ProjectionProvider
  providerMessageId?: string
  isMeta?: boolean
  /** Commit this accepted child response into the same Codex graph boundary. */
  codexResponseCommit?: CodexGraphResponseCommit
  /** Versioned official Cursor presentation fact for each child result. */
  toolResultMetadata?: ReadonlyMap<string, Record<string, unknown> | undefined>
  terminalExecDispatches?: readonly TerminalExecDispatchCommit[]
  subagentTerminalCommits?: readonly SubagentTerminalGraphCommit[]
  /** Semantic Claude mutations keyed by the triggering tool_result id. */
  claudeProjectionMutations?: ReadonlyMap<
    string,
    readonly ContextToolResultReplacementMutation[]
  >
  /** Create this execution in the same transaction as its branch root. */
  subagentRunCreate?: CreateSubagentRunInput
}

/**
 * An assistant tool_use must be paired with one explicit ledger open in the
 * same graph transaction. The sub-agent-only writer derives this exact list
 * from its already-validated provider content and execution lease before it
 * enters the generic graph writer; generic callers must supply it themselves.
 */
interface AssistantLedgerOpen {
  toolUseId: string
  toolName: string
  turnId?: TurnId
  origin?: ToolCallLedgerOrigin
}

interface GraphAppendOptions {
  turnId?: TurnId
  ledgerOpens?: readonly AssistantLedgerOpen[]
  /**
   * Per-assistant-block graph turn identity. `Map.has(index)` is significant:
   * a present `undefined` retains the NULL turn used by imported history.
   */
  assistantBlockTurnIds?: ReadonlyMap<number, TurnId | undefined>
  /** Per-user-block identity with the same explicit-undefined contract. */
  userBlockTurnIds?: ReadonlyMap<number, TurnId | undefined>
  /** Per-result identity with the same explicit-undefined contract. */
  toolResultTurnIds?: ReadonlyMap<string, TurnId | undefined>
  /** Per-result durable metadata, kept out of model-facing content. */
  toolResultMetadata?: ReadonlyMap<string, Record<string, unknown> | undefined>
  /** Exact terminal state transitions coupled to appended tool results. */
  terminalExecDispatches?: readonly TerminalExecDispatchCommit[]
  /** Exact terminal run deliveries coupled to appended tool results. */
  subagentTerminalCommits?: readonly SubagentTerminalGraphCommit[]
  /** Exact terminal shell notifications coupled to the accepted user row. */
  backgroundShellTerminalDeliveries?: readonly BackgroundShellCompletionIdentity[]
  /**
   * Open queued ask lifecycles beside the exact async tool_result rows that
   * represent them. A later runtime transition is not an interaction source.
   */
  asyncUserInteractionOpens?: readonly Omit<
    OpenAsyncAskQuestionInput,
    "sourceMessageUuid"
  >[]
  /**
   * Claim a resolved interaction with the exact control-notification graph row
   * that will drive its provider continuation.
   */
  asyncUserInteractionContinuationClaim?: {
    readonly toolCallId: string
    readonly resolutionFingerprint: string
  }
  /** Semantic Claude mutations keyed by the triggering tool_result id. */
  claudeProjectionMutations?: ReadonlyMap<
    string,
    readonly ContextToolResultReplacementMutation[]
  >
  /**
   * A prepared Codex-native response transition. Its rollout, graph-source
   * bindings and active head commit in this exact graph transaction, then its
   * cache installs only after the transaction succeeds.
   */
  codexResponseCommit?: CodexGraphResponseCommit
}

/** Private capability used only by dedicated sub-agent write entry points. */
type DedicatedSidechainAppendAuthority =
  | {
      readonly kind: "root"
      readonly branch: SubagentGraphBranch
      readonly runCreate: CreateSubagentRunInput
    }
  | {
      readonly kind: "continuation"
      readonly branch: SubagentGraphBranch
    }
  | {
      readonly kind: "recovered"
      readonly commit: RecoveredSubagentClientTerminalCommit
    }

/**
 * Sole owner of the in-session context domain: transcript writes,
 * cursor turn state machine, task budget, read paths / snapshots,
 * file states, tool metrics, snip projection and per-session counters.
 *
 * ContextStateService owns the active graph projection and its contextual
 * state. Lifecycle owns only session metadata and persistence scheduling;
 * transcript-event helpers are accessed through that handle.
 *
 * forwardRef resolves the lifecycle/context callback cycle at construction.
 */
@Injectable()
export class ContextStateService {
  private readonly logger = new Logger(ContextStateService.name)

  // Context records are physically independent from lifecycle and stream
  // records; this map is their only in-memory owner.
  private readonly contextRecords = new Map<string, ContextStateRecord>()

  // Canonical retention limits for the context domain.
  private readonly MAX_READ_SNAPSHOTS_PER_FILE = 4
  private readonly MAX_READ_SNAPSHOTS_PER_SESSION = 64
  private readonly MAX_READ_SNAPSHOT_CHARS = 32_768

  constructor(
    @Inject(forwardRef(() => SessionLifecycleService))
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly messageStore: MessageStore,
    private readonly toolCallLedger: ToolCallLedger,
    private readonly sessionMemoryEvents: SessionMemoryEventStore,
    private readonly execDispatchStore: ExecDispatchStore,
    private readonly execDispatchSerializer: ExecDispatchSerializerService,
    private readonly subagentRunStore: SubagentRunStore,
    private readonly subagentBranchStore: SubagentBranchStore,
    private readonly claudeProjectionMutations: ClaudeProjectionMutationLog,
    private readonly backgroundCommandStore: BackgroundCommandStore,
    private readonly asyncUserInteractions: AsyncUserInteractionStore
  ) {}

  // ── Record lifecycle ──────────────────────────────────────────

  /**
   * Get the context-state record for a conversation. Returns
   * undefined if the conversation has no in-memory record yet (the
   * lifecycle service is responsible for creating it via
   * createInitialRecord on session create / load).
   */
  getContextRecord(conversationId: string): ContextStateRecord | undefined {
    return this.contextRecords.get(conversationId)
  }

  /**
   * Return a detached projection read model for one explicit owner. Child
   * reads verify their durable head/lease receipt before exposing hot state.
   */
  readMountedProjection(
    conversationId: string,
    owner: ProjectionOwner
  ): MountedContextProjection | undefined {
    const projection = this.requireMountedProjectionCurrent(
      conversationId,
      owner,
      false
    )
    return projection ? structuredClone(projection) : undefined
  }

  /**
   * Assert that a mounted projection still represents its durable owner.
   * Child snapshots are invalidated by either a branch-head move or an
   * execution-lease handoff.
   */
  assertMountedProjectionCurrent(
    conversationId: string,
    owner: ProjectionOwner
  ): void {
    this.requireMountedProjectionCurrent(conversationId, owner, true)
  }

  /**
   * Validate one fully constructed owner-scoped projection before its durable
   * projection head commits. The returned receipt is the only input accepted
   * by the post-commit map transfer.
   */
  prepareMountedProjectionInstall(
    conversationId: string,
    projection: MountedContextProjection
  ): PreparedMountedProjectionInstall {
    const ctx = this.contextRecords.get(conversationId)
    if (!ctx) {
      throw new Error(
        `ContextStateService.prepareMountedProjectionInstall: missing context ${conversationId}`
      )
    }
    return this.prepareMountedProjectionInstallForContext(
      ConversationId.of(conversationId),
      ctx,
      projection
    )
  }

  /**
   * Apply a receipt prepared before the durable boundary. This method must
   * remain a non-throwing in-memory ownership transfer; all validation,
   * including the child branch snapshot read, belongs to preparation.
   */
  applyPreparedMountedProjectionInstall(
    prepared: PreparedMountedProjectionInstall
  ): void {
    const { context, projection } = prepared
    if (projection.owner.kind === "main") {
      context.mainProjection = projection
      return
    }
    context.childProjections.set(projection.owner.ownerKey, projection)
  }

  private prepareMountedProjectionInstallForContext(
    conversationId: ConversationId,
    ctx: ContextStateRecord,
    projection: MountedContextProjection
  ): PreparedMountedProjectionInstall {
    if (this.contextRecords.get(String(conversationId)) !== ctx) {
      throw new Error(
        `ContextStateService.prepareMountedProjectionInstall: context changed ` +
          `before preparation conversation=${conversationId}`
      )
    }
    assertProjectionOwner(
      projection.owner,
      "ContextStateService.prepareMountedProjectionInstall"
    )
    if (projection.owner.conversationId !== conversationId) {
      throw new Error(
        `ContextStateService.prepareMountedProjectionInstall: owner belongs to a different conversation ` +
          `owner=${projection.owner.conversationId} context=${conversationId}`
      )
    }
    this.assertMountedProjectionMessageOwnership(projection)
    if (projection.owner.kind === "main") {
      if (projection.branchSnapshot) {
        throw new Error(
          "ContextStateService.prepareMountedProjectionInstall: main projection cannot carry a branch snapshot"
        )
      }
      assertSameProjectionOwner(
        createMainProjectionOwner(conversationId),
        projection.owner,
        "ContextStateService.prepareMountedProjectionInstall"
      )
      assertSameProjectionOwner(
        ctx.mainProjection.owner,
        projection.owner,
        "ContextStateService.prepareMountedProjectionInstall"
      )
      return { context: ctx, projection }
    }

    const snapshot = projection.branchSnapshot
    if (!snapshot) {
      throw new Error(
        "ContextStateService.prepareMountedProjectionInstall: child projection requires a durable branch snapshot"
      )
    }
    const current = ctx.childProjections.get(projection.owner.ownerKey)
    if (current) {
      assertSameProjectionOwner(
        current.owner,
        projection.owner,
        "ContextStateService.prepareMountedProjectionInstall"
      )
    }
    this.subagentBranchStore.assertProjectionBranchSnapshotCurrent(
      projection.owner,
      snapshot
    )
    return { context: ctx, projection }
  }

  private requireMountedProjectionCurrent(
    conversationId: string,
    owner: ProjectionOwner,
    required: boolean
  ): MountedContextProjection | undefined {
    assertProjectionOwner(owner, "ContextStateService.readMountedProjection")
    if (owner.conversationId !== ConversationId.of(conversationId)) {
      throw new Error(
        `ContextStateService: projection owner belongs to a different conversation ` +
          `owner=${owner.conversationId} context=${conversationId}`
      )
    }
    const ctx = this.contextRecords.get(conversationId)
    if (!ctx) {
      if (!required) return undefined
      throw new Error(
        `ContextStateService: missing mounted context ${conversationId}`
      )
    }
    const projection =
      owner.kind === "main"
        ? ctx.mainProjection
        : ctx.childProjections.get(owner.ownerKey)
    if (!projection) {
      if (!required) return undefined
      throw new Error(
        `ContextStateService: projection is not mounted ` +
          `conversation=${conversationId} owner=${owner.ownerKey}`
      )
    }
    assertSameProjectionOwner(
      owner,
      projection.owner,
      "ContextStateService.readMountedProjection"
    )
    this.assertMountedProjectionMessageOwnership(projection)
    if (owner.kind === "main") {
      if (projection.branchSnapshot) {
        throw new Error(
          "ContextStateService: mounted main projection unexpectedly has a branch snapshot"
        )
      }
      return projection
    }
    if (!projection.branchSnapshot) {
      throw new Error(
        `ContextStateService: child projection has no durable branch snapshot ` +
          `conversation=${conversationId} owner=${owner.ownerKey}`
      )
    }
    this.subagentBranchStore.assertProjectionBranchSnapshotCurrent(
      owner,
      projection.branchSnapshot
    )
    return projection
  }

  private assertMountedProjectionMessageOwnership(
    projection: MountedContextProjection
  ): void {
    if (projection.owner.kind === "main") {
      if (projection.messages.some((message) => message.isSidechain === true)) {
        throw new Error(
          "ContextStateService: main projection cannot contain sidechain messages"
        )
      }
      return
    }
    const owner = projection.owner
    for (const message of projection.messages) {
      if (
        message.isSidechain !== true ||
        message.agentId !== owner.agentId ||
        message.threadId !== owner.threadId ||
        message.branchId !== owner.branchId ||
        message.forkSourceUuid !== owner.forkSourceUuid ||
        !this.equalStringArrays(message.forkLineage, owner.forkLineage)
      ) {
        throw new Error(
          `ContextStateService: child mounted message does not match projection owner ` +
            `conversation=${owner.conversationId} owner=${owner.ownerKey} uuid=${message.uuid}`
        )
      }
    }
  }

  /**
   * Create a fresh ContextStateRecord — called by SessionLifecycleService on
   * session creation and recovery.
   */
  createInitialRecord(
    conversationId: string,
    init: ContextStateRecord
  ): ContextStateRecord {
    this.assertInitialProjectionSet(conversationId, init)
    this.contextRecords.set(conversationId, init)
    return init
  }

  private assertInitialProjectionSet(
    conversationId: string,
    context: ContextStateRecord
  ): void {
    const mainOwner = createMainProjectionOwner(
      ConversationId.of(conversationId)
    )
    assertSameProjectionOwner(
      mainOwner,
      context.mainProjection.owner,
      "ContextStateService.createInitialRecord"
    )
    if (context.mainProjection.branchSnapshot) {
      throw new Error(
        "ContextStateService.createInitialRecord: main projection cannot carry a branch snapshot"
      )
    }
    this.assertMountedProjectionMessageOwnership(context.mainProjection)
    for (const [ownerKey, projection] of context.childProjections) {
      if (projection.owner.kind !== "subagent") {
        throw new Error(
          "ContextStateService.createInitialRecord: child projection map contains a main owner"
        )
      }
      if (
        projection.owner.conversationId !== ConversationId.of(conversationId)
      ) {
        throw new Error(
          `ContextStateService.createInitialRecord: child projection belongs to a different conversation ` +
            `owner=${projection.owner.conversationId} context=${conversationId}`
        )
      }
      if (ownerKey !== projection.owner.ownerKey) {
        throw new Error(
          `ContextStateService.createInitialRecord: child projection map key mismatch ` +
            `conversation=${conversationId} owner=${projection.owner.ownerKey}`
        )
      }
      if (!projection.branchSnapshot) {
        throw new Error(
          `ContextStateService.createInitialRecord: child projection has no branch snapshot ` +
            `conversation=${conversationId} owner=${projection.owner.ownerKey}`
        )
      }
      this.assertMountedProjectionMessageOwnership(projection)
      this.subagentBranchStore.assertProjectionBranchSnapshotCurrent(
        projection.owner,
        projection.branchSnapshot
      )
    }
  }

  /**
   * Drop the context record for a conversation — called by
   * SessionLifecycleService.deleteSession / clearAllSessionCaches.
   */
  deleteRecord(conversationId: string): boolean {
    return this.contextRecords.delete(conversationId)
  }

  /**
   * Iterate every context record in memory. Used by cross-session
   * sweeps that need access to context-state fields.
   */
  iterateRecords(): IterableIterator<[string, ContextStateRecord]> {
    return this.contextRecords.entries()
  }

  syncTaskBudgetTotal(conversationId: string, total: number): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    ctx!.taskBudgetState = syncSessionTaskBudgetTotal(ctx!.taskBudgetState, {
      total,
      now: Date.now(),
    })
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  applyTaskBudgetCompactionDeduction(
    conversationId: string,
    params: {
      compactionId: string
      preCompactContextTokens: number
    }
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx?.taskBudgetState) return
    const next = applyTaskBudgetCompactionDeduction(ctx.taskBudgetState, {
      compactionId: params.compactionId,
      preCompactContextTokens: params.preCompactContextTokens,
      now: Date.now(),
    })
    if (!next || next === ctx.taskBudgetState) return
    ctx.taskBudgetState = next
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  getTaskBudgetParam(conversationId: string): TaskBudgetParam | undefined {
    return toTaskBudgetParam(
      this.contextRecords.get(conversationId)?.taskBudgetState
    )
  }
  markAssistantBackend(
    conversationId: string,
    backend: BackendType,
    options?: { model?: string }
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    if (!session) return

    session.lastActivityAt = new Date()
    session.lastAssistantBackend = backend
    if (options?.model) {
      session.lastAssistantModel = options.model
    }
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  /**
   * Drop the `toolUseResult` payload from every prior user message before
   * issuing the next backend request. Mirrors cc query.ts:530-538:
   *
   *   By this point the UI has already rendered the tool result and the
   *   next API call only needs message.message.content (tool_result blocks),
   *   not the raw output object. This prevents unbounded memory growth in
   *   long sessions before compact triggers — a single FileRead of a
   *   400KB file would otherwise stay in memory forever.
   *
   * Callers should invoke this at the boundary that feeds the wire DTO
   * (i.e. `truncateMessagesForBackend`) so the cleanup runs once per
   * outbound request regardless of how many sub-flows feed into it.
   */
  clearToolUseResultsBeforeNextSend(conversationId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    let cleared = 0
    for (const msg of ctx!.mainProjection.messages) {
      if (msg.type !== "user") continue
      if (msg.toolUseResult === undefined) continue
      delete msg.toolUseResult
      cleared++
    }
    if (cleared === 0) return
    this.logger.debug(
      `Cleared ${cleared} toolUseResult payload(s) before next send (${conversationId})`
    )
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }

  /**
   * Open (or verify) a sub-agent branch rooted at the real parent task
   * tool-use graph record. No runtime message array participates in this
   * operation: all branch identity is derived from durable graph rows.
   */
  openSubagentGraphBranch(
    conversationId: string,
    args: {
      subagentId: string
      parentToolCallId: string
      executionTurnId: TurnId
    }
  ): SubagentGraphBranch {
    if (!this.sessionLifecycle.getSession(conversationId)) {
      throw new Error(
        `openSubagentGraphBranch: missing active session ${conversationId}`
      )
    }
    return (
      this.subagentBranchStore.resolveExistingBranch(conversationId, args) ??
      this.subagentBranchStore.resolveProspectiveBranch(conversationId, args)
    )
  }

  /**
   * Build the child branch identity before its execution lease exists.  This
   * is the only admission path for a new detached execution: the caller
   * reserves a TurnId, derives this prospective branch from the durable
   * parent task record, then names the corresponding projection owner before
   * TurnLifecycle.spawn persists its first event.
   *
   * Unlike `openSubagentGraphBranch`, this deliberately does not inspect the
   * current run.  A foreground-to-background handoff still has a foreground
   * lease at this point, so trying to resolve an existing branch for the new
   * execution id would incorrectly reject the handoff before its durable
   * execution transition can be committed.
   */
  openProspectiveSubagentGraphBranch(
    conversationId: string,
    args: {
      subagentId: string
      parentToolCallId: string
      executionTurnId: TurnId
    }
  ): SubagentGraphBranch {
    if (!this.sessionLifecycle.getSession(conversationId)) {
      throw new Error(
        `openProspectiveSubagentGraphBranch: missing active session ${conversationId}`
      )
    }
    return this.subagentBranchStore.resolveProspectiveBranch(
      conversationId,
      args
    )
  }

  /**
   * Append one accepted sub-agent message to its graph branch. Assistant
   * tool-use rows and user tool-result rows share the same SQLite transaction
   * with the ledger, exactly as parent messages do.
   */
  appendSubagentGraphMessage(
    conversationId: string,
    branch: SubagentGraphBranch,
    role: "user" | "assistant",
    content: MessageContent,
    options: AppendSubagentGraphMessageOptions = {}
  ): GraphAppendResult {
    this.assertSubagentBranchOwnership(conversationId, branch)
    if (role === "user" && Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "tool_result" &&
          typeof (block as { is_error?: unknown }).is_error !== "boolean"
        ) {
          throw new Error(
            "appendSubagentGraphMessage: child tool_result requires an explicit boolean is_error outcome"
          )
        }
      }
    }
    const runCreate = options.subagentRunCreate
    if (runCreate) {
      if (
        runCreate.conversationId !== branch.conversationId ||
        runCreate.agentId !== branch.subagentId ||
        runCreate.parentToolCallId !== branch.parentToolCallId ||
        runCreate.executionTurnId !== branch.turnId ||
        runCreate.threadId !== branch.threadId ||
        runCreate.branchId !== branch.branchId
      ) {
        throw new Error(
          `appendSubagentGraphMessage: create identity does not match branch ` +
            `conversation=${conversationId} agentId=${branch.subagentId}`
        )
      }
      if (role !== "user") {
        throw new Error(
          "appendSubagentGraphMessage: a branch root must be a user prompt"
        )
      }
    }
    const ledgerOpens =
      role === "assistant"
        ? this.deriveSubagentAssistantLedgerOpens(content, branch.turnId)
        : []
    const message: SessionMessageInit =
      role === "assistant"
        ? {
            type: "assistant",
            provider: options.provider,
            providerMessageId: options.providerMessageId,
            threadId: branch.threadId,
            branchId: branch.branchId,
            agentId: branch.agentId,
            isSidechain: true,
            forkSourceUuid: branch.forkSourceUuid,
            forkLineage: [...branch.forkLineage],
            message: {
              ...(options.providerMessageId
                ? { id: options.providerMessageId }
                : {}),
              role: "assistant",
              content,
            },
          }
        : {
            type: "user",
            provider: options.provider,
            providerMessageId: options.providerMessageId,
            threadId: branch.threadId,
            branchId: branch.branchId,
            agentId: branch.agentId,
            isSidechain: true,
            forkSourceUuid: branch.forkSourceUuid,
            forkLineage: [...branch.forkLineage],
            isMeta: options.isMeta === true,
            message: { role: "user", content },
          }
    const appended = this.appendGraphMessageWithDedicatedSidechainAuthority(
      conversationId,
      message,
      undefined,
      {
        turnId: branch.turnId,
        ledgerOpens,
        toolResultMetadata: options.toolResultMetadata,
        codexResponseCommit: options.codexResponseCommit,
        terminalExecDispatches: options.terminalExecDispatches,
        subagentTerminalCommits: options.subagentTerminalCommits,
        claudeProjectionMutations: options.claudeProjectionMutations,
      },
      runCreate
        ? { kind: "root", branch, runCreate }
        : { kind: "continuation", branch }
    )
    if (!appended) {
      throw new Error(
        `appendSubagentGraphMessage: graph append produced no fragment ` +
          `conversation=${conversationId} thread=${branch.threadId}`
      )
    }
    return appended
  }

  /**
   * Commit a real client terminal onto a sidechain whose owning sub-agent was
   * already interrupted during process recovery.
   *
   * This is not a continuation path. The parent task delivery has already
   * reached its terminal graph boundary, so this method only records the
   * exact inner tool result, closes its ledger edge, and settles the matching
   * exec dispatch in one transaction. It never requires a live
   * a process-local child cache and never starts a provider request.
   */
  appendRecoveredSubagentClientTerminal(
    conversationId: string,
    commit: RecoveredSubagentClientTerminalCommit,
    content: string
  ): GraphAppendResult {
    const { branch, toolCallId, terminalExecDispatch } = commit
    if (toolCallId !== terminalExecDispatch.toolCallId) {
      throw new Error(
        `appendRecoveredSubagentClientTerminal: terminal dispatch ownership mismatch ` +
          `conversation=${conversationId} toolCallId=${toolCallId} ` +
          `dispatchToolCallId=${terminalExecDispatch.toolCallId}`
      )
    }
    if (!content.trim()) {
      throw new Error(
        `appendRecoveredSubagentClientTerminal: canonical terminal content is required ` +
          `conversation=${conversationId} toolCallId=${toolCallId}`
      )
    }

    const appended = this.appendGraphMessageWithDedicatedSidechainAuthority(
      conversationId,
      {
        type: "user",
        threadId: branch.threadId,
        branchId: branch.branchId,
        agentId: branch.agentId,
        isSidechain: true,
        forkSourceUuid: branch.forkSourceUuid,
        forkLineage: [...branch.forkLineage],
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolCallId,
              content,
              is_error: commit.isError,
            },
          ],
        },
      },
      undefined,
      {
        toolResultTurnIds: new Map([[toolCallId, branch.turnId]]),
        ...(commit.toolResultMetadata
          ? {
              toolResultMetadata: new Map([
                [toolCallId, commit.toolResultMetadata],
              ]),
            }
          : {}),
        terminalExecDispatches: [terminalExecDispatch],
      },
      { kind: "recovered", commit }
    )
    if (!appended) {
      throw new Error(
        `appendRecoveredSubagentClientTerminal: graph append produced no fragment ` +
          `conversation=${conversationId} toolCallId=${toolCallId}`
      )
    }
    return appended
  }

  /**
   * Reconcile process-owned sub-agent work before a persisted conversation is
   * mounted. This is the sole cold-recovery coordinator: it never relies on
   * an in-memory worker, never invokes the ordinary open-ledger abort sweep,
   * and never creates a fake result for a client execution that was not
   * actually terminal.
   *
   * For a foreground run that died with its parent `task` edge open, the run
   * interruption, exact main-graph parent result, delivery claim, and
   * structured memory event commit in one MessageStore transaction. Inner
   * sidechain work is treated separately: locally queued/never-written work
   * is cancelled without a tool_result; a potentially sent exec remains open
   * and parks delivered client work for an official interrupted resolution.
   */
  reconcileStaleSubagentRunsBeforeMount(
    conversationId: ConversationId,
    recoveredAt: number = Date.now()
  ): ColdSubagentRecoveryResult {
    const conversationKey = String(conversationId)
    // `SessionLifecycleService.getSession()` hydrates on a cache miss. This
    // coordinator is itself invoked from that hydration path, before mount,
    // so consulting it here would recursively re-enter session loading. The
    // mounted ContextState record is this service's exact ownership boundary.
    if (this.contextRecords.has(conversationKey)) {
      throw new Error(
        `reconcileStaleSubagentRunsBeforeMount: conversation is already mounted ` +
          `conversation=${conversationId}`
      )
    }
    if (!Number.isSafeInteger(recoveredAt) || recoveredAt <= 0) {
      throw new Error(
        "reconcileStaleSubagentRunsBeforeMount: recoveredAt must be a positive epoch"
      )
    }

    const result: ColdSubagentRecoveryResult = {
      interruptedRuns: 0,
      deliveredParentResults: 0,
      abortedUnwrittenSidechainToolCalls: 0,
      cancelledUnwrittenExecDispatches: 0,
      parkedSidechainClientTerminals: 0,
    }
    this.messageStore.runInTransaction(conversationId, (txn) => {
      const running = this.subagentRunStore.listRunningInTransaction(txn)
      const pendingDeliveries =
        this.subagentRunStore.listPendingTerminalDeliveriesInTransaction(txn)

      for (const run of running) {
        const terminal =
          this.subagentRunStore.reconcileInterruptedInTransaction(
            txn,
            run.agentId,
            {
              interruptedAt: recoveredAt,
              errorMessage: STALE_SUBAGENT_RUN_INTERRUPTION_MESSAGE,
            }
          )
        if (terminal.kind !== "transitioned") {
          throw new Error(
            `reconcileStaleSubagentRunsBeforeMount: running sub-agent could not be interrupted ` +
              `conversation=${conversationId} agentId=${run.agentId} state=${terminal.kind}`
          )
        }
        result.interruptedRuns += 1
        const reconciledRun = terminal.run
        const parentState = this.toolCallLedger.getState(
          conversationId,
          reconciledRun.parentToolCallId
        )
        if (parentState === "open") {
          const deliveredRun = this.commitColdSubagentParentDelivery(
            txn,
            reconciledRun,
            recoveredAt
          )
          result.deliveredParentResults += 1
          this.reconcileColdSubagentSidechain(
            txn,
            deliveredRun,
            recoveredAt,
            result
          )
        } else if (reconciledRun.mode !== "background") {
          throw new Error(
            `reconcileStaleSubagentRunsBeforeMount: foreground parent task is not open ` +
              `conversation=${conversationId} agentId=${reconciledRun.agentId} ` +
              `parentToolCallId=${reconciledRun.parentToolCallId} ledger=${parentState ?? "missing"}`
          )
        } else if (parentState !== "closed") {
          throw new Error(
            `reconcileStaleSubagentRunsBeforeMount: background parent task has no durable acknowledgement ` +
              `conversation=${conversationId} agentId=${reconciledRun.agentId} ` +
              `parentToolCallId=${reconciledRun.parentToolCallId} ledger=${parentState ?? "missing"}`
          )
        }
        if (parentState === "closed" && reconciledRun.mode === "background") {
          this.reconcileColdSubagentSidechain(
            txn,
            reconciledRun,
            recoveredAt,
            result
          )
        }
      }

      // A terminal run with pending delivery can only be recovered when the
      // parent task edge remains open. Background runs with an already-closed
      // spawn acknowledgement intentionally remain pending for their real
      // await/notification delivery path; a cold mount must not invent one.
      for (const run of pendingDeliveries) {
        const parentState = this.toolCallLedger.getState(
          conversationId,
          run.parentToolCallId
        )
        if (run.mode === "background" && parentState === "closed") {
          continue
        }
        if (parentState !== "open") {
          throw new Error(
            `reconcileStaleSubagentRunsBeforeMount: pending terminal delivery has no open parent task ` +
              `conversation=${conversationId} agentId=${run.agentId} ` +
              `parentToolCallId=${run.parentToolCallId} ledger=${parentState ?? "missing"}`
          )
        }
        const deliveredRun = this.commitColdSubagentParentDelivery(
          txn,
          run,
          run.terminalAt ?? recoveredAt
        )
        result.deliveredParentResults += 1
        this.reconcileColdSubagentSidechain(
          txn,
          deliveredRun,
          recoveredAt,
          result
        )
      }
    })
    return result
  }

  /**
   * Append the only permitted cold parent result. The caller has already
   * selected a terminal durable run; this method makes the graph edge,
   * delivery state and memory event all-or-nothing.
   */
  private commitColdSubagentParentDelivery(
    txn: SessionTxn,
    run: SubagentRunRecord,
    terminalAt: number
  ): SubagentRunRecord {
    const parentSource = this.requireColdSubagentParentTaskSource(txn, run)
    const parentState = this.toolCallLedger.getState(
      txn.conversationId,
      run.parentToolCallId
    )
    if (parentState !== "open") {
      throw new Error(
        `commitColdSubagentParentDelivery: parent task is not open ` +
          `conversation=${txn.conversationId} agentId=${run.agentId} ` +
          `parentToolCallId=${run.parentToolCallId} ledger=${parentState ?? "missing"}`
      )
    }
    const artifact = requireCanonicalSubagentCompletionArtifact(run)
    const appended = this.messageStore.appendToolResultBlock(
      txn,
      {
        type: "tool_result",
        tool_use_id: run.parentToolCallId,
        content: artifact.report,
        is_error: run.status !== "completed",
      },
      {
        turnId: parentSource.turnId,
        timestamp: terminalAt,
      }
    )
    this.commitSubagentTerminalDeliveriesInTransaction(
      txn,
      [
        {
          delivery: {
            agentId: run.agentId,
            route: "parent_task_result",
            sourceToolUseId: run.parentToolCallId,
          },
        },
      ],
      new Map([[run.parentToolCallId, appended.message]]),
      [appended.message]
    )
    const delivered = this.subagentRunStore.get(txn.conversationId, run.agentId)
    if (!delivered || delivered.deliveryState !== "delivered") {
      throw new Error(
        `commitColdSubagentParentDelivery: delivery was not committed ` +
          `conversation=${txn.conversationId} agentId=${run.agentId}`
      )
    }
    return delivered
  }

  /**
   * Sidechain recovery is intentionally independent from the parent result.
   * An unwritten queued exec has no client fact to preserve and is cancelled
   * without appending a result. Every potentially sent envelope remains open
   * and waits for Cursor's audited interrupted-pending resolution.
   */
  private reconcileColdSubagentSidechain(
    txn: SessionTxn,
    run: SubagentRunRecord,
    recoveredAt: number,
    result: ColdSubagentRecoveryResult
  ): void {
    const parentSource = this.requireColdSubagentParentTaskSource(txn, run)
    for (const entry of this.toolCallLedger.listOpen(txn.conversationId)) {
      if (entry.toolUseId === run.parentToolCallId) continue
      if (
        !entry.turnId ||
        !this.subagentRunStore.ownsExecutionTurn(
          txn.conversationId,
          run.agentId,
          entry.turnId
        )
      ) {
        continue
      }
      const source = this.messageStore.getToolUseMessage(
        txn.conversationId,
        entry.toolUseId
      )
      if (!source) {
        throw new Error(
          `reconcileColdSubagentSidechain: open child ledger has no graph source ` +
            `conversation=${txn.conversationId} agentId=${run.agentId} ` +
            `toolCallId=${entry.toolUseId}`
        )
      }
      this.assertColdSubagentSidechainSource(run, parentSource, entry, source)
      const dispatches = this.execDispatchStore.findActiveByToolCall(
        txn.conversationId,
        entry.toolUseId
      )
      const potentiallySent = dispatches.filter(
        (dispatch) => dispatch.state !== "queued"
      )

      for (const queued of dispatches.filter(
        (dispatch) => dispatch.state === "queued"
      )) {
        this.execDispatchStore.cancelExactInTransaction(
          txn,
          queued.streamEpoch,
          queued.execId,
          queued.protocolExecId,
          "subagent_restart_unwritten",
          recoveredAt
        )
        result.cancelledUnwrittenExecDispatches += 1
      }

      if (potentiallySent.length === 0) {
        const aborted = this.toolCallLedger.abortOpenToolCalls(txn, {
          toolUseIds: [entry.toolUseId],
          reason: "shutdown",
        })
        if (aborted.abortedToolCallIds.length !== 1) {
          throw new Error(
            `reconcileColdSubagentSidechain: queued child edge did not abort exactly once ` +
              `conversation=${txn.conversationId} agentId=${run.agentId} ` +
              `toolCallId=${entry.toolUseId}`
          )
        }
        result.abortedUnwrittenSidechainToolCalls += 1
        continue
      }

      if (run.status !== "interrupted" || run.deliveryState !== "delivered") {
        throw new Error(
          `reconcileColdSubagentSidechain: sent child exec has no delivered interrupted owner ` +
            `conversation=${txn.conversationId} agentId=${run.agentId} ` +
            `toolCallId=${entry.toolUseId} status=${run.status} delivery=${run.deliveryState}`
        )
      }
      for (const dispatch of potentiallySent) {
        if (
          dispatch.toolCallId !== entry.toolUseId ||
          dispatch.turnId !== entry.turnId
        ) {
          throw new Error(
            `reconcileColdSubagentSidechain: dispatch ownership mismatch ` +
              `conversation=${txn.conversationId} agentId=${run.agentId} ` +
              `toolCallId=${entry.toolUseId} execId=${dispatch.execId}`
          )
        }
        this.execDispatchStore.awaitInterruptedResolutionInTransaction(
          txn,
          dispatch,
          recoveredAt
        )
        result.parkedSidechainClientTerminals += 1
      }
    }
  }

  private requireColdSubagentParentTaskSource(
    txn: SessionTxn,
    run: SubagentRunRecord
  ): PersistedMessage {
    const source = this.messageStore.getToolUseMessage(
      txn.conversationId,
      run.parentToolCallId
    )
    if (!source || !source.turnId) {
      throw new Error(
        `Cold sub-agent recovery has no parent task graph source ` +
          `conversation=${txn.conversationId} agentId=${run.agentId} ` +
          `parentToolCallId=${run.parentToolCallId}`
      )
    }
    const tool = source.content.find(
      (block) =>
        block.type === "tool_use" &&
        block.id === run.parentToolCallId &&
        block.name === "task"
    )
    if (!tool) {
      throw new Error(
        `Cold sub-agent recovery parent source is not its exact task tool_use ` +
          `conversation=${txn.conversationId} agentId=${run.agentId} ` +
          `parentToolCallId=${run.parentToolCallId} uuid=${source.uuid}`
      )
    }
    return source
  }

  private assertColdSubagentSidechainSource(
    run: SubagentRunRecord,
    parentSource: PersistedMessage,
    entry: { toolUseId: string; toolName: string; turnId?: TurnId },
    source: PersistedMessage
  ): void {
    const inheritedLineage = parentSource.forkLineage
      ? [...parentSource.forkLineage]
      : []
    if (inheritedLineage.includes(parentSource.uuid)) {
      throw new Error(
        `reconcileColdSubagentSidechain: parent fork lineage already contains its source ` +
          `conversation=${run.conversationId} agentId=${run.agentId} uuid=${parentSource.uuid}`
      )
    }
    const expectedLineage = [...inheritedLineage, parentSource.uuid]
    const ownsExactToolUse = source.content.some(
      (block) =>
        block.type === "tool_use" &&
        block.id === entry.toolUseId &&
        block.name === entry.toolName
    )
    if (
      !entry.turnId ||
      source.turnId !== entry.turnId ||
      source.threadId !== run.threadId ||
      source.branchId !== run.branchId ||
      source.agentId !== run.agentId ||
      source.isSidechain !== true ||
      source.forkSourceUuid !== parentSource.uuid ||
      !this.equalStringArrays(source.forkLineage, expectedLineage) ||
      !ownsExactToolUse
    ) {
      throw new Error(
        `reconcileColdSubagentSidechain: durable child graph identity mismatch ` +
          `conversation=${run.conversationId} agentId=${run.agentId} ` +
          `toolCallId=${entry.toolUseId} sourceUuid=${source.uuid}`
      )
    }
  }

  /**
   * Materialize a sub-agent prompt from durable graph fragments. This is used
   * before every child backend request, including after an in-process cache
   * has been dropped or a session has been restored.
   */
  getSubagentGraphMessages(
    conversationId: string,
    branch: SubagentGraphBranch
  ): SessionMessage[] {
    this.assertSubagentBranchOwnership(conversationId, branch)
    const messages = this.messageStore.getSubagentBranchMessages(
      branch.conversationId,
      branch.threadId
    )
    this.subagentBranchStore.verifyBranchRead(branch, messages)
    const revisionsByMessage = new Map<
      string,
      ReturnType<MessageStore["getSubagentBranchMessageRevisions"]>
    >()
    for (const revision of this.messageStore.getSubagentBranchMessageRevisions(
      branch.conversationId,
      branch.threadId
    )) {
      const current = revisionsByMessage.get(revision.messageUuid)
      if (current) {
        current.push(revision)
      } else {
        revisionsByMessage.set(revision.messageUuid, [revision])
      }
    }
    return messages.map((message) =>
      applyMessageRevisionProjection(
        projectPersistedMessageToSessionMessage(message),
        revisionsByMessage.get(message.uuid) ?? []
      )
    )
  }

  private assertSubagentBranchOwnership(
    conversationId: string,
    branch: SubagentGraphBranch
  ): void {
    if (branch.conversationId !== ConversationId.of(conversationId)) {
      throw new Error(
        `subagent graph branch belongs to ${branch.conversationId}, not ${conversationId}`
      )
    }
  }

  /**
   * The only post-restart sidechain write allowed after a sub-agent run has
   * been terminalized.  All checks live inside the graph transaction so the
   * caller cannot observe a valid branch and then settle a different one.
   */
  private resolveRecoveredSubagentClientTerminalSourceInTransaction(
    txn: SessionTxn,
    commit: RecoveredSubagentClientTerminalCommit
  ): PersistedMessage {
    const {
      branch,
      toolCallId,
      sourceToolAssistantUuid,
      terminalExecDispatch,
    } = commit
    if (branch.conversationId !== txn.conversationId) {
      throw new Error(
        `Recovered sidechain terminal conversation mismatch: txn=${txn.conversationId} ` +
          `branch=${branch.conversationId} toolCallId=${toolCallId}`
      )
    }
    requireExactDurableIdentifier(
      sourceToolAssistantUuid,
      "Recovered sidechain source tool assistant UUID"
    )
    if (terminalExecDispatch.toolCallId !== toolCallId) {
      throw new Error(
        `Recovered sidechain terminal has invalid exact identity: ` +
          `conversation=${txn.conversationId} toolCallId=${toolCallId}`
      )
    }
    const source = this.messageStore.getToolUseMessage(
      txn.conversationId,
      toolCallId
    )
    if (!source || source.uuid !== sourceToolAssistantUuid) {
      throw new Error(
        `Recovered sidechain terminal source mismatch: conversation=${txn.conversationId} ` +
          `toolCallId=${toolCallId} expectedSource=${sourceToolAssistantUuid}`
      )
    }
    if (!this.toolCallLedger.isOpen(txn.conversationId, toolCallId)) {
      throw new Error(
        `Recovered sidechain terminal has no open inner ledger edge: ` +
          `conversation=${txn.conversationId} toolCallId=${toolCallId}`
      )
    }
    return source
  }

  private resolveSidechainWriteAuthorityInTransaction(
    txn: SessionTxn,
    authority: DedicatedSidechainAppendAuthority
  ): SubagentBranchWriteAuthority {
    switch (authority.kind) {
      case "root":
        return {
          kind: "root",
          branch: authority.branch,
          runCreate: authority.runCreate,
        }
      case "continuation":
        return { kind: "continuation", branch: authority.branch }
      case "recovered":
        return {
          kind: "recovered",
          branch: authority.commit.branch,
          source:
            this.resolveRecoveredSubagentClientTerminalSourceInTransaction(
              txn,
              authority.commit
            ),
        }
    }
  }

  /**
   * The dedicated writer may supply descriptive/provider fields, but durable
   * graph identity and the parent edge are owned by the transaction plan.
   */
  private assertSidechainAppendMessageMatchesPlan(
    message: SessionMessage,
    plan: SubagentBranchAppendPlan
  ): void {
    if (
      message.parentUuid !== undefined ||
      message.threadId !== plan.branch.threadId ||
      message.branchId !== plan.branch.branchId ||
      message.agentId !== plan.branch.agentId ||
      message.isSidechain !== true ||
      message.forkSourceUuid !== plan.branch.forkSourceUuid ||
      !this.equalStringArrays(message.forkLineage, plan.branch.forkLineage) ||
      (message.turnId !== undefined && message.turnId !== plan.branch.turnId)
    ) {
      throw new Error(
        `ContextStateService: sidechain message identity is not owned by its durable branch plan ` +
          `conversation=${plan.branch.conversationId} agentId=${plan.branch.agentId}`
      )
    }
  }

  /**
   * This is not a generic fallback: a dedicated sub-agent writer has already
   * accepted a provider response and binds every exact tool block to the
   * current child execution before it enters the generic graph composer.
   */
  private deriveSubagentAssistantLedgerOpens(
    content: MessageContent,
    executionTurnId: TurnId
  ): AssistantLedgerOpen[] {
    const blocks: ContentBlock[] = Array.isArray(content)
      ? (content as ContentBlock[])
      : [
          {
            type: "text",
            text: typeof content === "string" ? content : "",
          } as ContentBlock,
        ]
    const seen = new Set<string>()
    const opens: AssistantLedgerOpen[] = []
    for (const block of blocks) {
      if (block.type !== "tool_use") continue
      const toolUseId = this.requireExactLedgerIdentifier(
        block.id,
        "sub-agent tool_use id"
      )
      const toolName = this.requireExactLedgerIdentifier(
        block.name,
        "sub-agent tool_use name"
      )
      if (seen.has(toolUseId)) {
        throw new Error(
          `ContextStateService: sub-agent assistant response repeats tool_use id ${toolUseId}`
        )
      }
      seen.add(toolUseId)
      opens.push({ toolUseId, toolName, turnId: executionTurnId })
    }
    return opens
  }

  /**
   * Strict bidirectional pairing: an assistant block cannot open a ledger
   * row by omission, and a supplied ledger row cannot survive without its
   * exact assistant tool_use block.
   */
  private requireExactAssistantLedgerOpens(
    blocks: readonly ContentBlock[],
    supplied: readonly AssistantLedgerOpen[] | undefined
  ): Map<string, AssistantLedgerOpen> {
    const expected = new Map<string, string>()
    for (const block of blocks) {
      if (block.type !== "tool_use") continue
      const toolUseId = this.requireExactLedgerIdentifier(
        block.id,
        "assistant tool_use id"
      )
      const toolName = this.requireExactLedgerIdentifier(
        block.name,
        "assistant tool_use name"
      )
      if (expected.has(toolUseId)) {
        throw new Error(
          `ContextStateService.appendGraphMessage: duplicate assistant tool_use id ${toolUseId}`
        )
      }
      expected.set(toolUseId, toolName)
    }

    const opens = supplied ?? []
    const resolved = new Map<string, AssistantLedgerOpen>()
    for (const candidate of opens) {
      if (!candidate || typeof candidate !== "object") {
        throw new Error(
          "ContextStateService.appendGraphMessage: ledgerOpens entries must be objects"
        )
      }
      const toolUseId = this.requireExactLedgerIdentifier(
        candidate.toolUseId,
        "ledger open toolUseId"
      )
      const toolName = this.requireExactLedgerIdentifier(
        candidate.toolName,
        "ledger open toolName"
      )
      if (resolved.has(toolUseId)) {
        throw new Error(
          `ContextStateService.appendGraphMessage: duplicate ledger open for tool_use ${toolUseId}`
        )
      }
      const expectedName = expected.get(toolUseId)
      if (!expectedName) {
        throw new Error(
          `ContextStateService.appendGraphMessage: supplied ledger open has no assistant tool_use ${toolUseId}`
        )
      }
      if (expectedName !== toolName) {
        throw new Error(
          `ContextStateService.appendGraphMessage: ledger open tool name mismatch for ${toolUseId}`
        )
      }
      const origin = candidate.origin ?? "runtime"
      if (origin !== "runtime" && origin !== "cursor_history") {
        throw new Error(
          `ContextStateService.appendGraphMessage: invalid ledger origin for ${toolUseId}`
        )
      }
      if (origin === "runtime") {
        if (!candidate.turnId) {
          throw new Error(
            `ContextStateService.appendGraphMessage: runtime ledger open requires turnId for ${toolUseId}`
          )
        }
      } else if (candidate.turnId !== undefined) {
        throw new Error(
          `ContextStateService.appendGraphMessage: imported ledger open must not carry turnId for ${toolUseId}`
        )
      }
      resolved.set(toolUseId, {
        toolUseId,
        toolName,
        ...(candidate.turnId ? { turnId: candidate.turnId } : {}),
        ...(candidate.origin ? { origin: candidate.origin } : {}),
      })
    }
    if (resolved.size !== expected.size) {
      throw new Error(
        `ContextStateService.appendGraphMessage: assistant tool_use / ledgerOpens cardinality mismatch ` +
          `assistant=${expected.size} ledger=${resolved.size}`
      )
    }
    return resolved
  }

  private requireExactLedgerIdentifier(value: unknown, label: string): string {
    if (typeof value !== "string" || value !== value.trim() || !value) {
      throw new Error(
        `ContextStateService: ${label} must be a non-empty canonical string`
      )
    }
    return value
  }

  private equalStringArrays(
    left: readonly string[] | undefined,
    right: readonly string[]
  ): boolean {
    return (
      Array.isArray(left) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    )
  }

  /**
   * Append one logical message to the durable graph and update the active
   * ContextState projection from the accepted graph fragments. Assistant
   * tool_use blocks open their ledger entry in the same transaction; user
   * tool_result blocks close through MessageStore.appendToolResultBlock.
   *
   * Internally runs messageStore.runInTransaction so graph rows and ledger
   * transitions land atomically. The in-memory projection never becomes a
   * write-back source for graph history.
   */
  appendGraphMessage(
    conversationId: string,
    roleOrMsg: "user" | "assistant" | SessionMessageInit,
    contentMaybe?: MessageContent,
    opts?: GraphAppendOptions
  ): GraphAppendResult | undefined {
    return this.appendGraphMessageWithDedicatedSidechainAuthority(
      conversationId,
      roleOrMsg,
      contentMaybe,
      opts
    )
  }

  /**
   * Shared graph composer. Its sidechain capability is private and can only
   * be constructed by the dedicated root/continuation/recovered entry points
   * above; all public generic graph calls pass no capability and therefore
   * reject sidechain data before any durable write starts.
   */
  private appendGraphMessageWithDedicatedSidechainAuthority(
    conversationId: string,
    roleOrMsg: "user" | "assistant" | SessionMessageInit,
    contentMaybe?: MessageContent,
    opts?: GraphAppendOptions,
    dedicatedSidechainAuthority?: DedicatedSidechainAppendAuthority
  ): GraphAppendResult | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return undefined

    let message: SessionMessage
    if (typeof roleOrMsg === "string") {
      const role = roleOrMsg
      const content = contentMaybe!
      if (
        role === "assistant" &&
        Array.isArray(content) &&
        content.length === 0
      ) {
        this.logger.warn(
          `addMessage: dropping empty assistant message for ${conversationId}`
        )
        return undefined
      }
      message = makeSessionMessage(role, content)
    } else {
      const partial = roleOrMsg
      if (
        partial.type === "assistant" &&
        Array.isArray(partial.message.content) &&
        partial.message.content.length === 0
      ) {
        this.logger.warn(
          `addMessage: dropping empty assistant message for ${conversationId}`
        )
        return undefined
      }
      message = {
        ...partial,
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      } as SessionMessage
    }

    if (message.isSidechain === true && !dedicatedSidechainAuthority) {
      throw new Error(
        "ContextStateService.appendGraphMessage: generic graph append cannot write a sidechain"
      )
    }
    if (dedicatedSidechainAuthority && message.isSidechain !== true) {
      throw new Error(
        "ContextStateService: dedicated sidechain authority requires a sidechain message"
      )
    }
    const messageBlocks: ContentBlock[] = Array.isArray(message.message.content)
      ? (message.message.content as ContentBlock[])
      : [
          {
            type: "text",
            text:
              typeof message.message.content === "string"
                ? message.message.content
                : "",
          } as ContentBlock,
        ]
    const assistantLedgerOpens =
      message.type === "assistant"
        ? this.requireExactAssistantLedgerOpens(
            messageBlocks,
            opts?.ledgerOpens
          )
        : new Map<
            string,
            {
              toolUseId: string
              toolName: string
              turnId?: TurnId
              origin?: ToolCallLedgerOrigin
            }
          >()

    // Graph append + ledger pairing land in one transaction.
    const cid = ConversationId.of(conversationId)
    const appended: GraphAppendFragment[] = []
    const appendedPersisted: PersistedMessage[] = []
    const appendedToolResultIds = new Set<string>()
    const appendedToolResultSources = new Map<string, PersistedMessage>()
    const appendedClaudeProjectionMutations: PersistedClaudeProjectionMutation[] =
      []
    let appendedMemoryEvent = false
    let projectedMessages: SessionMessage[] = []
    let preparedProjection: PreparedMountedGraphProjection | undefined
    let sidechainPlan: SubagentBranchAppendPlan | undefined
    let projectionOwner: ProjectionOwner = createMainProjectionOwner(cid)
    let sidechainSnapshot: SubagentProjectionBranchSnapshot | undefined
    try {
      this.messageStore.runInTransaction(cid, (txn) => {
        if (dedicatedSidechainAuthority) {
          const authority = this.resolveSidechainWriteAuthorityInTransaction(
            txn,
            dedicatedSidechainAuthority
          )
          sidechainPlan = this.subagentBranchStore.prepareAppendInTransaction(
            txn,
            authority
          )
          projectionOwner = this.subagentBranchStore.createProjectionOwner(
            sidechainPlan.branch
          )
          const mountedChild = ctx!.childProjections.get(
            projectionOwner.ownerKey
          )
          if (mountedChild) {
            this.assertMountedProjectionCurrent(conversationId, projectionOwner)
          } else if (sidechainPlan.kind !== "root") {
            throw new Error(
              `ContextStateService.appendGraphMessage: child branch is not mounted ` +
                `conversation=${conversationId} owner=${projectionOwner.ownerKey}`
            )
          }
          this.assertSidechainAppendMessageMatchesPlan(message, sidechainPlan)
          message = {
            ...message,
            parentUuid: sidechainPlan.parentUuid,
            threadId: sidechainPlan.branch.threadId,
            branchId: sidechainPlan.branch.branchId,
            agentId: sidechainPlan.branch.agentId,
            isSidechain: true,
            forkSourceUuid: sidechainPlan.branch.forkSourceUuid,
            forkLineage: [...sidechainPlan.branch.forkLineage],
          }
        }
        const blocks = messageBlocks
        const timestamp = Date.parse(message.timestamp)
        let previousFragmentUuid: string | undefined
        if (message.type === "assistant") {
          // Multi-block assistant message: append each block as its
          // own graph row while retaining the non-unique provider message id.
          // Every assistant tool_use opens a ledger row in
          // the same transaction as its message row; callers may supply a
          // real parent turn id, otherwise the conversation-scoped ctx turn
          // keeps restart recovery addressable.
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i]
            if (!block) continue
            if (block.type === "tool_result" || block.type === "cache_edits") {
              continue
            }
            const explicitLedgerOpen =
              block.type === "tool_use"
                ? assistantLedgerOpens.get(block.id)
                : undefined
            const hasExplicitAssistantTurn =
              opts?.assistantBlockTurnIds?.has(i) === true
            const explicitAssistantTurn = hasExplicitAssistantTurn
              ? opts?.assistantBlockTurnIds?.get(i)
              : undefined
            const turnId =
              block.type === "tool_use"
                ? explicitLedgerOpen?.turnId
                : hasExplicitAssistantTurn
                  ? explicitAssistantTurn
                  : this.resolveGraphTurnId(cid, opts?.turnId ?? message.turnId)
            if (
              block.type === "tool_use" &&
              hasExplicitAssistantTurn &&
              explicitAssistantTurn !== explicitLedgerOpen?.turnId
            ) {
              throw new Error(
                `ContextStateService.appendGraphMessage: assistant block turn does not match explicit ledger open ` +
                  `conversation=${conversationId} toolUseId=${block.id}`
              )
            }
            const result = this.messageStore.appendAssistantBlock(txn, block, {
              turnId,
              metadata: message.metadata,
              // The graph records an accepted logical projection owner only.
              // Current-session backend selection is transport state and must
              // never be retroactively written into an already accepted row.
              provider: message.provider,
              providerMessageId:
                message.providerMessageId ?? message.message.id,
              logicalParentUuid: message.logicalParentUuid ?? message.uuid,
              parentUuid: previousFragmentUuid ?? message.parentUuid,
              threadId: message.threadId,
              branchId: message.branchId,
              agentId: message.agentId,
              isSidechain: message.isSidechain,
              forkSourceUuid: message.forkSourceUuid,
              forkLineage: message.forkLineage,
              blockOccurrence: i,
              timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
            })
            previousFragmentUuid = result.recordUuid
            appended.push({
              recordId: result.recordUuid,
              messageSeq: result.seq,
            })
            appendedPersisted.push(result.message)
            if (block.type === "tool_use") {
              if (!explicitLedgerOpen) {
                throw new Error(
                  `ContextStateService.appendGraphMessage: assistant tool_use has no explicit ledger open ` +
                    `conversation=${conversationId} toolUseId=${block.id}`
                )
              }
              this.toolCallLedger.open(txn, {
                toolUseId: block.id,
                toolName: explicitLedgerOpen.toolName,
                turnId,
                origin: explicitLedgerOpen.origin,
                openMessageSeq: result.seq,
              })
            }
          }
        } else {
          // user message — single envelope (may contain tool_result blocks)
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i]
            if (!block) continue
            if (block.type === "tool_result") {
              const hasExplicitResultTurn =
                opts?.toolResultTurnIds?.has(block.tool_use_id) === true
              const turnId = hasExplicitResultTurn
                ? opts?.toolResultTurnIds?.get(block.tool_use_id)
                : this.resolveGraphTurnId(cid, opts?.turnId ?? message.turnId)
              const metadata =
                opts?.toolResultMetadata?.has(block.tool_use_id) === true
                  ? opts.toolResultMetadata.get(block.tool_use_id)
                  : message.metadata
              if (this.toolCallLedger.isOpen(cid, block.tool_use_id)) {
                const result = this.messageStore.appendToolResultBlock(
                  txn,
                  block,
                  {
                    turnId,
                    metadata,
                    logicalParentUuid:
                      message.logicalParentUuid ?? message.uuid,
                    // A tool_result belongs to the assistant tool_use that
                    // opened its ledger row. MessageStore resolves that
                    // durable UUID atomically; chaining results to the prior
                    // user fragment would sever the actual tool edge.
                    parentUuid: undefined,
                    provider: message.provider,
                    providerMessageId: message.providerMessageId,
                    threadId: message.threadId,
                    branchId: message.branchId,
                    agentId: message.agentId,
                    isSidechain: message.isSidechain,
                    forkSourceUuid: message.forkSourceUuid,
                    forkLineage: message.forkLineage,
                    blockOccurrence: i,
                    timestamp: Number.isFinite(timestamp)
                      ? timestamp
                      : undefined,
                  }
                )
                previousFragmentUuid = result.recordUuid
                appended.push({
                  recordId: result.recordUuid,
                  messageSeq: result.seq,
                })
                appendedPersisted.push(result.message)
                appendedToolResultIds.add(block.tool_use_id)
                appendedToolResultSources.set(block.tool_use_id, result.message)
                const claudeMutations =
                  opts?.claudeProjectionMutations?.get(block.tool_use_id) ?? []
                if (claudeMutations.length > 0) {
                  const sourceToolAssistantUuid = requireExactDurableIdentifier(
                    result.message.sourceToolAssistantUuid,
                    `ContextStateService Claude mutation source assistant for ${block.tool_use_id}`
                  )
                  const sourceAssistant =
                    this.subagentBranchStore.verifyProjectionGraphRecord(
                      projectionOwner,
                      sourceToolAssistantUuid
                    )
                  const ref = createClaudeProjectionRefFromGraphProvider(
                    projectionOwner,
                    sourceAssistant.provider
                  )
                  appendedClaudeProjectionMutations.push(
                    ...this.claudeProjectionMutations.appendForToolResultInTransaction(
                      txn,
                      {
                        ref,
                        sourceGraphUuid: result.recordUuid,
                        sourceToolUseId: block.tool_use_id,
                        mutations: claudeMutations,
                        createdAt: result.message.timestamp,
                      }
                    )
                  )
                }
              } else {
                throw new Error(
                  `ContextStateService.appendGraphMessage: refusing unmatched ` +
                    `tool_result conversation=${conversationId} ` +
                    `toolUseId=${block.tool_use_id} turnId=${turnId}`
                )
              }
            } else {
              const result = this.messageStore.appendUserMessage(txn, [block], {
                turnId:
                  opts?.userBlockTurnIds?.has(i) === true
                    ? opts.userBlockTurnIds.get(i)
                    : this.resolveGraphTurnId(
                        cid,
                        opts?.turnId ?? message.turnId
                      ),
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
                blockOccurrence: i,
                timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
              })
              previousFragmentUuid = result.recordUuid
              appended.push({
                recordId: result.recordUuid,
                messageSeq: result.seq,
              })
              appendedPersisted.push(result.message)
            }
          }
        }

        if (sidechainPlan) {
          this.subagentBranchStore.advanceInTransaction(
            txn,
            sidechainPlan,
            appendedPersisted
          )
          if (projectionOwner.kind !== "subagent") {
            throw new Error(
              "ContextStateService.appendGraphMessage: sidechain plan has no child projection owner"
            )
          }
          sidechainSnapshot =
            this.subagentBranchStore.readProjectionBranchSnapshot(
              projectionOwner
            )
        }

        for (const [toolUseId, mutations] of opts?.claudeProjectionMutations ??
          []) {
          if (!appendedToolResultIds.has(toolUseId)) {
            throw new Error(
              `ContextStateService.appendGraphMessage: Claude mutations have no triggering tool_result ` +
                `conversation=${conversationId} toolUseId=${toolUseId}`
            )
          }
          if (!Array.isArray(mutations) || mutations.length === 0) {
            throw new Error(
              `ContextStateService.appendGraphMessage: Claude mutation batch must be non-empty ` +
                `conversation=${conversationId} toolUseId=${toolUseId}`
            )
          }
        }

        opts?.codexResponseCommit?.commitInTransaction(txn, appended)

        const seenAsyncInteractionOpens = new Set<string>()
        for (const pending of opts?.asyncUserInteractionOpens ?? []) {
          if (seenAsyncInteractionOpens.has(pending.toolCallId)) {
            throw new Error(
              `ContextStateService.appendGraphMessage: duplicate async interaction open ` +
                `conversation=${conversationId} toolCallId=${pending.toolCallId}`
            )
          }
          seenAsyncInteractionOpens.add(pending.toolCallId)
          const source = appendedToolResultSources.get(pending.toolCallId)
          if (!source) {
            throw new Error(
              `ContextStateService.appendGraphMessage: async interaction has no ` +
                `matching appended tool_result conversation=${conversationId} ` +
                `toolCallId=${pending.toolCallId}`
            )
          }
          if (source.isSidechain === true || projectionOwner.kind !== "main") {
            throw new Error(
              `ContextStateService.appendGraphMessage: asynchronous user interaction ` +
                `must belong to the main projection conversation=${conversationId} ` +
                `toolCallId=${pending.toolCallId}`
            )
          }
          this.messageStore.assertAcceptedToolResultReceiptInTransaction(txn, {
            toolUseId: pending.toolCallId,
            recordUuid: source.uuid,
          })
          this.asyncUserInteractions.openPendingInTransaction(txn, {
            ...pending,
            sourceMessageUuid: source.uuid,
          })
        }

        const continuationClaim = opts?.asyncUserInteractionContinuationClaim
        if (continuationClaim) {
          if (projectionOwner.kind !== "main") {
            throw new Error(
              "Async user interaction continuation cannot be appended to a sidechain"
            )
          }
          const matchingSources = appendedPersisted.filter(
            (persisted) =>
              persisted.role === "user" &&
              persisted.isSidechain !== true &&
              persisted.metadata?.source === "cursor_control_continuation" &&
              persisted.metadata?.origin === "async_user_response" &&
              persisted.metadata?.asyncInteractionToolCallId ===
                continuationClaim.toolCallId &&
              persisted.metadata?.asyncInteractionResolutionFingerprint ===
                continuationClaim.resolutionFingerprint
          )
          if (matchingSources.length !== 1) {
            throw new Error(
              `ContextStateService.appendGraphMessage: async continuation requires ` +
                `one exact control-notification source conversation=${conversationId} ` +
                `toolCallId=${continuationClaim.toolCallId} matches=${matchingSources.length}`
            )
          }
          const claimed =
            this.asyncUserInteractions.claimContinuationInTransaction(txn, {
              ...continuationClaim,
              continuationSourceUuid: matchingSources[0]!.uuid,
            })
          if (claimed.kind !== "claimed") {
            throw new Error(
              `ContextStateService.appendGraphMessage: async continuation claim failed ` +
                `conversation=${conversationId} toolCallId=${continuationClaim.toolCallId} ` +
                `state=${claimed.kind}`
            )
          }
        }

        const seenTerminalDispatches = new Set<string>()
        for (const terminal of opts?.terminalExecDispatches ?? []) {
          if (!appendedToolResultIds.has(terminal.toolCallId)) {
            throw new Error(
              `ContextStateService.appendGraphMessage: terminal exec dispatch has no ` +
                `matching appended tool_result conversation=${conversationId} ` +
                `toolCallId=${terminal.toolCallId}`
            )
          }
          const identity =
            `${terminal.streamEpoch}:${terminal.execId}:` +
            terminal.protocolExecId
          if (seenTerminalDispatches.has(identity)) {
            throw new Error(
              `ContextStateService.appendGraphMessage: duplicate terminal exec dispatch ` +
                `conversation=${conversationId} identity=${identity}`
            )
          }
          seenTerminalDispatches.add(identity)
          if (terminal.disposition === "settled") {
            this.execDispatchStore.acceptClientResultInTransaction(
              txn,
              terminal.streamEpoch,
              terminal.execId,
              terminal.protocolExecId,
              terminal.terminalReason
            )
          } else {
            this.execDispatchStore.cancelExactInTransaction(
              txn,
              terminal.streamEpoch,
              terminal.execId,
              terminal.protocolExecId,
              terminal.terminalReason
            )
          }
        }

        appendedMemoryEvent =
          this.commitSubagentTerminalDeliveriesInTransaction(
            txn,
            opts?.subagentTerminalCommits ?? [],
            appendedToolResultSources,
            appendedPersisted
          ) || appendedMemoryEvent

        this.commitBackgroundShellTerminalDeliveriesInTransaction(
          txn,
          opts?.backgroundShellTerminalDeliveries ?? [],
          appendedPersisted
        )

        projectedMessages = appendedPersisted.map((persisted) =>
          projectPersistedMessageToSessionMessage(persisted)
        )
        preparedProjection = this.prepareMountedGraphProjection(
          cid,
          ctx!,
          projectionOwner,
          projectedMessages,
          {
            toolUseResult:
              message.type === "user" ? message.toolUseResult : undefined,
            refreshSessionMemory: appendedMemoryEvent,
            childSnapshot: sidechainSnapshot,
            allowChildProjectionCreate: sidechainPlan?.kind === "root",
          }
        )
      })
    } catch (err) {
      opts?.codexResponseCommit?.abortAfterRollback()
      this.logger.error(
        `appendGraphMessage write failed for ${conversationId}: ${(err as Error).message}`
      )
      throw err
    }

    opts?.codexResponseCommit?.installAfterCommit()

    if (appended.length === 0) {
      return undefined
    }

    // The complete mounted projection was prepared inside the same transaction
    // from its append receipts. Once runInTransaction returns, the durable
    // commit is known to have succeeded and installing the prepared values is
    // only a non-throwing in-memory ownership transfer.
    if (preparedProjection) {
      this.applyPreparedMountedGraphProjection(preparedProjection)
    }
    session.lastActivityAt = new Date()
    if (preparedProjection?.flushImmediately) {
      this.sessionLifecycle.clearScheduledPersist(conversationId)
      this.sessionLifecycle.persistSession(conversationId)
    } else {
      this.sessionLifecycle.schedulePersist(conversationId)
    }
    return {
      fragments: appended,
      projectedMessages,
      claudeProjectionMutations: appendedClaudeProjectionMutations,
    }
  }

  /**
   * Materialize the durable memory event for a delivered terminal run.
   * The run store owns the terminal facts; the accepted graph result owns the
   * event provenance. Both are joined only inside the delivery transaction so
   * callers cannot manufacture a second lifecycle representation.
   */
  private appendSubagentTerminalMemory(
    txn: SessionTxn,
    run: SubagentRunRecord,
    sourceToolUseId: string,
    sourceRecordUuid: string,
    sourceKind: Extract<
      SessionMemorySourceKind,
      "tool_result" | "control_notification"
    >
  ): void {
    if (run.conversationId !== txn.conversationId) {
      throw new Error(
        `appendSubagentTerminalMemory: conversation mismatch ` +
          `txn=${txn.conversationId} run=${run.conversationId}`
      )
    }
    if (run.status === "running" || run.terminalAt === undefined) {
      throw new Error(
        `appendSubagentTerminalMemory: run is not terminal ` +
          `conversation=${run.conversationId} ` +
          `agentId=${run.agentId}`
      )
    }

    const sourceEventId = buildSubAgentMemorySourceEventId(run.agentId)
    const artifact = requireCanonicalSubagentCompletionArtifact(run)

    this.sessionMemoryEvents.appendInTransaction(txn, {
      conversationId: txn.conversationId,
      sourceEventId,
      sourceToolUseId,
      sourceRecordUuid,
      sourceKind,
      payload: artifact.payload,
      weight: run.status === "completed" ? 96 : 80,
      createdAt: run.terminalAt,
    })
  }

  /**
   * Claim and bind each terminal delivery to its exact graph route. The
   * caller supplies only an identity and route; terminal facts and memory are
   * always derived from the durable run inside this transaction.
   */
  private commitSubagentTerminalDeliveriesInTransaction(
    txn: SessionTxn,
    commits: readonly SubagentTerminalGraphCommit[],
    appendedToolResults: ReadonlyMap<string, PersistedMessage>,
    appendedMessages: readonly PersistedMessage[]
  ): boolean {
    const seenAgentIds = new Set<string>()
    for (const graphCommit of commits) {
      const commit = graphCommit.delivery
      if (seenAgentIds.has(commit.agentId)) {
        throw new Error(
          `commitSubagentTerminalDeliveriesInTransaction: duplicate agent ` +
            `conversation=${txn.conversationId} agentId=${commit.agentId}`
        )
      }
      seenAgentIds.add(commit.agentId)

      if (graphCommit.outcome) {
        if (commit.route !== "parent_task_result") {
          throw new Error(
            `commitSubagentTerminalDeliveriesInTransaction: terminal state ` +
              `transition requires parent task route conversation=${txn.conversationId} ` +
              `agentId=${commit.agentId}`
          )
        }
        const terminal =
          this.subagentRunStore.markTerminalIfRunningInTransaction(
            txn,
            commit.agentId,
            graphCommit.outcome
          )
        if (terminal.kind !== "transitioned") {
          throw new Error(
            `commitSubagentTerminalDeliveriesInTransaction: terminal ` +
              `transition failed conversation=${txn.conversationId} ` +
              `agentId=${commit.agentId} state=${terminal.kind}`
          )
        }
      }

      const delivery = this.subagentRunStore.claimTerminalDeliveryInTransaction(
        txn,
        commit.agentId
      )
      if (delivery.kind !== "claimed") {
        throw new Error(
          `commitSubagentTerminalDeliveriesInTransaction: delivery was not ` +
            `claimable conversation=${txn.conversationId} ` +
            `agentId=${commit.agentId} state=${delivery.kind}`
        )
      }
      const run = delivery.run
      let sourceToolUseId: string
      let source: PersistedMessage | undefined
      let sourceKind: Extract<
        SessionMemorySourceKind,
        "tool_result" | "control_notification"
      >

      if (commit.route === "parent_task_result") {
        if (commit.sourceToolUseId !== run.parentToolCallId) {
          throw new Error(
            `commitSubagentTerminalDeliveriesInTransaction: parent task ` +
              `identity mismatch conversation=${txn.conversationId} ` +
              `agentId=${run.agentId}`
          )
        }
        sourceToolUseId = commit.sourceToolUseId
        source = appendedToolResults.get(sourceToolUseId)
        sourceKind = "tool_result"
      } else if (commit.route === "await_task_result") {
        if (run.mode !== "background") {
          throw new Error(
            `commitSubagentTerminalDeliveriesInTransaction: await_task cannot ` +
              `deliver foreground run conversation=${txn.conversationId} ` +
              `agentId=${run.agentId}`
          )
        }
        sourceToolUseId = commit.sourceToolUseId
        source = appendedToolResults.get(sourceToolUseId)
        sourceKind = "tool_result"
        this.assertBackgroundSubagentAwaitResultSource(
          txn,
          run,
          sourceToolUseId
        )
      } else {
        if (
          run.mode !== "background" ||
          commit.parentToolCallId !== run.parentToolCallId
        ) {
          throw new Error(
            `commitSubagentTerminalDeliveriesInTransaction: control owner ` +
              `mismatch conversation=${txn.conversationId} ` +
              `agentId=${run.agentId}`
          )
        }
        sourceToolUseId = commit.parentToolCallId
        const matches = appendedMessages.filter((message) =>
          this.isExactSubagentControlNotificationSource(message, commit, run)
        )
        if (matches.length !== 1) {
          throw new Error(
            `commitSubagentTerminalDeliveriesInTransaction: control delivery ` +
              `requires one exact notification conversation=${txn.conversationId} ` +
              `agentId=${run.agentId} matches=${matches.length}`
          )
        }
        source = matches[0]
        sourceKind = "control_notification"
      }

      if (!source) {
        throw new Error(
          `commitSubagentTerminalDeliveriesInTransaction: graph source is ` +
            `missing conversation=${txn.conversationId} ` +
            `agentId=${run.agentId} route=${commit.route}`
        )
      }
      const artifact = requireCanonicalSubagentCompletionArtifact(run)
      if (
        sourceKind === "tool_result" &&
        this.readExactToolResultText(source, sourceToolUseId) !==
          artifact.report
      ) {
        throw new Error(
          `commitSubagentTerminalDeliveriesInTransaction: graph source does ` +
            `not contain the canonical terminal report ` +
            `conversation=${txn.conversationId} agentId=${run.agentId} ` +
            `route=${commit.route}`
        )
      }
      this.appendSubagentTerminalMemory(
        txn,
        run,
        sourceToolUseId,
        source.uuid,
        sourceKind
      )
    }
    return commits.length > 0
  }

  private isExactSubagentControlNotificationSource(
    message: PersistedMessage,
    expected: Extract<
      SubagentTerminalDeliveryCommit,
      { route: "control_notification" }
    >,
    run: SubagentRunRecord
  ): boolean {
    const artifact = requireCanonicalSubagentCompletionArtifact(run)
    if (
      message.role !== "user" ||
      message.metadata?.source !== "cursor_control_continuation" ||
      !message.content.some(
        (block) => block.type === "text" && block.text.includes(artifact.report)
      )
    ) {
      return false
    }
    const commits = message.metadata.subagentTerminalDeliveries
    try {
      return decodeSubagentTerminalDeliveries(commits).some(
        (candidate) =>
          candidate.route === "control_notification" &&
          candidate.agentId === expected.agentId &&
          candidate.parentToolCallId === expected.parentToolCallId
      )
    } catch {
      return false
    }
  }

  private commitBackgroundShellTerminalDeliveriesInTransaction(
    txn: SessionTxn,
    deliveries: readonly BackgroundShellCompletionIdentity[],
    appendedMessages: readonly PersistedMessage[]
  ): void {
    if (deliveries.length === 0) return
    const seen = new Set<string>()
    for (const delivery of deliveries) {
      const key = `${delivery.commandId}\n${delivery.originToolCallId}`
      if (seen.has(key)) {
        throw new Error(
          `ContextStateService: duplicate background shell delivery ${delivery.commandId}`
        )
      }
      seen.add(key)
      const source = appendedMessages.find((message) =>
        this.isExactBackgroundShellControlNotificationSource(message, delivery)
      )
      if (!source) {
        throw new Error(
          `ContextStateService: background shell delivery has no exact control source ` +
            `commandId=${delivery.commandId}`
        )
      }
      this.backgroundCommandStore.markDeliveredInTransaction(
        txn,
        delivery,
        source.uuid
      )
    }
  }

  private isExactBackgroundShellControlNotificationSource(
    message: PersistedMessage,
    expected: BackgroundShellCompletionIdentity
  ): boolean {
    if (message.role !== "user") return false
    const ownsToolResult = message.content.some(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id === expected.originToolCallId
    )
    if (ownsToolResult) {
      return true
    }
    if (message.metadata?.source !== "cursor_control_continuation") return false
    const raw = message.metadata.backgroundShellTerminalDeliveries
    if (!Array.isArray(raw)) return false
    const ownsDelivery = raw.some(
      (candidate) =>
        !!candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).commandId ===
          expected.commandId &&
        (candidate as Record<string, unknown>).originToolCallId ===
          expected.originToolCallId
    )
    return ownsDelivery
  }

  private readExactToolResultText(
    message: PersistedMessage,
    toolUseId: string
  ): string | undefined {
    const block = message.content.find(
      (candidate) =>
        candidate.type === "tool_result" && candidate.tool_use_id === toolUseId
    )
    if (!block || block.type !== "tool_result") return undefined
    if (typeof block.content === "string") return block.content
    if (!Array.isArray(block.content)) return undefined
    const texts = block.content.filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    return texts.length === 1 && texts.length === block.content.length
      ? texts[0]!.text
      : undefined
  }

  /** Bind a delivered background run to the exact await_task invocation. */
  private assertBackgroundSubagentAwaitResultSource(
    txn: SessionTxn,
    run: SubagentRunRecord,
    sourceToolUseId: string
  ): void {
    const source = this.messageStore.getToolUseMessage(
      txn.conversationId,
      sourceToolUseId
    )
    const toolUse = source?.content.find(
      (block) => block.type === "tool_use" && block.id === sourceToolUseId
    )
    if (
      !toolUse ||
      toolUse.type !== "tool_use" ||
      toolUse.name !== "await_task" ||
      !toolUse.input ||
      typeof toolUse.input !== "object" ||
      Array.isArray(toolUse.input) ||
      toolUse.input.task_id !== run.agentId
    ) {
      throw new Error(
        `assertBackgroundSubagentAwaitResultSource: result is not the exact ` +
          `await_task owner conversation=${txn.conversationId} ` +
          `agentId=${run.agentId} toolUseId=${sourceToolUseId}`
      )
    }
  }

  /**
   * Construct the complete next mounted projection before SQLite commits.
   * Any graph/projection invariant failure therefore rolls the durable write
   * back; after commit, applying the prepared value cannot report the accepted
   * graph fact as failed.
   */
  private prepareMountedGraphProjection(
    conversationId: ConversationId,
    ctx: ContextStateRecord,
    owner: ProjectionOwner,
    projectedMessages: SessionMessage[],
    options: {
      toolUseResult?: unknown
      refreshSessionMemory?: boolean
      childSnapshot?: SubagentProjectionBranchSnapshot
      allowChildProjectionCreate?: boolean
    } = {}
  ): PreparedMountedGraphProjection | undefined {
    if (projectedMessages.length === 0) return undefined
    assertProjectionOwner(owner, "prepareMountedGraphProjection")
    if (owner.conversationId !== conversationId) {
      throw new Error(
        `prepareMountedGraphProjection: owner conversation mismatch ` +
          `owner=${owner.conversationId} context=${conversationId}`
      )
    }
    const existing =
      owner.kind === "main"
        ? ctx.mainProjection
        : ctx.childProjections.get(owner.ownerKey)
    const base =
      existing ?? this.createInitialChildMountedProjection(owner, options)
    assertSameProjectionOwner(
      owner,
      base.owner,
      "prepareMountedGraphProjection"
    )
    this.assertMountedProjectionMessageOwnership(base)
    if (owner.kind === "main") {
      if (options.childSnapshot) {
        throw new Error(
          "prepareMountedGraphProjection: main projection cannot receive a child snapshot"
        )
      }
      if (projectedMessages.some((message) => message.isSidechain === true)) {
        throw new Error(
          `prepareMountedGraphProjection: main projection cannot receive sidechain fragments ` +
            `conversation=${conversationId}`
        )
      }
    } else {
      if (!options.childSnapshot) {
        throw new Error(
          `prepareMountedGraphProjection: child append has no durable branch snapshot ` +
            `conversation=${conversationId} owner=${owner.ownerKey}`
        )
      }
      if (options.refreshSessionMemory) {
        throw new Error(
          "prepareMountedGraphProjection: child projection cannot mutate parent session memory"
        )
      }
      this.assertProjectedMessagesBelongToOwner(owner, projectedMessages)
    }

    if (options.toolUseResult !== undefined) {
      const lastProjected = projectedMessages.at(-1)
      if (lastProjected?.type === "user") {
        lastProjected.toolUseResult = options.toolUseResult
      }
    }

    const records = projectedMessages.map((projected) => {
      const createdAt = Date.parse(projected.timestamp)
      return this.sessionLifecycle.createTranscriptRecord(
        projected,
        Number.isFinite(createdAt) ? createdAt : Date.now()
      )
    })
    const nextMessageRecords = [...base.messageRecords, ...records]
    const nextContextState = structuredClone(base.contextState)
    this.sessionLifecycle.syncContextRecordsFromMessageRecords(
      nextContextState,
      nextMessageRecords
    )
    if (options.refreshSessionMemory) {
      nextContextState.sessionMemory =
        this.sessionMemoryEvents.listMaterialized(conversationId)
    }

    const transcriptEvents = [...base.transcriptEvents]
    let nextTranscriptEventSeq = base.nextTranscriptEventSeq || 1
    for (let index = 0; index < records.length; index++) {
      const events = this.sessionLifecycle.buildTranscriptEventsForRecord(
        records[index]!,
        nextTranscriptEventSeq
      )
      transcriptEvents.push(...events)
      nextTranscriptEventSeq += events.length
    }

    const contentStr = safeJsonStringify(
      projectedMessages.map((projected) => projected.message.content),
      {
        maxDepth: 8,
        maxArrayItems: 200,
        maxObjectKeys: 100,
        maxStringLength: 8 * 1024,
      }
    )
    const projection: MountedContextProjection = {
      owner,
      messages: [...base.messages, ...projectedMessages],
      generation: base.generation + projectedMessages.length,
      messageRecords: nextMessageRecords,
      transcriptEvents,
      nextTranscriptEventSeq,
      contextState: nextContextState,
      usedTokens: base.usedTokens + Math.ceil(contentStr.length / 4),
      ...(owner.kind === "subagent"
        ? { branchSnapshot: options.childSnapshot! }
        : {}),
    }
    return {
      mount: this.prepareMountedProjectionInstallForContext(
        conversationId,
        ctx,
        projection
      ),
      flushImmediately: projectedMessages.some((projected) =>
        this.sessionLifecycle.shouldFlushMessageImmediately(projected)
      ),
    }
  }

  private applyPreparedMountedGraphProjection(
    prepared: PreparedMountedGraphProjection
  ): void {
    this.applyPreparedMountedProjectionInstall(prepared.mount)
  }

  private createInitialChildMountedProjection(
    owner: ProjectionOwner,
    options: {
      childSnapshot?: SubagentProjectionBranchSnapshot
      allowChildProjectionCreate?: boolean
    }
  ): MountedContextProjection {
    if (owner.kind !== "subagent" || !options.allowChildProjectionCreate) {
      throw new Error(
        `prepareMountedGraphProjection: projection is not mounted ` +
          `conversation=${owner.conversationId} owner=${owner.ownerKey}`
      )
    }
    if (!options.childSnapshot) {
      throw new Error(
        "prepareMountedGraphProjection: initial child projection has no branch snapshot"
      )
    }
    return {
      owner,
      messages: [],
      generation: 0,
      messageRecords: [],
      transcriptEvents: [],
      nextTranscriptEventSeq: 1,
      contextState: this.sessionLifecycle.createContextState([]),
      usedTokens: 0,
      branchSnapshot: options.childSnapshot,
    }
  }

  private assertProjectedMessagesBelongToOwner(
    owner: SubagentProjectionOwner,
    messages: readonly SessionMessage[]
  ): void {
    for (const message of messages) {
      if (
        message.isSidechain !== true ||
        message.agentId !== owner.agentId ||
        message.threadId !== owner.threadId ||
        message.branchId !== owner.branchId ||
        message.forkSourceUuid !== owner.forkSourceUuid ||
        !this.equalStringArrays(message.forkLineage, owner.forkLineage)
      ) {
        throw new Error(
          `prepareMountedGraphProjection: sidechain fragment does not match owner ` +
            `conversation=${owner.conversationId} owner=${owner.ownerKey} uuid=${message.uuid}`
        )
      }
    }
  }

  /** Refreshes the runtime materialization after a standalone lifecycle event. */
  refreshSessionMemory(conversationId: string): void {
    const ctx = this.contextRecords.get(conversationId)
    if (!ctx) {
      throw new Error(
        `ContextStateService.refreshSessionMemory: missing context ${conversationId}`
      )
    }
    ctx.mainProjection.contextState.sessionMemory =
      this.sessionMemoryEvents.listMaterialized(
        ConversationId.of(conversationId)
      )
  }

  /**
   * Atomically terminate runtime tool edges and append their canonical abort
   * results, then advance the mounted main-graph projection from those exact
   * committed UUIDs. Cleanup must use this owner instead of writing
   * MessageStore directly, otherwise Claude can observe a durable graph head
   * that its mounted projection has never seen.
   */
  abortOpenGraphToolCalls(
    conversationId: ConversationId,
    input:
      | {
          turnId: TurnId
          reason: AbortReason
          toolUseIds?: undefined
        }
      | {
          turnId?: TurnId
          reason: AbortReason
          toolUseIds: readonly string[]
        }
  ): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if ((!session && ctx) || (session && !ctx)) {
      throw new Error(
        `abortOpenGraphToolCalls: mounted session graph is incomplete for ${conversationId}`
      )
    }
    const appended: GraphAppendFragment[] = []
    const appendedPersisted: PersistedMessage[] = []
    let aborted: Array<{ toolUseId: string; turnId?: TurnId }> = []
    const preparedProjections: PreparedMountedGraphProjection[] = []
    const childProjectionInputs = new Map<
      string,
      {
        owner: SubagentProjectionOwner
        snapshot: SubagentProjectionBranchSnapshot
        messages: SessionMessage[]
      }
    >()
    let appendedMemoryEvent = false
    const cancelledDispatches = [] as ReturnType<
      ExecDispatchStore["findActiveByToolCall"]
    >
    this.messageStore.runInTransaction(conversationId, (txn) => {
      aborted = input.toolUseIds
        ? this.toolCallLedger.abortOpenToolCalls(txn, {
            toolUseIds: [...input.toolUseIds],
            reason: input.reason,
          }).abortedToolCallIds
        : this.toolCallLedger.abortAll(txn, {
            turnId: input.turnId,
            reason: input.reason,
          }).abortedToolCallIds
      for (const entry of aborted) {
        const graphTurnId = entry.turnId ?? input.turnId
        if (!graphTurnId) {
          throw new Error(
            `abortOpenGraphToolCalls: selected runtime tool call has no graph turn ` +
              `conversation=${conversationId} toolUseId=${entry.toolUseId}`
          )
        }
        const toolUseSource = this.messageStore.getToolUseMessage(
          txn.conversationId,
          entry.toolUseId
        )
        const sidechainAbortPlan = toolUseSource?.isSidechain
          ? this.subagentBranchStore.prepareAppendInTransaction(txn, {
              kind: "abort",
              source: toolUseSource,
            })
          : undefined
        const sidechainOwner = sidechainAbortPlan
          ? this.subagentBranchStore.createProjectionOwner(
              sidechainAbortPlan.branch
            )
          : undefined
        if (ctx && sidechainOwner) {
          this.assertMountedProjectionCurrent(conversationId, sidechainOwner)
        }
        const subagentRun = this.subagentRunStore.getByParentToolCallId(
          conversationId,
          entry.toolUseId
        )
        let graphCommit: SubagentTerminalGraphCommit | undefined
        let terminalReport: string | undefined
        if (subagentRun) {
          if (subagentRun.deliveryState !== "pending") {
            throw new Error(
              `abortOpenGraphToolCalls: open parent task belongs to an already ` +
                `delivered sub-agent conversation=${conversationId} ` +
                `agentId=${subagentRun.agentId}`
            )
          }
          if (subagentRun.status === "running") {
            const terminalAt = Date.now()
            const errorMessage = `Sub-agent execution aborted: ${input.reason}`
            const outcome: TerminalizeSubagentRunInput = {
              status: "interrupted",
              terminalAt,
              errorMessage,
              terminalFacts: { modifiedFiles: [], evidence: [] },
            }
            const artifact = createSubAgentCompletionArtifact({
              agentId: subagentRun.agentId,
              agentType: subagentRun.agentType,
              status: outcome.status,
              durationMs: Math.max(0, terminalAt - subagentRun.startedAt),
              resultText: errorMessage,
              task: subagentRun.description,
              modifiedFiles: [],
              evidence: [],
            })
            terminalReport = artifact.report
            graphCommit = {
              delivery: {
                agentId: subagentRun.agentId,
                route: "parent_task_result",
                sourceToolUseId: entry.toolUseId,
              },
              outcome,
            }
          } else {
            terminalReport =
              requireCanonicalSubagentCompletionArtifact(subagentRun).report
            graphCommit = {
              delivery: {
                agentId: subagentRun.agentId,
                route: "parent_task_result",
                sourceToolUseId: entry.toolUseId,
              },
            }
          }
        }
        const result = this.messageStore.appendAbortToolResultBlock(
          txn,
          terminalReport
            ? {
                type: "tool_result",
                tool_use_id: entry.toolUseId,
                content: terminalReport,
                is_error: subagentRun?.status !== "completed",
              }
            : ToolCallLedger.buildAbortToolResult(
                entry.toolUseId,
                input.reason
              ),
          { turnId: graphTurnId }
        )
        appended.push({
          recordId: result.recordUuid,
          messageSeq: result.seq,
        })
        appendedPersisted.push(result.message)
        if (sidechainAbortPlan) {
          this.subagentBranchStore.advanceInTransaction(
            txn,
            sidechainAbortPlan,
            [result.message]
          )
          if (ctx && sidechainOwner) {
            const snapshot =
              this.subagentBranchStore.readProjectionBranchSnapshot(
                sidechainOwner
              )
            const projected = projectPersistedMessageToSessionMessage(
              result.message
            )
            const existing = childProjectionInputs.get(sidechainOwner.ownerKey)
            if (existing) {
              assertSameProjectionOwner(
                existing.owner,
                sidechainOwner,
                "abortOpenGraphToolCalls"
              )
              existing.messages.push(projected)
              existing.snapshot = snapshot
            } else {
              childProjectionInputs.set(sidechainOwner.ownerKey, {
                owner: sidechainOwner,
                snapshot,
                messages: [projected],
              })
            }
          }
        }
        if (graphCommit) {
          appendedMemoryEvent =
            this.commitSubagentTerminalDeliveriesInTransaction(
              txn,
              [graphCommit],
              new Map([[entry.toolUseId, result.message]]),
              [result.message]
            ) || appendedMemoryEvent
        }
        for (const dispatch of this.execDispatchStore.findActiveByToolCall(
          conversationId,
          entry.toolUseId
        )) {
          cancelledDispatches.push(
            this.execDispatchStore.cancelExactInTransaction(
              txn,
              dispatch.streamEpoch,
              dispatch.execId,
              dispatch.protocolExecId,
              `graph_abort:${input.reason}`
            )
          )
        }
      }
      if (ctx) {
        const projectedMainMessages = appendedPersisted
          .filter((persisted) => persisted.isSidechain !== true)
          .map((persisted) =>
            projectPersistedMessageToSessionMessage(persisted)
          )
        const preparedMainProjection = this.prepareMountedGraphProjection(
          conversationId,
          ctx,
          createMainProjectionOwner(conversationId),
          projectedMainMessages,
          { refreshSessionMemory: appendedMemoryEvent }
        )
        if (preparedMainProjection) {
          preparedProjections.push(preparedMainProjection)
        }
        for (const child of childProjectionInputs.values()) {
          const preparedChildProjection = this.prepareMountedGraphProjection(
            conversationId,
            ctx,
            child.owner,
            child.messages,
            { childSnapshot: child.snapshot }
          )
          if (preparedChildProjection) {
            preparedProjections.push(preparedChildProjection)
          }
        }
      }
    })
    const cancelledExecIdsByEpoch = new Map<string, number[]>()
    for (const dispatch of cancelledDispatches) {
      const ids = cancelledExecIdsByEpoch.get(dispatch.streamEpoch) ?? []
      ids.push(dispatch.execId)
      cancelledExecIdsByEpoch.set(dispatch.streamEpoch, ids)
    }
    for (const [streamEpoch, execIds] of cancelledExecIdsByEpoch) {
      this.execDispatchSerializer.cancelCommitted(
        String(conversationId),
        streamEpoch,
        execIds
      )
    }
    if (appended.length === 0) return 0
    if (!session && !ctx) {
      // A teardown may finish after the live registries are gone. Recovery
      // will load the committed graph before any later projection is built.
      return appended.length
    }
    if (preparedProjections.length > 0) {
      for (const preparedProjection of preparedProjections) {
        this.applyPreparedMountedGraphProjection(preparedProjection)
      }
      session!.lastActivityAt = new Date()
      this.sessionLifecycle.schedulePersist(conversationId)
    }
    return appended.length
  }

  /**
   * Append an immutable revision that enriches a persisted tool_result. The
   * active projection is rebuilt from that revision immediately; the base
   * graph fragment is never overwritten.
   */
  mergeToolResultStructuredContent(
    conversationId: string,
    toolUseId: string,
    patch: Record<string, unknown>
  ): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx) {
      throw new Error(
        `mergeToolResultStructuredContent: missing active session ${conversationId}`
      )
    }
    requireExactDurableIdentifier(
      toolUseId,
      "mergeToolResultStructuredContent: toolUseId"
    )

    const index = ctx.mainProjection.messages.findIndex((message) =>
      message.type === "user" && Array.isArray(message.message.content)
        ? message.message.content.some(
            (block) =>
              block.type === "tool_result" && block.tool_use_id === toolUseId
          )
        : false
    )
    if (index < 0) return false

    const target = ctx.mainProjection.messages[index]!
    const targetBlock = Array.isArray(target.message.content)
      ? target.message.content.find(
          (block) =>
            block.type === "tool_result" && block.tool_use_id === toolUseId
        )
      : undefined
    if (!targetBlock || targetBlock.type !== "tool_result") {
      throw new Error(
        `mergeToolResultStructuredContent: target projection drifted for ` +
          `conversation=${conversationId} toolUseId=${toolUseId}`
      )
    }
    const existing =
      targetBlock.structuredContent &&
      typeof targetBlock.structuredContent === "object" &&
      !Array.isArray(targetBlock.structuredContent)
        ? targetBlock.structuredContent
        : {}
    const payload = {
      toolUseId,
      structuredContent: structuredClone({ ...existing, ...patch }),
    }
    const revision = this.messageStore.runInTransaction(
      ConversationId.of(conversationId),
      (txn) =>
        this.messageStore.appendMessageRevision(txn, {
          messageUuid: target.uuid,
          revisionKind: TOOL_RESULT_STRUCTURED_CONTENT_REVISION,
          payload,
        })
    )
    this.applyProjectionRevision(ctx, index, revision)
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return true
  }

  /**
   * Resolve one queued ask as a single durable transaction: the lifecycle CAS
   * and the immutable tool_result revision either both commit or both roll
   * back. The mounted graph is then advanced from the exact revision receipt.
   */
  resolveAsyncAskQuestion(
    conversationId: string,
    toolUseId: string,
    resolution: AsyncAskQuestionResolution
  ): AcceptAsyncAskQuestionResolutionResult {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx) {
      throw new Error(
        `resolveAsyncAskQuestion: missing active session ${conversationId}`
      )
    }
    const interaction = this.asyncUserInteractions.get(
      conversationId,
      toolUseId
    )
    if (!interaction) return { kind: "missing" }
    const index = ctx.mainProjection.messages.findIndex(
      (message) => message.uuid === interaction.sourceMessageUuid
    )
    if (index < 0) {
      throw new Error(
        `resolveAsyncAskQuestion: source message is not mounted ` +
          `conversation=${conversationId} toolUseId=${toolUseId} ` +
          `uuid=${interaction.sourceMessageUuid}`
      )
    }

    let revision: ReturnType<MessageStore["appendMessageRevision"]> | undefined
    const result = this.messageStore.runInTransaction(
      ConversationId.of(conversationId),
      (txn) => {
        const accepted =
          this.asyncUserInteractions.acceptResolutionInTransaction(
            txn,
            toolUseId,
            resolution
          )
        if (accepted.kind !== "accepted") return accepted
        const payload = this.buildAsyncAskQuestionResolutionRevisionPayload(
          toolUseId,
          accepted.interaction.resolution!
        )
        revision = this.messageStore.appendMessageRevision(txn, {
          messageUuid: accepted.interaction.sourceMessageUuid,
          revisionKind: ASYNC_TOOL_RESULT_RESOLUTION_REVISION,
          payload,
        })
        // Validate the exact projection transform before the transaction
        // commits. The post-commit step below is then only an ownership
        // transfer over already-validated values.
        applyMessageRevisionProjection(ctx.mainProjection.messages[index]!, [
          revision,
        ])
        return accepted
      }
    )
    if (result.kind === "accepted") {
      this.applyProjectionRevision(ctx, index, revision!)
      session.lastActivityAt = new Date()
      this.sessionLifecycle.schedulePersist(conversationId)
    }
    return result
  }

  private buildAsyncAskQuestionResolutionRevisionPayload(
    toolUseId: string,
    resolution: AsyncAskQuestionResolution
  ): Record<string, unknown> {
    switch (resolution.resultCase) {
      case "success": {
        const answers = resolution.answers.map((answer) => ({
          questionId: answer.questionId,
          selectedOptionIds: [...answer.selectedOptionIds],
          ...(answer.freeformText ? { freeformText: answer.freeformText } : {}),
        }))
        return {
          toolUseId,
          content:
            answers.length > 0
              ? `[ask_question success] ${JSON.stringify(answers)}`
              : "[ask_question success]",
          isError: false,
          structuredContent: {
            toolResultState: { status: "success" },
            askQuestionResult: {
              resultCase: "success",
              answers,
            },
          },
        }
      }
      case "rejected":
        return {
          toolUseId,
          content: `[ask_question rejected] ${resolution.rejectedReason}`,
          isError: false,
          structuredContent: {
            toolResultState: {
              status: "rejected",
              message: resolution.rejectedReason,
            },
            askQuestionResult: {
              resultCase: "rejected",
              reason: resolution.rejectedReason,
            },
          },
        }
      case "error":
        return {
          toolUseId,
          content: `[ask_question error] ${resolution.errorMessage}`,
          isError: true,
          structuredContent: {
            toolResultState: {
              status: "error",
              message: resolution.errorMessage,
            },
            askQuestionResult: {
              resultCase: "error",
              errorMessage: resolution.errorMessage,
            },
          },
        }
    }
  }

  /**
   * Keep accepted graph fragments available to audit/replay while excluding
   * them from future provider prompts. Every requested UUID must refer to the
   * active graph projection; callers cannot silently exclude a guessed row.
   */
  excludeGraphMessagesFromProviderProjection(
    conversationId: string,
    messageUuids: readonly string[],
    reason: string
  ): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session || !ctx) {
      throw new Error(
        `excludeGraphMessagesFromProviderProjection: missing active session ${conversationId}`
      )
    }
    const normalizedReason = reason.trim()
    if (!normalizedReason) {
      throw new Error(
        "excludeGraphMessagesFromProviderProjection: reason is required"
      )
    }
    const targets = [
      ...new Set(
        messageUuids.map((uuid) =>
          requireExactDurableIdentifier(
            uuid,
            "excludeGraphMessagesFromProviderProjection: message UUID"
          )
        )
      ),
    ]
    const indexes = targets.map((uuid) => {
      const index = ctx.mainProjection.messages.findIndex(
        (message) => message.uuid === uuid
      )
      if (index < 0) {
        throw new Error(
          `excludeGraphMessagesFromProviderProjection: unknown active graph ` +
            `fragment conversation=${conversationId} uuid=${uuid}`
        )
      }
      return index
    })
    const pendingIndexes = indexes.filter(
      (index) =>
        !ctx.mainProjection.messages[index]!.excludedFromProviderProjection
    )
    if (pendingIndexes.length === 0) return 0

    const revisions = this.messageStore.runInTransaction(
      ConversationId.of(conversationId),
      (txn) =>
        pendingIndexes.map((index) =>
          this.messageStore.appendMessageRevision(txn, {
            messageUuid: ctx.mainProjection.messages[index]!.uuid,
            revisionKind: PROVIDER_PROJECTION_EXCLUSION_REVISION,
            payload: { reason: normalizedReason },
          })
        )
    )
    for (let index = 0; index < pendingIndexes.length; index++) {
      this.applyProjectionRevision(
        ctx,
        pendingIndexes[index]!,
        revisions[index]!
      )
    }
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return pendingIndexes.length
  }

  private applyProjectionRevision(
    ctx: ContextStateRecord,
    messageIndex: number,
    revision: Parameters<typeof applyMessageRevisionProjection>[1][number]
  ): void {
    const current = ctx.mainProjection.messages[messageIndex]
    if (!current) {
      throw new Error(
        `applyProjectionRevision: missing message at index ${messageIndex}`
      )
    }
    const projected = applyMessageRevisionProjection(current, [revision])
    const existingRecord = ctx.mainProjection.messageRecords[messageIndex]
    const createdAt = existingRecord?.createdAt ?? Date.parse(current.timestamp)
    const record = this.sessionLifecycle.createTranscriptRecord(
      projected,
      Number.isFinite(createdAt) ? createdAt : Date.now()
    )
    ctx.mainProjection.messages = ctx.mainProjection.messages.map(
      (message, index) => (index === messageIndex ? projected : message)
    )
    ctx.mainProjection.messageRecords = ctx.mainProjection.messageRecords.map(
      (currentRecord, index) =>
        index === messageIndex ? record : currentRecord
    )
    ctx.mainProjection.generation += 1
    this.sessionLifecycle.syncContextRecordsFromMessageRecords(
      ctx.mainProjection.contextState,
      ctx.mainProjection.messageRecords
    )
  }

  private resolveGraphTurnId(
    conversationId: ConversationId,
    explicitTurnId?: TurnId | string
  ): TurnId {
    if (explicitTurnId) return explicitTurnId as TurnId
    const activeTurnId =
      this.sessionLifecycle.getActiveGraphTurnId(conversationId)
    if (activeTurnId) return activeTurnId
    throw new Error(
      `appendGraphMessage: no active graph turn for conversation=${conversationId}`
    )
  }

  /**
   * Final provider metadata is appended as a message revision. The active
   * projection may update its display copy, but the accepted fragment itself
   * is never rewritten in SQLite.
   */
  mutateLastAssistantUsage(
    conversationId: string,
    usage: ContextUsageSnapshot | undefined,
    stopReason?: string | null
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    const last =
      ctx!.mainProjection.messages[ctx!.mainProjection.messages.length - 1]
    if (!last || last.type !== "assistant") return
    if (usage) last.message.usage = usage
    if (typeof stopReason !== "undefined") last.message.stop_reason = stopReason
    const persisted = this.messageStore
      .getMessages(ConversationId.of(conversationId))
      .filter((message) => message.role === "assistant")
      .at(-1)
    if (persisted) {
      this.messageStore.runInTransaction(
        ConversationId.of(conversationId),
        (txn) => {
          this.messageStore.appendMessageRevision(txn, {
            messageUuid: persisted.uuid,
            revisionKind: "provider_finalization",
            payload: {
              ...(usage ? { usage } : {}),
              ...(typeof stopReason !== "undefined" ? { stopReason } : {}),
            },
          })
        }
      )
    }
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  /**
   * Add blobId to session's message history
   * This is used for building conversationCheckpointUpdate
   */
  addMessageBlobId(conversationId: string, blobId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.messageBlobIds.push(blobId)
      this.logger.log(
        `>>> Added blobId to session ${conversationId}: ${blobId.substring(0, 20)}... (total: ${ctx!.messageBlobIds.length})`
      )
      this.sessionLifecycle.schedulePersist(conversationId)
    } else {
      this.logger.error(
        `>>> FAILED to add blobId - session not found: ${conversationId}`
      )
    }
  }
  /**
   * Add a new turn to the session
   * Turns are cumulative identifiers for each conversation round
   */
  addTurn(conversationId: string, turnId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.turns.push(turnId)
      this.logger.log(
        `>>> Added turn ${ctx!.turns.length} to session ${conversationId}: ${turnId.substring(0, 20)}...`
      )
      this.sessionLifecycle.schedulePersist(conversationId)
    } else {
      this.logger.error(
        `>>> FAILED to add turn - session not found: ${conversationId}`
      )
    }
  }
  /**
   * Set current assistant message being built
   */
  setCurrentAssistantMessage(
    conversationId: string,
    message: Record<string, unknown>
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.currentAssistantMessage = message
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  /**
   * Clear current assistant message
   */
  clearCurrentAssistantMessage(conversationId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      ctx!.currentAssistantMessage = undefined
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }

  /**
   * File-state keys are already admitted by WorkspaceScope before they reach
   * context state. Preserve those exact canonical strings: whitespace may be
   * a legitimate first or final character of a filesystem component.
   */
  private preserveTrackedFilePath(value: unknown): string | undefined {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000")
    ) {
      return undefined
    }
    return value
  }

  /**
   * Track file read operation
   */
  addReadPath(conversationId: string, filePath: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    const canonicalPath = this.preserveTrackedFilePath(filePath)
    if (session && canonicalPath) {
      session.lastActivityAt = new Date()
      ctx!.readPaths.add(canonicalPath)
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  addReadSnapshot(
    conversationId: string,
    snapshot: Omit<SessionReadSnapshot, "capturedAt">
  ): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return false

    const filePath = this.preserveTrackedFilePath(snapshot.filePath)
    if (!filePath || typeof snapshot.content !== "string") {
      return false
    }
    if (
      snapshot.content.length === 0 ||
      snapshot.content.length > this.MAX_READ_SNAPSHOT_CHARS
    ) {
      return false
    }

    const nextSnapshot: SessionReadSnapshot = {
      filePath,
      startLine:
        typeof snapshot.startLine === "number" &&
        Number.isFinite(snapshot.startLine)
          ? Math.max(1, Math.floor(snapshot.startLine))
          : undefined,
      endLine:
        typeof snapshot.endLine === "number" &&
        Number.isFinite(snapshot.endLine)
          ? Math.max(1, Math.floor(snapshot.endLine))
          : undefined,
      content: snapshot.content,
      capturedAt: Date.now(),
      sourceToolName:
        typeof snapshot.sourceToolName === "string" &&
        snapshot.sourceToolName.trim().length > 0
          ? snapshot.sourceToolName.trim()
          : "read_file",
    }

    // Best-effort disk stat: capture mtime+size so getLatestReadSnapshot can
    // detect external disk writes between two read_file calls in the same
    // session (e.g. a shell script overwriting a smoke fixture). statSync
    // is sync but cheap on a single file path; failures (relative paths,
    // virtual sources, missing files) are silently dropped — the snapshot
    // will simply skip the staleness check on the read side.
    if (path.isAbsolute(filePath)) {
      try {
        const stat = fs.statSync(filePath)
        nextSnapshot.diskMtimeMs = stat.mtimeMs
        nextSnapshot.diskSizeBytes = stat.size
      } catch {
        // file not stat-able from bridge process; leave fields undefined.
      }
    }

    const withoutSameWindow = ctx!.readSnapshots.filter((existing) => {
      return !(
        existing.filePath === nextSnapshot.filePath &&
        existing.startLine === nextSnapshot.startLine &&
        existing.endLine === nextSnapshot.endLine &&
        existing.sourceToolName === nextSnapshot.sourceToolName
      )
    })

    const sameFileSnapshots = withoutSameWindow.filter(
      (existing) => existing.filePath === nextSnapshot.filePath
    )
    const overflowForFile = Math.max(
      0,
      sameFileSnapshots.length - (this.MAX_READ_SNAPSHOTS_PER_FILE - 1)
    )

    let trimmedSnapshots = withoutSameWindow
    if (overflowForFile > 0) {
      // Evict narrow-range snapshots before full-file snapshots since
      // full-file snapshots have broader coverage and are more useful
      // for edit failure diagnostics.
      const isFullFile = (s: SessionReadSnapshot): boolean =>
        s.startLine == null && s.endLine == null
      let removed = 0
      trimmedSnapshots = withoutSameWindow.filter((existing) => {
        if (
          removed < overflowForFile &&
          existing.filePath === nextSnapshot.filePath &&
          !isFullFile(existing)
        ) {
          removed += 1
          return false
        }
        return true
      })
      // If we still need to evict more (only full-file snapshots left), FIFO
      if (removed < overflowForFile) {
        let remaining = overflowForFile - removed
        trimmedSnapshots = trimmedSnapshots.filter((existing) => {
          if (remaining > 0 && existing.filePath === nextSnapshot.filePath) {
            remaining -= 1
            return false
          }
          return true
        })
      }
    }

    trimmedSnapshots.push(nextSnapshot)
    if (trimmedSnapshots.length > this.MAX_READ_SNAPSHOTS_PER_SESSION) {
      trimmedSnapshots = trimmedSnapshots.slice(
        trimmedSnapshots.length - this.MAX_READ_SNAPSHOTS_PER_SESSION
      )
    }

    session.lastActivityAt = new Date()
    ctx!.readSnapshots = trimmedSnapshots
    this.sessionLifecycle.schedulePersist(conversationId)
    return true
  }
  /**
   * Drop every cached read snapshot for `filePath` in this session.
   *
   * Called after the bridge observes a successful mutation
   * (`writeResult`, `deleteResult`) so the next `applyEditInputToFileText`
   * does not feed a stale `beforeContent` back into the edit pipeline.
   * Without this, a sequence like
   *   read_file(a.txt)            -> snapshot { content: "alpha" }
   *   edit_file_v2 alpha→alpha-1  -> writeResult success, disk = "alpha-1"
   *   edit_file_v2 alpha-1→alpha-2 (no fresh read between)
   * would re-run `applyEditInputToFileText` against the stale "alpha"
   * snapshot and emit "alpha-1-1" / unsafe_overwrite reject — the
   * smoke regression #2 / #3a / #3d failures.
   *
   * Returns the number of snapshots dropped (0 means nothing to do).
   */
  invalidateReadSnapshotsForPath(
    conversationId: string,
    filePath: string,
    reason: string
  ): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return 0
    const normalized = this.preserveTrackedFilePath(filePath)
    if (!normalized) return 0
    const before = ctx!.readSnapshots.length
    ctx!.readSnapshots = ctx!.readSnapshots.filter(
      (snapshot) => snapshot.filePath !== normalized
    )
    const dropped = before - ctx!.readSnapshots.length
    if (dropped > 0) {
      session.lastActivityAt = new Date()
      this.sessionLifecycle.schedulePersist(conversationId)
      this.logger.debug(
        `Invalidated ${dropped} read snapshot(s) for ${normalized} (${reason})`
      )
    }
    return dropped
  }
  /**
   * 探测某 path 的最近 read snapshot 是否相对当前磁盘 stale，用于
   * edit_file_v2 写盘前的 fail-fast 检测。
   *
   * 参考 claude-code FileEditTool 的 FILE_UNEXPECTEDLY_MODIFIED_ERROR
   * mtime 乐观锁：
   *   1. 先比 mtime/size：snapshot 捕获时记录的 vs 当前 disk
   *   2. 不一致时再比 content：currentReadContent vs snapshot.content
   *      （Windows / cloud sync / antivirus 会无内容变化地触发 mtime
   *      抖动，content fallback 避免假阳性）
   *
   * 仅检查 sourceToolName === 'read_file' 的 snapshot —— edit_file_v2 写
   * 完后该 path 的 snapshot 暂不会主动刷新，跳过这类 snapshot 避免误报
   * "上次 edit 后第二次 edit"序列。
   *
   * 已知限制：若 read_file 之后该 path 没再读过，但被同 session 的
   * edit_file_v2 写过，本方法可能漏报；该场景由 path-level edit
   * serialization 兜底（acquireOrQueueEdit 保证顺序），且后续
   * applyEditInputToFileText 的 target_not_found / ambiguous_target 也会
   * 给模型可恢复的错误信号。
   */
  probeReadSnapshotStaleness(
    conversationId: string,
    filePath: string,
    currentReadContent: string
  ): {
    status: "fresh" | "stale_external" | "no_baseline"
    capturedMtimeMs?: number
    capturedSizeBytes?: number
    currentMtimeMs?: number
    currentSizeBytes?: number
  } {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return { status: "no_baseline" }

    const normalizedPath = this.preserveTrackedFilePath(filePath)
    if (!normalizedPath) return { status: "no_baseline" }

    // 倒序找最新一条 read_file 来源的 snapshot（含尚未被丢弃的 stale 候选）
    let baseline: SessionReadSnapshot | undefined
    for (let i = ctx!.readSnapshots.length - 1; i >= 0; i--) {
      const candidate = ctx!.readSnapshots[i]
      if (
        candidate &&
        candidate.filePath === normalizedPath &&
        candidate.sourceToolName === "read_file"
      ) {
        baseline = candidate
        break
      }
    }
    if (!baseline) return { status: "no_baseline" }
    if (
      typeof baseline.diskMtimeMs !== "number" ||
      typeof baseline.diskSizeBytes !== "number"
    ) {
      return { status: "fresh" }
    }
    if (!path.isAbsolute(normalizedPath)) {
      return { status: "fresh" }
    }

    let currentMtime: number
    let currentSize: number
    try {
      const stat = fs.statSync(normalizedPath)
      currentMtime = stat.mtimeMs
      currentSize = stat.size
    } catch {
      // 文件已不存在 / 不可 stat：无法证明 stale，由后续写入路径处理
      return { status: "fresh" }
    }

    const mtimeDrift = Math.abs(currentMtime - baseline.diskMtimeMs)
    const stable = mtimeDrift <= 1 && currentSize === baseline.diskSizeBytes
    if (stable) {
      return {
        status: "fresh",
        capturedMtimeMs: baseline.diskMtimeMs,
        capturedSizeBytes: baseline.diskSizeBytes,
        currentMtimeMs: currentMtime,
        currentSizeBytes: currentSize,
      }
    }

    // mtime/size 漂移 → 用 content fallback 吸收 FS 噪声
    if (currentReadContent === baseline.content) {
      return {
        status: "fresh",
        capturedMtimeMs: baseline.diskMtimeMs,
        capturedSizeBytes: baseline.diskSizeBytes,
        currentMtimeMs: currentMtime,
        currentSizeBytes: currentSize,
      }
    }

    return {
      status: "stale_external",
      capturedMtimeMs: baseline.diskMtimeMs,
      capturedSizeBytes: baseline.diskSizeBytes,
      currentMtimeMs: currentMtime,
      currentSizeBytes: currentSize,
    }
  }
  getLatestReadSnapshot(
    conversationId: string,
    filePath: string,
    options?: {
      startLine?: number
      endLine?: number
      requireCoverage?: boolean
    }
  ): SessionReadSnapshot | undefined {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return undefined

    const normalizedPath = this.preserveTrackedFilePath(filePath)
    if (!normalizedPath) return undefined

    const requestedStart =
      typeof options?.startLine === "number" &&
      Number.isFinite(options.startLine)
        ? Math.max(1, Math.floor(options.startLine))
        : undefined
    const requestedEnd =
      typeof options?.endLine === "number" && Number.isFinite(options.endLine)
        ? Math.max(1, Math.floor(options.endLine))
        : undefined
    const requireCoverage = options?.requireCoverage !== false

    // Cache the disk stat per call so multiple snapshot candidates for the
    // same path don't re-stat the file.
    let diskStatCached: { mtimeMs: number; size: number } | undefined
    let diskStatProbed = false
    const probeDiskStat = (): { mtimeMs: number; size: number } | undefined => {
      if (diskStatProbed) return diskStatCached
      diskStatProbed = true
      if (!path.isAbsolute(normalizedPath)) return undefined
      try {
        const stat = fs.statSync(normalizedPath)
        diskStatCached = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      } catch {
        diskStatCached = undefined
      }
      return diskStatCached
    }

    const isSnapshotStale = (snapshot: SessionReadSnapshot): boolean => {
      // Snapshot has no captured disk state — bridge could not stat the
      // path at capture time. Skip staleness check; the snapshot is the
      // best evidence we have.
      if (
        typeof snapshot.diskMtimeMs !== "number" ||
        typeof snapshot.diskSizeBytes !== "number"
      ) {
        return false
      }
      const stat = probeDiskStat()
      // No current disk stat (file gone, or relative path): cannot prove
      // staleness. Keep the snapshot.
      if (!stat) return false
      // mtime tolerance: 1ms slop to absorb FS rounding.
      const mtimeDrift = Math.abs(stat.mtimeMs - snapshot.diskMtimeMs)
      if (mtimeDrift > 1 || stat.size !== snapshot.diskSizeBytes) {
        this.logger.debug(
          `getLatestReadSnapshot: dropping stale snapshot for ${normalizedPath} ` +
            `(captured mtime=${snapshot.diskMtimeMs} size=${snapshot.diskSizeBytes}, ` +
            `current mtime=${stat.mtimeMs} size=${stat.size})`
        )
        return true
      }
      return false
    }

    for (let index = ctx!.readSnapshots.length - 1; index >= 0; index--) {
      const snapshot = ctx!.readSnapshots[index]
      if (!snapshot || snapshot.filePath !== normalizedPath) continue
      if (isSnapshotStale(snapshot)) continue

      if (requestedStart == null && requestedEnd == null) {
        return snapshot
      }

      if (snapshot.startLine == null || snapshot.endLine == null) {
        if (!requireCoverage) return snapshot
        continue
      }

      const coversRequestedRange =
        (requestedStart == null || snapshot.startLine <= requestedStart) &&
        (requestedEnd == null || snapshot.endLine >= requestedEnd)
      if (coversRequestedRange) {
        return snapshot
      }
      if (!requireCoverage) {
        return snapshot
      }
    }

    return undefined
  }
  /**
   * Track a successful file mutation (write/edit) into
   * `ctx!.fileStates`, which feeds:
   *
   *   - `agent.v1.ConversationCheckpointUpdate.fileStatesV2`
   *     (`map<string, FileStateStructure>` — see proto FileState).
   *   - `ContextAttachmentBuilderService` "Recent File Snapshots" /
   *     "Tracked File Changes" attachments.
   *
   * Semantics aligned with `agent.v1.FileState` (`beforeContent` =
   * session-baseline content, `afterContent` = current content):
   *
   * - First touch: persist both fields as supplied — `beforeContent`
   *   becomes the durable baseline for this path inside the session.
   * - Subsequent touches: keep the **original** `beforeContent` and
   *   only advance `afterContent`. Without this stickiness the baseline
   *   drifts to each intermediate post-edit state and tracked-file deltas
   *   report wrong line counts (e.g. a file restored to its original
   *   1-line content showing as `-2 lines` after a 3-line interim edit).
   */
  addFileState(
    conversationId: string,
    filePath: string,
    beforeContent: string,
    afterContent: string
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (session) {
      session.lastActivityAt = new Date()
      const existing = ctx!.fileStates.get(filePath)
      const baseline = existing ? existing.beforeContent : beforeContent
      const size = getSessionFileStateSize(baseline, afterContent)
      if (!isSessionFileStateWithinLimit(baseline, afterContent)) {
        ctx!.fileStates.delete(filePath)
        this.logger.warn(
          `Skipping oversized file state for ${conversationId} ${filePath}: ` +
            describeSessionFileStateLimit(size.beforeBytes, size.afterBytes)
        )
        this.sessionLifecycle.schedulePersist(conversationId)
        return
      }
      ctx!.fileStates.set(filePath, {
        beforeContent: baseline,
        afterContent,
      })
      this.sessionLifecycle.schedulePersist(conversationId)
    }
  }
  /**
   * Drop the tracked file-state entry for `filePath` after a successful
   * `deleteResult`.
   *
   * The `agent.v1` proto models deletion as **absence** from the
   * `ConversationCheckpointUpdate.fileStatesV2` map — `FileState` /
   * `FileStateStructure` carry no `deleted` / tombstone field — so eviction
   * is the only protocol-aligned way to express "this path no longer
   * exists in this session". Skipping eviction would (a) ship stale
   * `afterContent` in subsequent checkpoints and (b) keep the path in
   * `Recent File Snapshots` / `Tracked File Changes` attachments after the
   * file is gone from disk.
   *
   * Returns true when an entry was removed.
   */
  removeFileState(conversationId: string, filePath: string): boolean {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return false
    const removed = ctx!.fileStates.delete(filePath)
    if (removed) {
      session.lastActivityAt = new Date()
      this.sessionLifecycle.schedulePersist(conversationId)
    }
    return removed
  }
  recordCompletedToolCall(
    conversationId: string,
    toolCall: Pick<PendingToolCall, "toolName" | "toolFamilyHint" | "sentAt">
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return

    const durationMs = Math.max(0, Date.now() - toolCall.sentAt.getTime())
    ctx!.toolMetrics.completedCalls += 1
    ctx!.toolMetrics.totalDurationMs += durationMs
    ctx!.toolMetrics.lastCompletedAt = Date.now()

    switch (this.sessionLifecycle.classifyToolCall(toolCall)) {
      case "shell":
        ctx!.toolMetrics.shellCalls += 1
        break
      case "edit":
        ctx!.toolMetrics.editCalls += 1
        break
      case "mcp":
        ctx!.toolMetrics.mcpCalls += 1
        break
      default:
        ctx!.toolMetrics.otherCalls += 1
        break
    }

    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  getContextState(
    conversationId: string
  ): ContextConversationState | undefined {
    return this.contextRecords.get(conversationId)?.mainProjection.contextState
  }
  getTranscriptEvents(conversationId: string): SessionTranscriptEvent[] {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    return session
      ? ctx!.mainProjection.transcriptEvents.map((event) => ({ ...event }))
      : []
  }
  markContextStateDirty(conversationId: string): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    session.lastActivityAt = new Date()
    this.sessionLifecycle.syncContextRecordsFromMessageRecords(
      ctx!.mainProjection.contextState,
      ctx!.mainProjection.messageRecords
    )
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  recordAssistantResponseUsage(
    conversationId: string,
    recordId: string,
    usage: ContextUsageSnapshot,
    usageLedgerState?: ContextUsageLedgerState,
    reportedContextTokens?: number
  ): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    const normalizedUsage = assertContextUsageSnapshot(
      usage,
      "assistant response usage"
    )
    const nextUsageLedger = usageLedgerState || {
      anchorRecordId: recordId,
      lastUsage: normalizedUsage,
    }
    if (!nextUsageLedger.lastUsage) {
      throw new Error(
        "assistant response usage ledger must include an exact usage snapshot"
      )
    }
    const ledgerUsage = assertContextUsageSnapshot(
      nextUsageLedger.lastUsage,
      "assistant response usage ledger"
    )
    if (
      ledgerUsage.inputTokens !== normalizedUsage.inputTokens ||
      ledgerUsage.cachedInputTokens !== normalizedUsage.cachedInputTokens ||
      ledgerUsage.cacheCreationInputTokens !==
        normalizedUsage.cacheCreationInputTokens ||
      ledgerUsage.outputTokens !== normalizedUsage.outputTokens
    ) {
      throw new Error(
        "assistant response usage ledger must match the committed usage snapshot"
      )
    }
    const inputContextTokens =
      reportedContextTokens === undefined
        ? contextUsageInputTokenCount(
            normalizedUsage,
            "assistant response usage"
          )
        : requireNonNegativeSafeIntegerTokenCount(
            reportedContextTokens,
            "assistant response reportedContextTokens"
          )
    ctx!.mainProjection.contextState.usageLedger = nextUsageLedger
    ctx!.mainProjection.usedTokens = inputContextTokens
    session.usedContextTokens = inputContextTokens
    ctx!.pendingRequestContextLedger = undefined
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  replaceTodos(conversationId: string, todos: SessionTodoItem[]): void {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) return
    ctx!.todos = todos
    session.lastActivityAt = new Date()
    this.sessionLifecycle.persistTodos(conversationId, todos)
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  nextExecId(conversationId: string): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    const next = ctx!.execId++
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return next
  }
  incrementStepId(conversationId: string): number {
    const session = this.sessionLifecycle.getSession(conversationId)
    const ctx = this.contextRecords.get(conversationId)
    if (!session) {
      throw new Error(`Session not found: ${conversationId}`)
    }
    ctx!.stepId++
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
    return ctx!.stepId
  }

  // ─── Field accessors (step 4 终结) ─────────────────────────────
  // caller 不再 `ctx!.contextState.xxx` / `ctx!.messages` 等,
  // 通过这些 method 访问 ContextStateFields 字段。

  getMessages(conversationId: string): SessionMessage[] {
    return (
      this.contextRecords.get(conversationId)?.mainProjection.messages ?? []
    )
  }
  getMessagesGeneration(conversationId: string): number {
    return (
      this.contextRecords.get(conversationId)?.mainProjection.generation ?? 0
    )
  }
  getMessageRecords(conversationId: string): ContextTranscriptRecord[] {
    return (
      this.contextRecords.get(conversationId)?.mainProjection.messageRecords ??
      []
    )
  }
  getNextTranscriptEventSeq(conversationId: string): number {
    return (
      this.contextRecords.get(conversationId)?.mainProjection
        .nextTranscriptEventSeq ?? 0
    )
  }
  getTaskBudgetState(
    conversationId: string
  ): SessionTaskBudgetState | undefined {
    return this.contextRecords.get(conversationId)?.taskBudgetState
  }
  getTopLevelAgentTurnState(
    conversationId: string
  ): SessionTopLevelAgentTurnState | undefined {
    return this.contextRecords.get(conversationId)?.topLevelAgentTurnState
  }
  /**
   * Install a new top-level user-request epoch and clear its turn-local
   * investigation material in one synchronous state transition. Continuation
   * graph turns never call this method; they retain the same topLevelTurnId.
   */
  beginTopLevelAgentTurn(
    conversationId: string,
    state: SessionTopLevelAgentTurnState
  ): void {
    if (!state.topLevelTurnId) {
      throw new Error("Top-level agent turn requires a stable turn identity")
    }
    const session = this.sessionLifecycle.getSession(conversationId)
    const context = this.contextRecords.get(conversationId)
    if (!session || !context) {
      throw new Error(
        `Cannot begin top-level agent turn for missing session ${conversationId}`
      )
    }
    context.topLevelAgentTurnState = state
    session.lastActivityAt = new Date()
    this.sessionLifecycle.schedulePersist(conversationId)
  }
  getUsedTokens(conversationId: string): number {
    return (
      this.contextRecords.get(conversationId)?.mainProjection.usedTokens ?? 0
    )
  }
  setUsedTokens(conversationId: string, value: number): void {
    const normalized = requireNonNegativeSafeIntegerTokenCount(
      value,
      "setUsedTokens"
    )
    this.sessionLifecycle.setUsedContextTokens(conversationId, normalized)
  }
  getReadPaths(conversationId: string): Set<string> {
    return (
      this.contextRecords.get(conversationId)?.readPaths ?? new Set<never>()
    )
  }
  getReadSnapshots(conversationId: string): SessionReadSnapshot[] {
    return this.contextRecords.get(conversationId)?.readSnapshots ?? []
  }
  getFileStates(
    conversationId: string
  ): Map<string, { beforeContent: string; afterContent: string }> {
    return (
      this.contextRecords.get(conversationId)?.fileStates ??
      new Map<never, never>()
    )
  }
  getToolMetrics(conversationId: string): SessionToolMetrics | undefined {
    return this.contextRecords.get(conversationId)?.toolMetrics
  }
  getMessageBlobIds(conversationId: string): string[] {
    return this.contextRecords.get(conversationId)?.messageBlobIds ?? []
  }
  getTurns(conversationId: string): string[] {
    return this.contextRecords.get(conversationId)?.turns ?? []
  }
  getCurrentAssistantMessage(
    conversationId: string
  ): Record<string, unknown> | undefined {
    return this.contextRecords.get(conversationId)?.currentAssistantMessage
  }
  getStepId(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.stepId ?? 0
  }
  getExecId(conversationId: string): number {
    return this.contextRecords.get(conversationId)?.execId ?? 0
  }
  getTodos(conversationId: string): SessionTodoItem[] {
    return this.contextRecords.get(conversationId)?.todos ?? []
  }
  getPendingRequestContextLedger(
    conversationId: string
  ): ContextStateRecord["pendingRequestContextLedger"] | undefined {
    return this.contextRecords.get(conversationId)?.pendingRequestContextLedger
  }
  setPendingRequestContextLedger(
    conversationId: string,
    value: ContextStateRecord["pendingRequestContextLedger"]
  ): void {
    const s = this.contextRecords.get(conversationId)
    if (!s) return
    s.pendingRequestContextLedger = value
  }
}
