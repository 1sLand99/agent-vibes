import type { ContextAttachmentSnapshot } from "../../../context/context-attachment-builder.service"
import type { ParsedCursorRequest } from "../tools/cursor-request-parser"
import {
  assertCodexSubagentProviderIdentity,
  type CodexSubagentProviderIdentity,
} from "../../../llm/openai/codex-provider-identity"
import type { MountedContextProjection } from "./session-lifecycle.service"
import {
  assertSameProjectionOwner,
  createMainProjectionOwner,
  createSubagentProjectionOwnerFromBranch,
  type MainProjectionOwner,
  type SubagentProjectionBranchSnapshot,
  type SubagentProjectionOwner,
} from "./projection-owner"
import type { SubagentGraphBranch } from "./subagent-graph"
import {
  normalizeSubagentSpawnRequestBoundary,
  type SubagentModelRequestPolicy,
  type SubagentPromptContextSnapshot,
  type SubagentSpawnRequest,
  type SubagentToolContract,
} from "./subagent-spawn-request"
import type {
  SubagentRunMode,
  SubagentRunRecord,
} from "./subagent-run-store.service"
import type { ProviderAttemptIdentity } from "../provider-request-attempt"
import type { ConversationId, TurnId } from "../turn/turn.types"
import { WorkspaceScope } from "./workspace-scope"

export type CodexContextSynchronizationMode = "synchronize" | "retain"
export type CodexSamplingPhase = "pre_turn" | "mid_turn"

/**
 * Immutable receipt for the provider context baseline of one top-level turn.
 * A continuation retains the accepted static revision while still evaluating
 * the current keyed world-state delta before every sampling step. A new or
 * explicitly invalidated revision must synchronize before it can become the
 * baseline for later tool continuations.
 */
export interface CodexContextSynchronizationReceipt {
  readonly topLevelTurnId: TurnId
  readonly revision: number
  readonly mode: CodexContextSynchronizationMode
}

/**
 * Provider-visible prompt facts captured from the canonical main session.
 *
 * A ParsedCursorRequest is not this contract: its workspace authority lives
 * under `workspaceDeclaration.scope`, while prompt policy requires a direct
 * WorkspaceScope. Treating the wire parser result as a prompt context makes
 * every agentFetched skill look like an ordinary rule and injects its complete
 * SKILL.md body. The main request boundary therefore owns this normalized,
 * immutable shape for both initial turns and tool continuations.
 */
export type ProviderPromptContext = Pick<
  ParsedCursorRequest,
  | "codeChunks"
  | "cursorRules"
  | "skillOptions"
  | "cursorCommands"
  | "customSystemPrompt"
  | "hooksAdditionalContext"
  | "explicitContext"
  | "mcpToolDefs"
  | "selectedCursorRulePaths"
  | "selectedCursorRuleNames"
> & {
  /** Canonical IDE workspace authority; never reconstructed from raw paths. */
  workspaceScope: WorkspaceScope
  newMessage?: ParsedCursorRequest["newMessage"]
  activeCursorSkillNames?: string[]
}

/** The root conversation request boundary for one real provider attempt. */
export interface MainProjectionRequestScope {
  readonly kind: "main"
  readonly owner: MainProjectionOwner
  /** The coordinator identity that owns this exact request boundary. */
  readonly attempt: ProviderAttemptIdentity
  /** Dynamic attachment facts collected once while the owner mutation is held. */
  readonly attachmentSnapshot: ContextAttachmentSnapshot
  /** Normalized prompt facts collected from the same canonical session. */
  readonly promptContext: ProviderPromptContext
  /** Top-level-turn-owned Codex context revision captured for this attempt. */
  readonly codexContext: CodexContextSynchronizationReceipt
  /**
   * Placement boundary for compaction during this sampling step. This is
   * independent of context synchronization: a mid-turn skill activation may
   * require a fresh static revision, but its already-staged tool history must
   * still be compacted as mid-turn input.
   */
  readonly codexSamplingPhase: CodexSamplingPhase
}

