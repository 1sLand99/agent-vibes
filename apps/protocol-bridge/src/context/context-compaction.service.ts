import { Injectable, Logger } from "@nestjs/common"
import { randomUUID } from "crypto"
import { fingerprintAttachments } from "./attachment-fingerprint"
import { ClaudeConversationProjector } from "./claude-conversation-projector"
import type { ContextProjectionResult } from "./context-projection.service"
import { CompactWarningHookService } from "./compact-warning-hook.service"
import { CompactWarningStateService } from "./compact-warning-state.service"
import {
  CONTEXT_COMPACT_MAX_OUTPUT_TOKENS,
  type ContextCompactionMode,
} from "./context-compact-prompt"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import type {
  ContextModelProfile,
  ContextTokenizer,
} from "./context-model-profile"
import { ContextTelemetryService } from "./context-telemetry.service"
import { CONTEXT_MICROCOMPACT_CLEARED_MARKER } from "../shared/context-compaction"
import {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  createAttachmentRecord,
  createHookResultRecord,
  deriveCompactionHistoryFromTranscript,
  getRecordsAfterCompactBoundary,
  isCompactSummaryRecord,
  isMessageRecord,
  isSnipBoundaryRecord,
} from "./context-transcript-events"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { requireExactDurableIdentifier } from "./durable-identifier"
import {
  assertTerminalSessionMemoryProvenance,
  SessionMemoryService,
} from "./session-memory.service"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextToolResultReplacementState,
  ClaudeProjectionCapabilitySnapshot,
  ClaudeProjectionRecipe,
  ContextTranscriptRecord,
  ProjectedContextMessage,
  ContextProjectionAttachment,
  ProjectionManifest,
  UnifiedMessage,
  isToolResultBlock,
  isToolUseBlock,
  normalizeContent,
} from "./types"

export class ContextProjectionBudgetExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maxTokens: number
  ) {
    super(
      `Projected context is ${estimatedTokens} tokens, exceeding request budget ${maxTokens}.`
    )
    this.name = "ContextProjectionBudgetExceededError"
  }
}

export class StaleContextCompactionCandidateError extends Error {
  constructor() {
    super(
      "Context graph changed while its compaction summary was being generated"
    )
    this.name = "StaleContextCompactionCandidateError"
  }
}

export interface ContextCompactionPlan {
  commit: ContextCompactionCommit
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  attachmentFingerprint: string
  recordCount: number
  retainedRecords: ContextTranscriptRecord[]
  boundaryRecord: ContextTranscriptRecord
  summaryRecord: ContextTranscriptRecord
  orderedProjectionRecords: ContextTranscriptRecord[]
  attachmentRecords?: ContextTranscriptRecord[]
  hookResultRecords?: ContextTranscriptRecord[]
  /** Exact provider-owned Claude layout staged from this compact plan. */
  claudeProjection?: {
    recipe: ClaudeProjectionRecipe
    manifest: ProjectionManifest
  }
  /** Main-graph head frozen by the candidate that produced this plan. */
  graphWatermarkUuid: string
}

export interface ContextCompactionInstallInput {
  summary: string
  hookUserMessage?: string
  emitTelemetry?: boolean
}

interface PreparedContextCompactionState {
  records: ContextTranscriptRecord[]
  graphWatermarkUuid: string
  compactionHistory: ContextCompactionCommit[]
  activeCompactionId: string
  compactionEpoch: number
  lastAppliedCompaction: NonNullable<
    ContextConversationState["lastAppliedCompaction"]
  >
  compactWarningState: NonNullable<
    ContextConversationState["compactWarningState"]
  >
}

/**
 * Complete hot-state transition prepared before a durable projection commit.
 * Applying this receipt performs no graph validation, history derivation, or
 * provider lookup; those operations must all succeed before persistence.
 */
export interface PreparedContextCompactionInstall {
  readonly state: ContextConversationState
  readonly next: PreparedContextCompactionState
  readonly telemetry?: {
    readonly archivedMessageCount: number
    readonly sourceTokenCount: number
    readonly summaryTokenCount: number
    readonly epoch: number
  }
}

export interface ContextCompactionCandidate {
  mode: ContextCompactionMode
  commitId: string
  strategy: ContextCompactionCommit["strategy"]
  createdAt: number
  nextEpoch: number
  archivedRecords: ContextTranscriptRecord[]
  retainedRecords: ContextTranscriptRecord[]
  /** Exact ordered native source records sent to the compact summary model. */
  summaryInputRecords: ContextTranscriptRecord[]
  summaryOutputTokenLimit: number
  contextProfile?: ContextModelProfile
  claudeCapability?: ClaudeProjectionCapabilitySnapshot
  /** Exact Claude checkpoint selected by the provider head for this input. */
  claudeRecipe?: ClaudeProjectionRecipe
  attachmentFingerprint: string
  liveAttachments: ContextProjectionAttachment[]
  sourceTokenCount: number
  retainedTokenCount: number
  /** Array identity of the exact context revision summarized by this candidate. */
  sourceStateRecords: readonly ContextTranscriptRecord[]
  /**
   * Exact replacement-state revision used to construct the summary input.
   * Tool-result replacement is immutable at the projection boundary, so an
   * accepted graph result cannot silently alter a candidate while its summary
   * request is in flight.
   */
  sourceToolResultReplacementState?: ContextToolResultReplacementState
  /** Main-graph head mounted when this candidate was prepared. */
  graphWatermarkUuid: string
}

export interface ContextCompactionSplit {
  archivedRecords: ContextTranscriptRecord[]
  retainedRecords: ContextTranscriptRecord[]
}

/**
 * Restrict provider-neutral audit records to the native source boundary that
 * is actually being compacted. The complete prefix is retained so attachment,
 * hook, and memory records remain ordered with their mapped graph messages.
 */
export function sliceContextRecordsThroughMappedSources(
  records: readonly ContextTranscriptRecord[],
  sourceRecordIds: readonly string[]
): ContextTranscriptRecord[] {
  const mapped = new Set(
    sourceRecordIds.map((sourceRecordId) =>
      requireExactDurableIdentifier(
        sourceRecordId,
        "provider compaction source record id"
      )
    )
  )
  let lastMappedIndex = -1
  records.forEach((record, index) => {
    if (mapped.has(record.id)) lastMappedIndex = index
  })
  if (lastMappedIndex < 0) return []
  let boundaryIndex = lastMappedIndex + 1
  while (
    boundaryIndex < records.length &&
    !isMessageRecord(records[boundaryIndex]!)
  ) {
    boundaryIndex += 1
  }
  return records.slice(0, boundaryIndex)
}

export function orderContextCompactionProjectionRecords(
  mode: ContextCompactionMode,
  boundaryRecord: ContextTranscriptRecord,
  summaryRecord: ContextTranscriptRecord,
  retainedRecords: readonly ContextTranscriptRecord[],
  trailingRecords: readonly ContextTranscriptRecord[]
): ContextTranscriptRecord[] {
  return mode === "from"
    ? [boundaryRecord, ...retainedRecords, summaryRecord, ...trailingRecords]
    : [boundaryRecord, summaryRecord, ...retainedRecords, ...trailingRecords]
}