/**
 * The root conversation boundary for one user-initiated compaction request.
 *
 * Manual compaction is not a provider-turn retry, so it deliberately has no
 * `ProviderAttemptIdentity`. It is nevertheless an independent remote
 * request and must retain the exact owner, trigger, and attachment facts that
 * existed while the owner mutation was held.
 */
export interface ManualCompactionRequestScope {
  readonly kind: "manual-compaction"
  readonly owner: MainProjectionOwner
  readonly strategy: "manual"
  readonly trigger: ManualCompactionTrigger
  /** Dynamic attachment facts collected once while the owner mutation is held. */
  readonly attachmentSnapshot: ContextAttachmentSnapshot
}

export type ManualCompactionTrigger =
  | "conversation-summarize-action"
  | "compact-conversation-api"

/**
 * The complete child request boundary. It contains only the durable facts
 * consumed to build one provider request, never a complete run row, complete
 * branch object, live session, agent definition, in-memory transcript, or
 * current MCP registry.
 */
export interface SubagentProjectionRequestScope {
  readonly kind: "subagent"
  readonly owner: SubagentProjectionOwner
  /** Exact execution facts consumed by a child provider request. */
  readonly execution: SubagentExecutionRequestReceipt
  /**
   * Detached receipt for the mounted projection that was observed at request
   * creation. It intentionally excludes live ContextConversationState: a
   * request may validate that state through its receipt, but must never retain
   * or mutate the shared projection object.
   */
  readonly projectionReceipt: MountedSubagentProjectionReceipt
  /**
   * Minimal immutable provider input. Durable task attachments, request
   * environment, workspace JSON, limits, and child context attachments stay
   * on the run row; they are not retained by a provider request scope.
   */
  readonly providerInput: SubagentProviderRequestInput
  /**
   * Reconstructed once at the durable child request boundary. Every child
   * filesystem consumer receives this authority object, never raw snapshot
   * JSON.
   */
  readonly workspaceScope: WorkspaceScope
  /** Child-owned attachment facts frozen when the run was created. */
  readonly attachmentSnapshot: ContextAttachmentSnapshot
}

/**
 * The run-row subset that can affect child request assembly. Keeping this
 * separate from `SubagentRunRecord` prevents terminal/delivery metadata from
 * crossing into a provider request boundary.
 */
export interface SubagentExecutionRequestReceipt {
  readonly turnId: TurnId
  readonly mode: SubagentRunMode
  readonly model: string
  readonly codexIdentity: CodexSubagentProviderIdentity
}

/**
 * The exact spawn-request subset consumed while assembling a child provider
 * request. This is intentionally a distinct data shape, not an alias of
 * `SubagentSpawnRequest`: retaining the durable request wholesale would keep
 * a second full child attachment snapshot alive beside `attachmentSnapshot`.
 */
export interface SubagentProviderRequestInput {
  readonly systemPrompt: string
  readonly modelRequestPolicy: SubagentModelRequestPolicy
  readonly promptContext: SubagentPromptContextSnapshot
  readonly toolContract: SubagentToolContract
}

/**
 * Complete child-request read receipt for a mounted projection. The request
 * path needs only the message count for provider context construction and the
 * durable branch tail for currentness checks. Message/record/event payloads,
 * usage, and generation remain owned by the live projection and do not cross
 * the request boundary.
 */
export interface MountedSubagentProjectionReceipt {
  readonly sessionMessageCount: number
  readonly branchSnapshot: SubagentProjectionBranchSnapshot
}

/**
 * An accepted child provider request's authority receipt. It is attached to
 * the immutable provider candidate and released only after that candidate
 * crosses the provider acceptance barrier. Background and foreground tool
 * execution must use this object rather than a mutable prepare-time local.
 */
export interface SubagentProviderRequestReceipt {
  readonly kind: "subagent-provider-request"
  readonly attempt: ProviderAttemptIdentity
  readonly owner: SubagentProjectionOwner
  readonly executionTurnId: TurnId
  /** The exact native child thread used by this accepted request. */
  readonly codexIdentity: CodexSubagentProviderIdentity
  readonly workspaceScope: WorkspaceScope
}

export type ProjectionRequestScope =
  | MainProjectionRequestScope
  | ManualCompactionRequestScope
  | SubagentProjectionRequestScope

export function createMainProjectionRequestScope(input: {
  readonly conversationId: ConversationId
  readonly attempt: ProviderAttemptIdentity
  readonly attachmentSnapshot: ContextAttachmentSnapshot
  readonly promptContext: ProviderPromptContext
  readonly codexContext: CodexContextSynchronizationReceipt
  readonly codexSamplingPhase: CodexSamplingPhase
}): MainProjectionRequestScope {
  return Object.freeze({
    kind: "main" as const,
    owner: createMainProjectionOwner(input.conversationId),
    attempt: input.attempt,
    attachmentSnapshot: detachAndFreezeAttachmentSnapshot(
      input.attachmentSnapshot
    ),
    promptContext: detachAndFreezeProviderPromptContext(input.promptContext),
    codexContext: freezeDeep({ ...input.codexContext }),
    codexSamplingPhase: input.codexSamplingPhase,
  })
}

export function createManualCompactionRequestScope(input: {
  readonly conversationId: ConversationId
  readonly trigger: ManualCompactionTrigger
  readonly attachmentSnapshot: ContextAttachmentSnapshot
}): ManualCompactionRequestScope {
  assertManualCompactionTrigger(input.trigger)
  return Object.freeze({
    kind: "manual-compaction" as const,
    owner: createMainProjectionOwner(input.conversationId),
    strategy: "manual" as const,
    trigger: input.trigger,
    attachmentSnapshot: detachAndFreezeAttachmentSnapshot(
      input.attachmentSnapshot
    ),
  })
}

/**
 * Create a request scope from already-loaded durable state.  This function
 * intentionally has no session/registry argument: any caller that needs one
 * of those to make a child request is on the wrong side of the spawn
 * boundary.
 */
export function createSubagentProjectionRequestScope(input: {
  readonly run: SubagentRunRecord
  readonly branch: SubagentGraphBranch
  readonly mountedProjection: MountedContextProjection
}): SubagentProjectionRequestScope {
  const { run, branch, mountedProjection } = input
  // Revalidate the persisted payload at the request boundary.  This produces
  // a detached immutable value and makes an unsupported persisted version a
  // hard failure rather than permission to reconstruct child inputs from the
  // live parent session.
  const normalizedSpawn = normalizeSubagentSpawnRequestBoundary(
    run.spawnRequest
  )
  const { request: spawnRequest, workspaceScope } = normalizedSpawn
  assertRunMatchesBranch(run, branch)
  const owner = freezeDeep(createSubagentProjectionOwnerFromBranch(branch))
  assertSameProjectionOwner(
    owner,
    mountedProjection.owner,
    "createSubagentProjectionRequestScope"
  )
  const projectionReceipt = detachMountedProjectionReceipt(
    mountedProjection,
    owner
  )
  if (
    projectionReceipt.branchSnapshot.executionTurnId !== run.executionTurnId
  ) {
    throw new Error(
      "Subagent projection request branch snapshot does not own the active execution turn"
    )
  }

  return Object.freeze({
    kind: "subagent" as const,
    owner,
    execution: detachAndFreezeExecutionReceipt(run),
    projectionReceipt,
    providerInput: detachAndFreezeProviderInput(spawnRequest),
    workspaceScope,
    attachmentSnapshot: detachAndFreezeAttachmentSnapshot(
      buildChildAttachmentSnapshot(spawnRequest)
    ),
  })
}