/**
 * Replay mounted Snip boundaries into a compact projection using the current
 * canonical state order. A Snip whose graph anchor was compacted away sits
 * immediately before the first later graph message that survived; when no
 * later graph message survives it follows the complete synthetic projection.
 */
export function rebaseSnipBoundariesIntoCompactProjection(
  canonicalRecords: readonly ContextTranscriptRecord[],
  compactProjectionRecords: readonly ContextTranscriptRecord[],
  retainedRecords: readonly ContextTranscriptRecord[]
): ContextTranscriptRecord[] {
  const result = [...compactProjectionRecords]
  const retainedGraphIds = new Set(
    retainedRecords.filter(isMessageRecord).map((record) => record.id)
  )
  const seenIds = new Set<string>()
  for (const record of result) {
    if (seenIds.has(record.id)) {
      throw new Error(
        `Compact projection contains duplicate record ${record.id}`
      )
    }
    seenIds.add(record.id)
  }

  for (let index = 0; index < canonicalRecords.length; index++) {
    const boundary = canonicalRecords[index]!
    if (!isSnipBoundaryRecord(boundary)) continue
    if (seenIds.has(boundary.id)) {
      throw new Error(
        `Compact projection contains duplicate Snip ${boundary.id}`
      )
    }
    const successor = canonicalRecords
      .slice(index + 1)
      .find(
        (record) => isMessageRecord(record) && retainedGraphIds.has(record.id)
      )
    const successorIndex = successor
      ? result.findIndex((record) => record.id === successor.id)
      : -1
    if (successor && successorIndex < 0) {
      throw new Error(
        `Retained Snip successor ${successor.id} is absent from compact projection`
      )
    }
    result.splice(
      successorIndex >= 0 ? successorIndex : result.length,
      0,
      boundary
    )
    seenIds.add(boundary.id)
  }
  return result
}

/**
 * Split an active compact source without cutting through one provider response
 * or a tool_use/tool_result chain. Ordinary message pivots remain exact; a
 * pivot inside a structured API round moves to the first record of that round.
 */
export function splitContextCompactionRecords(
  sourceRecords: readonly ContextTranscriptRecord[],
  mode: ContextCompactionMode,
  pivotRecordId?: string
): ContextCompactionSplit | null {
  if (sourceRecords.length === 0) return null
  if (mode === "full") {
    return { archivedRecords: [...sourceRecords], retainedRecords: [] }
  }
  if (!pivotRecordId) return null
  const pivotIndex = sourceRecords.findIndex(
    (record) => record.id === pivotRecordId
  )
  if (pivotIndex < 0) return null
  const boundaryIndex = resolveStructuredRoundStart(sourceRecords, pivotIndex)
  const archivedRecords =
    mode === "up_to"
      ? sourceRecords.slice(0, boundaryIndex)
      : sourceRecords.slice(boundaryIndex)
  const retainedRecords =
    mode === "up_to"
      ? sourceRecords.slice(boundaryIndex)
      : sourceRecords.slice(0, boundaryIndex)
  if (archivedRecords.length === 0 || retainedRecords.length === 0) return null
  return { archivedRecords, retainedRecords }
}

function resolveStructuredRoundStart(
  records: readonly ContextTranscriptRecord[],
  pivotIndex: number
): number {
  const toolUseIndex = new Map<string, number>()
  const toolResultIndex = new Map<string, number>()
  for (let index = 0; index < records.length; index++) {
    for (const block of normalizeContent(records[index]!.content)) {
      if (isToolUseBlock(block)) toolUseIndex.set(block.id, index)
      if (isToolResultBlock(block)) {
        toolResultIndex.set(block.tool_use_id, index)
      }
    }
  }

  let boundaryIndex = pivotIndex
  let changed = true
  while (changed) {
    changed = false
    const boundaryRecord = records[boundaryIndex]
    const providerMessageId =
      boundaryRecord?.role === "assistant"
        ? boundaryRecord.messageId || boundaryRecord.providerMessageId
        : undefined
    if (providerMessageId) {
      for (let index = 0; index < boundaryIndex; index++) {
        const record = records[index]!
        if (
          record.role === "assistant" &&
          (record.messageId || record.providerMessageId) === providerMessageId
        ) {
          boundaryIndex = index
          changed = true
          break
        }
      }
    }

    for (const [toolUseId, useIndex] of toolUseIndex) {
      const resultIndex = toolResultIndex.get(toolUseId)
      if (
        resultIndex !== undefined &&
        useIndex < boundaryIndex &&
        resultIndex >= boundaryIndex
      ) {
        boundaryIndex = useIndex
        changed = true
      }
    }
  }
  return boundaryIndex
}

/**
 * The request-window pressure limit after system-prompt and configured
 * auto/predictive thresholds are accounted for.  This is deliberately
 * independent from any transcript projection so provider-native history can
 * make the trigger decision without being influenced by another provider's
 * representation of the same conversation.
 */
export interface ContextCompactionPressureBudget {
  hardMaxTokens: number
  effectiveMaxTokens: number
}

/**
 * `strict` enforces the budget when this projection is itself the provider
 * payload. A provider-native adapter may use the generic projection only to
 * derive source-bound deltas; its final native assembler owns the strict wire
 * gate. `measure` exists solely for a dry-run request candidate so the caller
 * can decide whether to compact before rebuilding from the resulting state.
 */
export type ContextBudgetEnforcement = "strict" | "measure"

/** The layer whose materialized payload owns the final request budget gate. */
export type ContextProjectionBudgetBoundary =
  | "projected-messages"
  | "provider-native-request"

export interface ContextSnipCompactionResult {
  changed: boolean
  removedRecords: number
  retainedRecords: number
  summaryTokenCount: number
  estimatedTokens: number
}

export interface ContextMicroCompactionResult {
  changed: boolean
  clearedToolResults: number
}

export interface ContextCompactionResult {
  messages: UnifiedMessage[]
  projectedMessages: ProjectedContextMessage[]
  estimatedTokens: number
  wasCompacted: boolean
  /**
   * Exact provider manifest emitted by this projection. Measurement callers
   * receive a clone from their dry-run state so accepting the candidate never
   * requires a second projection merely to install Claude's active window.
   */
  projectionManifest?: ProjectionManifest
  snipCompaction?: ContextSnipCompactionResult
  microCompaction?: ContextMicroCompactionResult
}