function detachAndFreezeProviderInput(
  request: SubagentSpawnRequest
): SubagentProviderRequestInput {
  // `normalizeSubagentSpawnRequestBoundary` has already cloned and deeply
  // frozen these exact values. Selecting them here intentionally does not
  // retain the parent request object or its childContextAttachmentSnapshot.
  return Object.freeze({
    systemPrompt: request.systemPrompt,
    modelRequestPolicy: request.modelRequestPolicy,
    promptContext: request.promptContext,
    toolContract: request.toolContract,
  })
}

function detachAndFreezeExecutionReceipt(
  run: SubagentRunRecord
): SubagentExecutionRequestReceipt {
  return freezeDeep({
    turnId: run.executionTurnId,
    mode: run.mode,
    model: run.model,
    codexIdentity: { ...run.codexIdentity },
  })
}

function detachMountedProjectionReceipt(
  projection: MountedContextProjection,
  expectedOwner: SubagentProjectionOwner
): MountedSubagentProjectionReceipt {
  assertSameProjectionOwner(
    expectedOwner,
    projection.owner,
    "createSubagentProjectionRequestScope"
  )
  const branchSnapshot = projection.branchSnapshot
  if (!branchSnapshot) {
    throw new Error(
      "Subagent projection request requires a mounted durable branch snapshot"
    )
  }
  return freezeDeep({
    sessionMessageCount: projection.messages.length,
    branchSnapshot: {
      headUuid: branchSnapshot.headUuid,
      headRevision: branchSnapshot.headRevision,
      executionTurnId: branchSnapshot.executionTurnId,
    },
  })
}

/** Construct the authority that a child may use only after request acceptance. */
export function createSubagentProviderRequestReceipt(input: {
  readonly scope: SubagentProjectionRequestScope
  readonly attempt: ProviderAttemptIdentity
}): SubagentProviderRequestReceipt {
  return Object.freeze({
    kind: "subagent-provider-request" as const,
    attempt: input.attempt,
    owner: input.scope.owner,
    executionTurnId: input.scope.execution.turnId,
    codexIdentity: input.scope.execution.codexIdentity,
    workspaceScope: input.scope.workspaceScope,
  })
}

/**
 * Admit an accepted provider receipt for one worker/foreground child turn.
 * Object identity of `attempt` is deliberate: an authority created for a
 * retry or fallback can never be reused by a different accepted attempt.
 */
export function requireSubagentProviderRequestReceipt(input: {
  readonly receipt: unknown
  /** Supplied at the provider acceptance boundary; workers recheck branch ownership. */
  readonly attempt?: ProviderAttemptIdentity
  readonly branch: SubagentGraphBranch
}): SubagentProviderRequestReceipt {
  const receipt = input.receipt
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("Subagent provider acceptance has no request receipt")
  }
  const candidate = receipt as Partial<SubagentProviderRequestReceipt>
  if (
    candidate.kind !== "subagent-provider-request" ||
    !candidate.attempt ||
    !Object.isFrozen(candidate.attempt) ||
    (input.attempt !== undefined && candidate.attempt !== input.attempt) ||
    candidate.executionTurnId !== input.branch.turnId ||
    !candidate.codexIdentity ||
    !Object.isFrozen(candidate.codexIdentity) ||
    !(candidate.workspaceScope instanceof WorkspaceScope) ||
    !Object.isFrozen(candidate.workspaceScope)
  ) {
    throw new Error(
      "Subagent provider acceptance receipt does not match its request"
    )
  }
  if (!candidate.owner) {
    throw new Error(
      "Subagent provider acceptance receipt has no projection owner"
    )
  }
  if (
    !Object.isFrozen(candidate.owner) ||
    !Object.isFrozen(candidate.owner.forkLineage)
  ) {
    throw new Error(
      "Subagent provider acceptance receipt must retain an immutable projection owner"
    )
  }
  assertCodexSubagentProviderIdentity(candidate.codexIdentity)
  assertSameProjectionOwner(
    createSubagentProjectionOwnerFromBranch(input.branch),
    candidate.owner,
    "Subagent provider acceptance receipt"
  )
  if (!Object.isFrozen(receipt)) {
    throw new Error("Subagent provider acceptance receipt must be immutable")
  }
  return receipt as SubagentProviderRequestReceipt
}

export function projectionRequestScopeLabel(
  scope: ProjectionRequestScope
): string {
  const owner = scope.owner
  return `${owner.conversationId}/${owner.ownerKey}`
}

function assertRunMatchesBranch(
  run: SubagentRunRecord,
  branch: SubagentGraphBranch
): void {
  if (
    run.conversationId !== branch.conversationId ||
    run.agentId !== branch.agentId ||
    run.agentId !== branch.subagentId ||
    run.parentToolCallId !== branch.parentToolCallId ||
    run.threadId !== branch.threadId ||
    run.branchId !== branch.branchId ||
    run.forkSourceUuid !== branch.forkSourceUuid ||
    run.executionTurnId !== branch.turnId ||
    run.forkLineage.length !== branch.forkLineage.length ||
    run.forkLineage.some((entry, index) => entry !== branch.forkLineage[index])
  ) {
    throw new Error(
      "Subagent projection request branch does not match its durable run"
    )
  }
}

function assertManualCompactionTrigger(
  trigger: string
): asserts trigger is ManualCompactionTrigger {
  if (
    trigger !== "conversation-summarize-action" &&
    trigger !== "compact-conversation-api"
  ) {
    throw new Error(`Unsupported manual compaction trigger: ${trigger}`)
  }
}

function detachAndFreezeAttachmentSnapshot(
  snapshot: ContextAttachmentSnapshot
): ContextAttachmentSnapshot {
  return freezeDeep(structuredClone(snapshot))
}

function detachAndFreezeProviderPromptContext(
  context: ProviderPromptContext
): ProviderPromptContext {
  if (!(context.workspaceScope instanceof WorkspaceScope)) {
    throw new Error(
      "Main provider prompt context requires a declared WorkspaceScope"
    )
  }
  const { workspaceScope, ...detachedFields } = context
  return freezeDeep({
    ...structuredClone(detachedFields),
    // WorkspaceScope is already a deeply frozen authority object. Retain its
    // class identity instead of structured-cloning it into an untrusted POJO.
    workspaceScope,
  })
}

function buildChildAttachmentSnapshot(
  request: SubagentSpawnRequest
): ContextAttachmentSnapshot {
  const source = request.childContextAttachmentSnapshot
  return {
    readPaths: [...source.readPaths],
    fileStates: source.fileStates.map((entry) => ({
      path: entry.path,
      beforeContent: entry.beforeContent,
      afterContent: entry.afterContent,
    })),
    todos: source.todos.map((entry) => ({
      id: entry.id,
      content: entry.content,
      status: entry.status,
      dependencies: [...entry.dependencies],
    })),
    sessionMemory: source.sessionMemory.map((entry) => ({
      kind: entry.kind,
      text: entry.text,
      ...(entry.createdAt === null ? {} : { createdAt: entry.createdAt }),
      ...(entry.weight === null ? {} : { weight: entry.weight }),
      sourceToolUseId: entry.sourceToolUseId,
      sourceRecordUuid: entry.sourceRecordUuid,
      sourceKind: entry.sourceKind,
    })),
    activeSubAgents: source.activeSubAgents.map((entry) => ({
      subagentId: entry.subagentId,
      model: entry.model,
      turnCount: entry.turnCount,
      toolCallCount: entry.toolCallCount,
      modifiedFiles: [...entry.modifiedFiles],
      pendingToolCallIds: [...entry.pendingToolCallIds],
    })),
  }
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeDeep(child)
  }
  return Object.freeze(value)
}