@Injectable()
export class ContextCompactionService {
  private readonly logger = new Logger(ContextCompactionService.name)
  private readonly MIN_REQUEST_BUDGET = 256
  private readonly MIN_ATTACHMENT_TOKENS = 128
  private readonly ATTACHMENT_TOKEN_BUDGET = 2200
  private readonly SNIP_MIN_REMOVED_RECORDS = 2
  /**
   * cc-faithful microcompact tuning. Older tool results from read-only /
   * search / shell / web tools are content-cleared once more than
   * MICROCOMPACT_KEEP_RECENT_RESULTS such results exist, keeping the most
   * recent ones verbatim. Small results (< MICROCOMPACT_MIN_RESULT_TOKENS)
   * are left alone — clearing them saves nothing. Marker text mirrors cc's
   * TIME_BASED_MC_CLEARED_MESSAGE.
   */
  private readonly MICROCOMPACT_KEEP_RECENT_RESULTS = 12
  private readonly MICROCOMPACT_MIN_RESULT_TOKENS = 400
  private readonly MICROCOMPACT_CLEARED_MARKER =
    CONTEXT_MICROCOMPACT_CLEARED_MARKER
  private static readonly MICROCOMPACTABLE_TOOLS = new Set<string>([
    "read_file",
    "read_files",
    "read_project",
    "read_lints",
    "run_terminal_command",
    "grep_search",
    "glob_search",
    "file_search",
    "list_directory",
    "codebase_search",
    "web_search",
    "web_fetch",
  ])

  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService,
    private readonly projection: ContextProjectionService,
    private readonly attachments: ContextAttachmentBuilderService,
    private readonly usageLedger: ContextUsageLedgerService,
    private readonly sessionMemory: SessionMemoryService,
    private readonly telemetry: ContextTelemetryService,
    private readonly compactWarningState: CompactWarningStateService,
    private readonly compactWarningHook: CompactWarningHookService,
    private readonly claudeProjector: ClaudeConversationProjector
  ) {}

  ensureWithinBudget(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      strategy?: ContextCompactionCommit["strategy"]
      dryRun?: boolean
      /**
       * Strict is the default. Measurement must be paired with `dryRun: true`;
       * a provider-native source projection is independently gated after its
       * final native request has been assembled.
       */
      budgetEnforcement?: ContextBudgetEnforcement
      budgetBoundary?: ContextProjectionBudgetBoundary
      dynamicAttachmentMode?: "history" | "provider-native"
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      visibleSessionMemorySourceRecordUuids?: Iterable<string>
    }
  ): ContextCompactionResult {
    const budgetEnforcement = this.resolveBudgetEnforcement(
      options.budgetEnforcement
    )
    if (budgetEnforcement === "measure" && options.dryRun !== true) {
      throw new Error(
        "Context projection measurement requires dryRun: true; final provider requests must use strict enforcement"
      )
    }
    const hardMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    const tokenizer = this.resolveTokenizer(options.contextProfile)
    const targetMaxTokens = this.resolvePressureBudget(hardMaxTokens, options)
    const workingState = options.dryRun ? this.cloneState(state) : state
    const attachmentTokenBudget = this.resolveAttachmentBudget(hardMaxTokens)

    // cc parity: each new compaction round starts by clearing the
    // warning suppression so the predictive hook can re-evaluate.
    // Suppression is set back on by suppressCompactWarning hooks below
    // (cache_edits emission, applyCompactionPlan, microcompact path).
    if (!options.dryRun) {
      this.compactWarningState.clearCompactWarningSuppression(workingState)
    }

    const projection = this.buildProjectedMessages(
      workingState,
      snapshot,
      attachmentTokenBudget,
      options
    )
    let projected = projection.messages
    const estimated = this.countProjected(
      projected,
      this.resolveTokenizer(options.contextProfile)
    )
    let snipCompaction: ContextSnipCompactionResult | undefined
    let microCompaction: ContextMicroCompactionResult | undefined

    if (
      budgetEnforcement === "strict" &&
      this.shouldCompact(estimated, hardMaxTokens, targetMaxTokens)
    ) {
      // Diagnostics: count snip boundaries and the union of removed ids so
      // we can tell whether the projection is actually filtering out the
      // already-snipped tail. Without this, a 410K estimator reading is
      // ambiguous between "projection saw 1800 records" and "projection
      // saw 478 retained but the tokenizer is over-counting".
      let snipBoundaries = 0
      const cumulativeRemovedIds = new Set<string>()
      for (const record of workingState.records) {
        if (
          record.kind === "snip_boundary" ||
          (record as { type?: string }).type === "snip_boundary"
        ) {
          snipBoundaries++
          const ids = (
            record as {
              snipMetadata?: { removedRecordIds?: readonly string[] }
            }
          ).snipMetadata?.removedRecordIds
          if (ids) {
            for (const id of ids) cumulativeRemovedIds.add(id)
          }
        }
      }
      const messageRecordCount = workingState.records.filter(
        (record) =>
          record.kind === "message" ||
          (record as { type?: string }).type === "message" ||
          (!record.kind &&
            (record.role === "user" || record.role === "assistant"))
      ).length
      this.recordPressureTelemetry(estimated, hardMaxTokens, targetMaxTokens, {
        totalRecords: workingState.records.length,
        messageRecords: messageRecordCount,
        snipBoundaries,
        cumulativeRemovedIds: cumulativeRemovedIds.size,
        projectedMessageCount: projected.length,
      })
      // Predictive warning: fire telemetry as we cross the 80% mark
      // before we actually compact. autoCompactTokenLimit is the same
      // ceiling resolvePressureBudget reads against.
      if (!options.dryRun && options.autoCompactTokenLimit) {
        this.compactWarningHook.maybeEmit({
          state: workingState,
          estimatedTokens: estimated,
          autoCompactLimit: options.autoCompactTokenLimit,
        })
      }
    }

    // Boundary model + cc-faithful microcompact (services/compact/
    // microCompact.ts). The projection is the boundary summary followed
    // by every post-boundary record. Under context pressure we
    // additionally content-clear OLD tool results from read/search/shell/
    // web tools: the most recent results stay verbatim, older ones are
    // replaced by a marker. Nothing is lost permanently — state.records
    // keep the full text; this is a per-send projection transform,
    // re-evaluated every round. It keeps context lean between LLM
    // boundary compactions without the over-aggressive whole-history
    // stripping that once collapsed the model's own findings
    // (~133K -> ~33K). True size reduction still comes from
    // compactIfNeeded. If the provider projection still exceeds its window,
    // the caller must run the provider-owned compaction path; this read model
    // never drops an arbitrary transcript prefix to force a request through.
    if (this.shouldCompact(estimated, hardMaxTokens, targetMaxTokens)) {
      const microcompacted = this.microcompactProjectedToolResults(
        projected,
        tokenizer
      )
      if (microcompacted) {
        projected = microcompacted.projectedMessages
        microCompaction = {
          changed: true,
          clearedToolResults: microcompacted.clearedToolResults,
        }
      }
    }

    const messages = this.sanitizeProjectedMessages(projected, {
      integrityMode: options.integrityMode,
      pendingToolUseIds: options.pendingToolUseIds,
      provider:
        options.contextProfile?.family === "claude" && options.claudeCapability
          ? "claude"
          : options.dynamicAttachmentMode === "provider-native"
            ? "codex"
            : "generic",
    })
    const finalMessages = messages
    const messageTokens = this.tokenCounter.countMessages(
      messages,
      true,
      tokenizer
    )
    if (
      messageTokens > hardMaxTokens &&
      budgetEnforcement === "strict" &&
      (options.budgetBoundary ?? "projected-messages") === "projected-messages"
    ) {
      this.telemetry.recordEvent({
        event: "compaction.projection_budget_exceeded",
        metadata: {
          estimatedTokens: messageTokens,
          maxTokens: hardMaxTokens,
        },
      })
      throw new ContextProjectionBudgetExceededError(
        messageTokens,
        hardMaxTokens
      )
    }

    const projectionManifest = projection.claudeManifest
      ? structuredClone(projection.claudeManifest)
      : undefined

    if (budgetEnforcement === "strict") {
      this.recordResultTelemetry(snipCompaction)
    }

    return {
      messages: finalMessages,
      projectedMessages: projected,
      estimatedTokens: messageTokens,
      wasCompacted: false,
      projectionManifest,
      snipCompaction,
      microCompaction,
    }
  }

  prepareCompactionCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      /**
       * Exact provider-visible context count from an already-built request
       * candidate, excluding `systemPromptTokens`. Zero is valid. This is
       * deliberately a direct measurement, never an estimate derived from
       * another provider's projection.
       */
      projectedTokenCount?: number
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
      dynamicAttachmentMode?: "history" | "provider-native"
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      visibleSessionMemorySourceRecordUuids?: Iterable<string>
      force?: boolean
    }
  ): ContextCompactionCandidate | null {
    const { hardMaxTokens, effectiveMaxTokens } =
      this.resolveCompactionPressureBudget(options)
    const exactProviderTokenCount = this.validateProviderProjectedTokenCount(
      options.projectedTokenCount
    )
    const projectedTokens =
      exactProviderTokenCount ??
      this.countProjected(
        this.buildProjectedMessages(
          state,
          snapshot,
          this.resolveAttachmentBudget(hardMaxTokens),
          options
        ).messages,
        this.resolveTokenizer(options.contextProfile)
      )
    if (!options.force && projectedTokens <= effectiveMaxTokens) {
      this.logger.debug(
        `prepareCompactionCandidate: skipped (projected=${projectedTokens} <= effective=${effectiveMaxTokens}, ` +
          (exactProviderTokenCount !== undefined
            ? "source=prepared-provider-request, "
            : "source=context-projection, ") +
          `hardMax=${hardMaxTokens}, sysPrompt=${options.systemPromptTokens}, ` +
          `auto=${options.autoCompactTokenLimit ?? "(none)"}, pred=${options.predictiveCompactTokenLimit ?? "(none)"})`
      )
      return null
    }
    // Building attachments belongs to the candidate, not the pressure gate.
    // In the common healthy path with a provider-exact measurement this work
    // must not happen at all; the already-built provider request is reused.
    const attachmentTokenBudget = this.resolveAttachmentBudget(hardMaxTokens)
    const candidate = this.prepareFullCandidate(
      state,
      snapshot,
      attachmentTokenBudget,
      options.strategy || "auto",
      options.contextProfile,
      options.integrityMode,
      options.claudeCapability,
      options.claudeRecipe
    )
    if (!candidate) {
      this.logger.debug(
        `prepareCompactionCandidate: prepareFullCandidate returned null ` +
          `(projected=${projectedTokens}, effective=${effectiveMaxTokens}, ` +
          `attachmentBudget=${attachmentTokenBudget}, strategy=${options.strategy || "auto"})`
      )
    }
    return candidate
  }

  /**
   * Build the generic graph/source metadata for a compaction already selected
   * by a provider-native projection.  Unlike prepareCompactionCandidate(),
   * this method intentionally does not inspect or measure the generic
   * transcript to decide whether compaction should happen.  Callers must make
   * that decision from their provider's exact prompt representation first.
   */
  prepareCompactionMappingCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      /**
       * Provider-native sources installed in the compact request. Records
       * appended after the last mapped source belong to the pending turn and
       * must stay outside a pre-turn compaction.
       */
      sourceRecordIds?: readonly string[]
    }
  ): ContextCompactionCandidate | null {
    const { hardMaxTokens } = this.resolveCompactionPressureBudget(options)
    const attachmentTokenBudget = this.resolveAttachmentBudget(hardMaxTokens)
    return this.prepareFullCandidate(
      state,
      snapshot,
      attachmentTokenBudget,
      options.strategy || "auto",
      options.contextProfile,
      options.integrityMode,
      options.claudeCapability,
      options.claudeRecipe,
      options.sourceRecordIds
    )
  }

  /**
   * Resolve a compaction pressure budget without projecting transcript data.
   * Provider-specific compactors use this to compare their exact wire/native
   * prompt token count against the shared configured limits.
   */
  resolveCompactionPressureBudget(options: {
    maxTokens: number
    systemPromptTokens: number
    autoCompactTokenLimit?: number
    predictiveCompactTokenLimit?: number
  }): ContextCompactionPressureBudget {
    const hardMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    return {
      hardMaxTokens,
      effectiveMaxTokens: this.resolvePressureBudget(hardMaxTokens, options),
    }
  }

  /**
   * Build an exact post-compact projection without mutating the mounted
   * context. Durable projection owners use this to commit their immutable
   * layout first, then install the same plan into hot state in the caller's
   * single ContextPipeline mutation.
   */
  buildGeneratedSummaryCompactionPlan(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    candidate: ContextCompactionCandidate,
    input: Pick<ContextCompactionInstallInput, "summary" | "hookUserMessage">
  ): ContextCompactionPlan {
    this.assertCandidateStillCurrent(state, candidate)
    const attachmentTokenBudget = this.resolveAttachmentBudget(
      candidate.retainedTokenCount +
        candidate.sourceTokenCount +
        candidate.summaryOutputTokenLimit
    )
    const plan = this.buildPlanFromCandidate(
      state,
      snapshot,
      attachmentTokenBudget,
      candidate,
      input.summary,
      input.hookUserMessage
    )
    return plan
  }

  /**
   * Validate and materialize the complete hot-state transition before the
   * durable provider-neutral/provider-native projection commit.
   */
  prepareGeneratedSummaryCompactionInstall(
    state: ContextConversationState,
    candidate: ContextCompactionCandidate,
    plan: ContextCompactionPlan,
    input: Omit<ContextCompactionInstallInput, "summary" | "hookUserMessage">
  ): PreparedContextCompactionInstall {
    this.assertCandidateStillCurrent(state, candidate)
    if (plan.commit.id !== candidate.commitId) {
      throw new Error(
        `Compaction plan ${plan.commit.id} does not belong to candidate ${candidate.commitId}`
      )
    }
    const next = this.prepareCompactionState(state, plan, Date.now())
    return {
      state,
      next,
      ...((input.emitTelemetry ?? true)
        ? {
            telemetry: {
              archivedMessageCount: plan.commit.archivedMessageCount,
              sourceTokenCount: plan.commit.sourceTokenCount,
              summaryTokenCount: plan.commit.summaryTokenCount,
              epoch: next.compactionEpoch,
            },
          }
        : {}),
    }
  }

  /**
   * Transfer a prevalidated compaction receipt after its durable commit.
   * This method deliberately contains assignments and best-effort telemetry
   * only; it must never discover a new reason to reject the accepted commit.
   */
  applyPreparedGeneratedSummaryCompaction(
    prepared: PreparedContextCompactionInstall
  ): void {
    this.applyPreparedCompactionState(prepared.state, prepared.next)
    if (prepared.telemetry) {
      this.telemetry.recordEvent({
        event: "compaction.boundary_applied",
        metadata: prepared.telemetry,
      })
    }
  }

  /**
   * Prepare a "partial" compaction candidate around a chosen pivot record,
   * mirroring Claude Code's `partialCompactConversation`
   * (services/compact/compact.ts:801).
   *
   * direction='up_to': summarize every record before `pivotRecordId`, keep
   *   `pivotRecordId` and everything after it. This is the "topic switch"
   *   pivot — the user's most recent message stays as the kept anchor and
   *   all earlier exploration collapses into a summary.
   *
   * direction='from': summarize the records from `pivotRecordId` onward and
   *   keep what came before. Used to roll a long tangent into a summary
   *   while preserving the original mainline.
   *
   * Returns null when:
   *   - the pivot record is missing or out of bounds
   *   - either side of the pivot would be empty after slicing
   *   - tool_use/tool_result integrity cannot be preserved at the pivot
   */
  prepareUpToCompactionCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    return this.prepareDirectionalCandidate(
      state,
      snapshot,
      pivotRecordId,
      "up_to",
      options
    )
  }

  prepareFromCompactionCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    return this.prepareDirectionalCandidate(
      state,
      snapshot,
      pivotRecordId,
      "from",
      options
    )
  }

  private prepareDirectionalCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    pivotRecordId: string,
    direction: "up_to" | "from",
    options: {
      maxTokens: number
      systemPromptTokens: number
      contextProfile?: ContextModelProfile
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      strategy?: ContextCompactionCommit["strategy"]
      integrityMode?: "strict-adjacent" | "global"
    }
  ): ContextCompactionCandidate | null {
    const tokenizer = this.resolveTokenizer(options.contextProfile)
    const hardMaxTokens = Math.max(
      options.maxTokens - options.systemPromptTokens,
      this.MIN_REQUEST_BUDGET
    )
    const attachmentTokenBudget = this.resolveAttachmentBudget(hardMaxTokens)
    const activeSlice = getRecordsAfterCompactBoundary(state.records)
    const sourceRecords = this.compactionSourceRecords(activeSlice)
    if (sourceRecords.length === 0) {
      return null
    }
    const mode: ContextCompactionMode = direction
    const split = splitContextCompactionRecords(
      sourceRecords,
      mode,
      pivotRecordId
    )
    if (!split) return null
    const { archivedRecords, retainedRecords } = split
    if (
      !archivedRecords.some(isMessageRecord) ||
      !this.compactionSlicesHaveIntegrity(
        archivedRecords,
        retainedRecords,
        options.integrityMode
      )
    ) {
      return null
    }

    const liveAttachments = this.attachments.buildAttachments(
      this.buildAttachmentSnapshotForRetainedRecords(
        state,
        snapshot,
        retainedRecords
      ),
      { maxTokens: attachmentTokenBudget }
    )
    const attachmentFingerprint = fingerprintAttachments(liveAttachments)
    const sourceTokenCount = this.tokenCounter.countMessages(
      archivedRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[],
      true,
      tokenizer
    )
    const retainedTokenCount = this.tokenCounter.countMessages(
      retainedRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[],
      true,
      tokenizer
    )
    const graphWatermarkUuid = requireMountedGraphWatermark(
      state.graphWatermarkUuid
    )

    return {
      mode,
      commitId: randomUUID(),
      strategy: options.strategy || "manual",
      createdAt: Date.now(),
      nextEpoch: (state.compactionEpoch || 0) + 1,
      archivedRecords,
      retainedRecords,
      summaryInputRecords:
        mode === "from" ? [...sourceRecords] : [...archivedRecords],
      summaryOutputTokenLimit: CONTEXT_COMPACT_MAX_OUTPUT_TOKENS,
      contextProfile: options.contextProfile,
      claudeCapability: options.claudeCapability,
      claudeRecipe: options.claudeRecipe,
      attachmentFingerprint,
      liveAttachments,
      sourceTokenCount,
      retainedTokenCount,
      sourceStateRecords: state.records,
      sourceToolResultReplacementState: state.toolResultReplacementState,
      graphWatermarkUuid,
    }
  }

  private prepareFullCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    strategy: ContextCompactionCommit["strategy"],
    contextProfile?: ContextModelProfile,
    _integrityMode?: "strict-adjacent" | "global",
    claudeCapability?: ClaudeProjectionCapabilitySnapshot,
    claudeRecipe?: ClaudeProjectionRecipe,
    sourceRecordIds?: readonly string[]
  ): ContextCompactionCandidate | null {
    const commitId = randomUUID()
    const tokenizer = this.resolveTokenizer(contextProfile)
    const completeActiveSlice = getRecordsAfterCompactBoundary(state.records)
    const activeSlice = sourceRecordIds
      ? sliceContextRecordsThroughMappedSources(
          completeActiveSlice,
          sourceRecordIds
        )
      : completeActiveSlice
    const sourceRecords = this.compactionSourceRecords(activeSlice)
    const messageRecords = sourceRecords.filter(isMessageRecord)
    if (sourceRecords.length <= 1 || messageRecords.length === 0) {
      this.logger.debug(
        `prepareFullCandidate: too few source records ` +
          `(source=${sourceRecords.length}, message=${messageRecords.length})`
      )
      return null
    }
    const split = splitContextCompactionRecords(sourceRecords, "full")
    if (!split) return null
    const archivedRecords = split.archivedRecords
    const retainedRecords = split.retainedRecords
    const liveAttachments = this.attachments.buildAttachments(
      this.buildAttachmentSnapshotForRetainedRecords(
        state,
        snapshot,
        retainedRecords
      ),
      {
        maxTokens: attachmentTokenBudget,
      }
    )
    const attachmentFingerprint = fingerprintAttachments(liveAttachments)
    const sourceTokenCount = this.tokenCounter.countMessages(
      archivedRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[],
      true,
      tokenizer
    )
    const retainedTokenCount = this.tokenCounter.countMessages(
      retainedRecords.map((record) => ({
        role: record.role,
        content: record.content,
      })) as UnifiedMessage[],
      true,
      tokenizer
    )
    const graphWatermarkUuid = requireMountedGraphWatermark(
      state.graphWatermarkUuid
    )

    return {
      mode: "full",
      commitId,
      strategy,
      createdAt: Date.now(),
      nextEpoch: (state.compactionEpoch || 0) + 1,
      archivedRecords,
      retainedRecords,
      summaryInputRecords: [...archivedRecords],
      summaryOutputTokenLimit: CONTEXT_COMPACT_MAX_OUTPUT_TOKENS,
      contextProfile,
      claudeCapability,
      claudeRecipe,
      attachmentFingerprint,
      liveAttachments,
      sourceTokenCount,
      retainedTokenCount,
      sourceStateRecords: state.records,
      sourceToolResultReplacementState: state.toolResultReplacementState,
      graphWatermarkUuid,
    }
  }

  private buildPlanFromCandidate(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    candidate: ContextCompactionCandidate,
    summaryText: string,
    hookUserMessage?: string
  ): ContextCompactionPlan {
    const summary = summaryText.trim()
    const summaryTokenCount = this.tokenCounter.countText(
      summary,
      true,
      this.resolveTokenizer(candidate.contextProfile)
    )
    const archivedRecords = candidate.archivedRecords
    const retainedRecords = candidate.retainedRecords
    const commitId = candidate.commitId
    const archivedThroughRecordId =
      archivedRecords[archivedRecords.length - 1]!.id
    const commit: ContextCompactionCommit = {
      id: commitId,
      strategy: candidate.strategy,
      createdAt: candidate.createdAt,
      epoch: candidate.nextEpoch,
      parentCompactionId: state.activeCompactionId,
      archivedThroughRecordId,
      projectionAnchorRecordId: retainedRecords[0]?.id,
      archivedMessageCount: archivedRecords.filter(isMessageRecord).length,
      sourceRecordCount: archivedRecords.length,
      retainedStartRecordId: retainedRecords[0]?.id,
      retainedRecordCount: retainedRecords.length,
      retainedTextRecordCount: this.countTextRecords(retainedRecords),
      retainedTokenCount: candidate.retainedTokenCount,
      attachmentFingerprint: candidate.attachmentFingerprint,
      sourceTokenCount: candidate.sourceTokenCount,
      summary,
      summaryTokenCount,
      projectedTokenCount: 0,
    }
    const createdAt = Date.now()
    const attachmentRecords = candidate.liveAttachments.map(
      (attachment, index) =>
        createAttachmentRecord(attachment, commit.id, createdAt + 2 + index)
    )
    const hookResultRecords = hookUserMessage?.trim()
      ? [
          createHookResultRecord(
            {
              compactionId: commit.id,
              trigger: commit.strategy,
              content: hookUserMessage.trim(),
            },
            createdAt + 2 + attachmentRecords.length
          ),
        ]
      : []
    const boundaryRecord = createCompactBoundaryRecord(commit, createdAt)
    const summaryRecord = createCompactSummaryRecord(commit, createdAt + 1)
    const compactProjectionRecords = orderContextCompactionProjectionRecords(
      candidate.mode,
      boundaryRecord,
      summaryRecord,
      retainedRecords,
      [...attachmentRecords, ...hookResultRecords]
    )
    const orderedProjectionRecords = rebaseSnipBoundariesIntoCompactProjection(
      state.records,
      compactProjectionRecords,
      retainedRecords
    )
    const claudeRecipe =
      candidate.contextProfile?.family === "claude" &&
      candidate.claudeCapability
        ? this.claudeProjector.buildRecipe({
            commitId: commit.id,
            createdAt: commit.createdAt,
            boundaryRecordId: boundaryRecord.id,
            summaryRecordId: summaryRecord.id,
            orderedRecords: orderedProjectionRecords,
            archivedRecords,
            attachmentRecordIds: attachmentRecords.map((record) => record.id),
            hookResultRecordIds: hookResultRecords.map((record) => record.id),
            capability: candidate.claudeCapability,
          })
        : undefined
    const simulatedState = this.cloneState(state)
    const simulatedPlan: ContextCompactionPlan = {
      commit,
      projectedMessages: [],
      estimatedTokens: 0,
      attachmentFingerprint: candidate.attachmentFingerprint,
      recordCount: state.records.length,
      retainedRecords,
      boundaryRecord,
      summaryRecord,
      orderedProjectionRecords,
      attachmentRecords,
      hookResultRecords,
      graphWatermarkUuid: candidate.graphWatermarkUuid,
    }
    this.applyPreparedCompactionState(
      simulatedState,
      this.prepareCompactionState(simulatedState, simulatedPlan, Date.now())
    )
    const projection = this.buildProjectedMessages(
      simulatedState,
      snapshot,
      attachmentTokenBudget,
      {
        contextProfile: candidate.contextProfile,
        claudeCapability: candidate.claudeCapability,
        claudeRecipe,
      }
    )
    const projectedMessages = projection.messages
    const claudeProjection = claudeRecipe
      ? (() => {
          if (!projection.claudeManifest) {
            throw new Error(
              `Claude compaction plan ${commit.id} produced no provider manifest`
            )
          }
          return {
            recipe: structuredClone(claudeRecipe),
            manifest: structuredClone(projection.claudeManifest),
          }
        })()
      : undefined
    commit.projectedTokenCount = this.countProjected(
      projectedMessages,
      this.resolveTokenizer(candidate.contextProfile)
    )

    return {
      commit,
      projectedMessages,
      estimatedTokens: commit.projectedTokenCount,
      attachmentFingerprint: candidate.attachmentFingerprint,
      recordCount: state.records.length,
      retainedRecords,
      boundaryRecord,
      summaryRecord,
      orderedProjectionRecords,
      attachmentRecords,
      hookResultRecords,
      claudeProjection,
      graphWatermarkUuid: candidate.graphWatermarkUuid,
    }
  }

  private assertCandidateStillCurrent(
    state: ContextConversationState,
    candidate: ContextCompactionCandidate
  ): void {
    const mountedWatermark =
      state.graphWatermarkUuid === undefined
        ? undefined
        : requireExactDurableIdentifier(
            state.graphWatermarkUuid,
            "Context compaction mounted main-graph watermark"
          )
    if (
      state.records !== candidate.sourceStateRecords ||
      state.toolResultReplacementState !==
        candidate.sourceToolResultReplacementState ||
      mountedWatermark !== candidate.graphWatermarkUuid ||
      (state.compactionEpoch || 0) + 1 !== candidate.nextEpoch
    ) {
      throw new StaleContextCompactionCandidateError()
    }
  }

  private prepareCompactionState(
    state: ContextConversationState,
    plan: ContextCompactionPlan,
    appliedAt: number
  ): PreparedContextCompactionState {
    let graphWatermarkUuid: string
    try {
      graphWatermarkUuid = requireExactDurableIdentifier(
        plan.graphWatermarkUuid,
        `Context compaction plan ${plan.commit.id} main-graph watermark`
      )
    } catch {
      throw new Error(
        `Context compaction plan ${plan.commit.id} has an invalid main-graph watermark`
      )
    }
    const compactionEpoch = plan.commit.epoch
    if (
      typeof compactionEpoch !== "number" ||
      !Number.isSafeInteger(compactionEpoch) ||
      compactionEpoch <= 0
    ) {
      throw new Error(
        `Context compaction plan ${plan.commit.id} has an invalid epoch`
      )
    }
    if (!Number.isSafeInteger(appliedAt) || appliedAt <= 0) {
      throw new Error(
        `Context compaction plan ${plan.commit.id} has an invalid install time`
      )
    }
    const records = [...plan.orderedProjectionRecords]
    return {
      records,
      graphWatermarkUuid,
      compactionHistory: deriveCompactionHistoryFromTranscript(records),
      activeCompactionId: plan.commit.id,
      compactionEpoch,
      lastAppliedCompaction: {
        recordCount: records.length,
        attachmentFingerprint: plan.attachmentFingerprint,
        appliedAt,
        compactionId: plan.commit.id,
        epoch: compactionEpoch,
      },
      compactWarningState: {
        ...state.compactWarningState,
        suppressed: true,
      },
    }
  }

  private applyPreparedCompactionState(
    state: ContextConversationState,
    next: PreparedContextCompactionState
  ): void {
    state.records = next.records
    state.graphWatermarkUuid = next.graphWatermarkUuid
    state.compactionHistory = next.compactionHistory
    state.activeCompactionId = next.activeCompactionId
    state.compactionEpoch = next.compactionEpoch
    state.lastAppliedCompaction = next.lastAppliedCompaction
    state.compactWarningState = next.compactWarningState
  }

  private buildProjectedMessages(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    attachmentTokenBudget: number,
    options?: {
      dynamicAttachmentMode?: "history" | "provider-native"
      contextProfile?: ContextModelProfile
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      claudeRecipe?: ClaudeProjectionRecipe
      pendingToolUseIds?: Iterable<string>
      visibleSessionMemorySourceRecordUuids?: Iterable<string>
    }
  ): ContextProjectionResult {
    return this.projection.project(state, {
      attachmentSnapshot: this.buildProjectionSnapshot(state, snapshot),
      attachmentTokenBudget,
      dynamicAttachmentMode: options?.dynamicAttachmentMode,
      claudeCapability:
        options?.contextProfile?.family === "claude"
          ? options.claudeCapability
          : undefined,
      claudeRecipe:
        options?.contextProfile?.family === "claude"
          ? options.claudeRecipe
          : undefined,
      visibleSessionMemorySourceRecordUuids:
        options?.visibleSessionMemorySourceRecordUuids,
    })
  }

  private buildProjectionSnapshot(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot
  ): ContextAttachmentSnapshot {
    return {
      ...snapshot,
      // Session memory is materialized only from the durable event state.
      // An attachment snapshot belongs to the current request and must never
      // become a second, external memory authority when the durable stream is
      // empty or unavailable.
      sessionMemory: this.sessionMemory.toAttachmentSummaries(
        state.sessionMemory
      ),
    }
  }

  /**
   * A compacted session-memory attachment is a projection of durable events,
   * not an independent summary. Before persisting that projection, remove a
   * terminal-delivery memory only when its exact graph source survives in the
   * candidate's retained provider-visible slice. An empty retained slice
   * intentionally removes nothing, so full compaction keeps the memory.
   */
  private buildAttachmentSnapshotForRetainedRecords(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    retainedRecords: readonly ContextTranscriptRecord[]
  ): ContextAttachmentSnapshot {
    const projectedSnapshot = this.buildProjectionSnapshot(state, snapshot)
    const visibleRecordIds = new Set(
      retainedRecords.filter(isMessageRecord).map((record) => record.id)
    )
    if (
      visibleRecordIds.size === 0 ||
      !projectedSnapshot.sessionMemory ||
      projectedSnapshot.sessionMemory.length === 0
    ) {
      return projectedSnapshot
    }
    const sessionMemory = projectedSnapshot.sessionMemory.filter(
      (memory, index) => {
        assertTerminalSessionMemoryProvenance(
          memory,
          `ContextCompactionService: sessionMemory[${index}]`
        )
        return !visibleRecordIds.has(memory.sourceRecordUuid)
      }
    )
    if (sessionMemory.length === projectedSnapshot.sessionMemory.length) {
      return projectedSnapshot
    }
    return { ...projectedSnapshot, sessionMemory }
  }

  private compactionSourceRecords(
    activeSlice: readonly ContextTranscriptRecord[]
  ): ContextTranscriptRecord[] {
    return activeSlice.filter(
      (record) => isMessageRecord(record) || isCompactSummaryRecord(record)
    )
  }

  private compactionSlicesHaveIntegrity(
    archivedRecords: readonly ContextTranscriptRecord[],
    retainedRecords: readonly ContextTranscriptRecord[],
    integrityMode?: "strict-adjacent" | "global"
  ): boolean {
    try {
      for (const records of [archivedRecords, retainedRecords]) {
        if (records.length === 0) continue
        this.toolIntegrity.assertProjectionIntegrity(
          records.map((record) => ({
            role: record.role,
            content: record.content,
            ...(record.messageId ? { messageId: record.messageId } : {}),
          })) as UnifiedMessage[],
          { mode: integrityMode }
        )
      }
      return true
    } catch (error) {
      this.logger.debug(
        `Rejected partial compaction boundary: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return false
    }
  }

  private sanitizeProjectedMessages(
    projected: ProjectedContextMessage[],
    options?: {
      pendingToolUseIds?: Iterable<string>
      integrityMode?: "strict-adjacent" | "global"
      provider?: "claude" | "codex" | "generic"
    }
  ): UnifiedMessage[] {
    const unified = projected.map((message) => ({
      role: message.role,
      content: message.content,
      // Preserve the Anthropic split-sibling key end-to-end so the
      // send-time normalize pipeline can fold siblings. Other projected
      // sources (boundary / summary / attachment / hook) have no
      // messageId — leaving the field undefined is correct there.
      ...(message.messageId ? { messageId: message.messageId } : {}),
      // cc-style isMeta — boundary / summary / attachment / hook
      // sources are infrastructure plumbing. Carry through so the
      // wire layer / transcript bridge can hide them. Only set when
      // true; absent on real user/assistant turns.
      ...(message.isMeta ? { isMeta: true } : {}),
      ...(message.source ? { source: message.source } : {}),
      ...(message.sourceUuid ? { sourceUuid: message.sourceUuid } : {}),
      ...(message.attachmentKind
        ? { attachmentKind: message.attachmentKind }
        : {}),
    })) as UnifiedMessage[]
    // Codex owns the fail-closed pair assertion after UnifiedMessages become
    // native RolloutItems, including the installed rollout plus reinjected
    // delta. Other providers can validate this provider-neutral projection
    // directly. Neither path fabricates or drops transcript blocks.
    if (options?.provider !== "codex") {
      this.toolIntegrity.assertProjectionIntegrity(unified, {
        mode: options?.integrityMode,
        pendingToolUseIds: options?.pendingToolUseIds,
      })
    }
    return unified
  }

  /**
   * cc-faithful microcompact: content-clear OLD tool results from
   * read-only/search/shell/web tools, keeping the most recent
   * MICROCOMPACT_KEEP_RECENT_RESULTS verbatim. Pure transform over the
   * projected view — the underlying transcript records keep their full
   * text, so it is reversible and re-evaluated every send. Returns a new
   * array when something was cleared, otherwise undefined.
   */
  private microcompactProjectedToolResults(
    projected: ProjectedContextMessage[],
    tokenizer: ContextTokenizer
  ):
    | {
        projectedMessages: ProjectedContextMessage[]
        clearedToolResults: number
      }
    | undefined {
    const toolNameById = new Map<string, string>()
    for (const message of projected) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        continue
      }
      for (const block of message.content) {
        const b = block as { type?: string; id?: unknown; name?: unknown }
        if (
          b?.type === "tool_use" &&
          typeof b.id === "string" &&
          typeof b.name === "string"
        ) {
          toolNameById.set(b.id, b.name)
        }
      }
    }

    const clearable: Array<{ messageIndex: number; blockIndex: number }> = []
    projected.forEach((message, messageIndex) => {
      if (!Array.isArray(message.content)) return
      message.content.forEach((block, blockIndex) => {
        const b = block as {
          type?: string
          tool_use_id?: unknown
          content?: unknown
        }
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") {
          return
        }
        const toolName = toolNameById.get(b.tool_use_id)
        if (
          !toolName ||
          !ContextCompactionService.MICROCOMPACTABLE_TOOLS.has(toolName)
        ) {
          return
        }
        const text = this.toolResultBlockText(b.content)
        if (text === this.MICROCOMPACT_CLEARED_MARKER) return
        if (
          this.tokenCounter.countText(text, true, tokenizer) <
          this.MICROCOMPACT_MIN_RESULT_TOKENS
        ) {
          return
        }
        clearable.push({ messageIndex, blockIndex })
      })
    })

    if (clearable.length <= this.MICROCOMPACT_KEEP_RECENT_RESULTS) {
      return undefined
    }

    const toClear = new Set(
      clearable
        .slice(0, clearable.length - this.MICROCOMPACT_KEEP_RECENT_RESULTS)
        .map((hit) => `${hit.messageIndex}:${hit.blockIndex}`)
    )

    return {
      projectedMessages: projected.map((message, messageIndex) => {
        if (!Array.isArray(message.content)) return message
        let touched = false
        const content = message.content.map((block, blockIndex) => {
          if (!toClear.has(`${messageIndex}:${blockIndex}`)) return block
          touched = true
          return {
            ...(block as object),
            content: this.MICROCOMPACT_CLEARED_MARKER,
          }
        })
        return touched
          ? {
              ...message,
              content: content as ProjectedContextMessage["content"],
            }
          : message
      }),
      clearedToolResults: toClear.size,
    }
  }

  private toolResultBlockText(content: unknown): string {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const p = part as { text?: unknown }
          return typeof p?.text === "string" ? p.text : ""
        })
        .join("\n")
    }
    return ""
  }

  private countProjected(
    projected: ProjectedContextMessage[],
    tokenizer: ContextTokenizer = "claude"
  ): number {
    return this.tokenCounter.countMessages(
      projected.map((message) => ({
        role: message.role,
        content: message.content,
      })) as UnifiedMessage[],
      true,
      tokenizer
    )
  }

  private resolveTokenizer(
    contextProfile: ContextModelProfile | undefined
  ): ContextTokenizer {
    return contextProfile?.tokenizer ?? "claude"
  }

  private resolvePressureBudget(
    hardMaxTokens: number,
    options: {
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      systemPromptTokens: number
    }
  ): number {
    const pressureLimits = [
      this.normalizePositiveInteger(options.autoCompactTokenLimit),
      this.normalizePositiveInteger(options.predictiveCompactTokenLimit),
    ]
      .filter((value): value is number => value != null)
      .map((value) =>
        Math.max(
          Math.min(value - options.systemPromptTokens, hardMaxTokens),
          this.MIN_REQUEST_BUDGET
        )
      )
      .filter((value) => value < hardMaxTokens)
    return pressureLimits.length > 0
      ? Math.min(...pressureLimits)
      : hardMaxTokens
  }

  private shouldCompact(
    estimated: number,
    hardMaxTokens: number,
    targetMaxTokens: number
  ): boolean {
    return estimated > hardMaxTokens || estimated >= targetMaxTokens
  }

  private recordPressureTelemetry(
    estimated: number,
    hardMaxTokens: number,
    targetMaxTokens: number,
    diagnostics?: {
      totalRecords: number
      messageRecords: number
      snipBoundaries: number
      cumulativeRemovedIds: number
      projectedMessageCount: number
    }
  ): void {
    if (targetMaxTokens < hardMaxTokens && estimated >= targetMaxTokens) {
      this.telemetry.recordEvent({
        event: "compaction.auto_compact_limit_reached",
        metadata: {
          hardMaxTokens,
          autoCompactTokenLimit: targetMaxTokens,
        },
      })
    }
    if (estimated > hardMaxTokens) {
      this.telemetry.recordEvent({
        event: "compaction.predictive_limit_reached",
        metadata: {
          hardMaxTokens,
          estimatedTokens: estimated,
        },
      })
      if (diagnostics) {
        this.logger.debug(
          `predictive_limit diag: estimated=${estimated} hardMax=${hardMaxTokens} ` +
            `totalRecords=${diagnostics.totalRecords} ` +
            `messageRecords=${diagnostics.messageRecords} ` +
            `snipBoundaries=${diagnostics.snipBoundaries} ` +
            `cumulativeRemovedIds=${diagnostics.cumulativeRemovedIds} ` +
            `projectedMessages=${diagnostics.projectedMessageCount}`
        )
      }
    }
  }

  private recordResultTelemetry(
    snipCompaction: ContextSnipCompactionResult | undefined
  ): void {
    if (snipCompaction?.changed) {
      this.telemetry.recordEvent({
        event: "compaction.snip_applied",
        metadata: {
          removedRecords: snipCompaction.removedRecords,
          retainedRecords: snipCompaction.retainedRecords,
          summaryTokenCount: snipCompaction.summaryTokenCount,
        },
      })
    }
  }

  private cloneState(
    state: ContextConversationState
  ): ContextConversationState {
    return {
      ...state,
      records: state.records.map((record) => ({ ...record })),
      compactionHistory: state.compactionHistory.map((commit) => ({
        ...commit,
      })),
      usageLedger: { ...state.usageLedger },
      lastAppliedCompaction: state.lastAppliedCompaction
        ? { ...state.lastAppliedCompaction }
        : undefined,
      compactWarningState: state.compactWarningState
        ? { ...state.compactWarningState }
        : undefined,
      toolResultReplacementState: state.toolResultReplacementState
        ? {
            seenToolUseIds: [
              ...state.toolResultReplacementState.seenToolUseIds,
            ],
            replacementByToolUseId: {
              ...state.toolResultReplacementState.replacementByToolUseId,
            },
            storedByToolUseId: {
              ...(state.toolResultReplacementState.storedByToolUseId || {}),
            },
            records: [...(state.toolResultReplacementState.records || [])],
          }
        : undefined,
      sessionMemory: state.sessionMemory.map((entry) => ({ ...entry })),
    }
  }

  private resolveAttachmentBudget(effectiveMaxTokens: number): number {
    return Math.min(
      this.ATTACHMENT_TOKEN_BUDGET,
      Math.max(
        this.MIN_ATTACHMENT_TOKENS,
        Math.floor(effectiveMaxTokens * 0.18)
      )
    )
  }

  private normalizePositiveInteger(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.floor(value)
  }

  private resolveBudgetEnforcement(
    value: ContextBudgetEnforcement | undefined
  ): ContextBudgetEnforcement {
    if (value === undefined || value === "strict") return "strict"
    if (value === "measure") return "measure"
    throw new Error(`Unknown context budget enforcement mode: ${String(value)}`)
  }

  private validateProviderProjectedTokenCount(
    value: number | undefined
  ): number | undefined {
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        "Provider projected token count must be a non-negative safe integer"
      )
    }
    return value
  }

  private countTextRecords(
    records: readonly ContextTranscriptRecord[]
  ): number {
    return records.filter((record) => {
      if (typeof record.content === "string") {
        return record.content.trim().length > 0
      }
      return record.content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 0
      )
    }).length
  }
}

function requireMountedGraphWatermark(value: unknown): string {
  try {
    return requireExactDurableIdentifier(
      value,
      "Context compaction mounted main-graph watermark"
    )
  } catch {
    throw new Error(
      "Context compaction candidate requires a mounted main-graph watermark"
    )
  }
}
