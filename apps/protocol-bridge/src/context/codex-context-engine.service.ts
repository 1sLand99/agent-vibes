import { Injectable, Logger } from "@nestjs/common"
import { createHash } from "crypto"
import {
  createCodexProjectionState,
  installCodexCompaction,
  linkCodexSourceRecords,
  projectCodexRemoteCompactionV2Input,
  recordCodexInputBindings,
  recordCodexRolloutMetadata,
  recordCodexResponseItems,
  replayCodexRollout,
  replaceCodexProjectionBindings,
  rollbackCodexProjectionUserTurns,
  type CodexCompactionInstallInput,
  type CodexProjectionBindingReplacementInput,
  type CodexProjectionInputBinding,
  type CodexProjectionRolloutItem,
  type CodexProjectionState,
  type CodexRecordInputBindingsInput,
  type CodexRecordedResponseItem,
  type CodexResponseRolloutRecord,
  type CodexRollbackInput,
  type CodexRollbackResult,
  type CodexSourceRecordLinkInput,
} from "../llm/openai/codex-projection-state"
import type { CodexInputItem } from "../llm/openai/codex-native-types"
import { stableCodexJsonStringify } from "../llm/openai/codex-incremental"
import { trimCodexFunctionCallOutputsToContextWindow } from "../llm/openai/codex-token-accounting"
import type { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import type { ContextModelProfile } from "./context-model-profile"
import {
  ContextCompactionService,
  type ContextCompactionCandidate,
  type ContextCompactionResult,
} from "./context-compaction.service"
import { requireExactDurableIdentifier } from "./durable-identifier"
import { isMessageRecord } from "./context-transcript-events"
import {
  ContextRequestPlannerService,
  type ContextProjectionBudget,
  type ContextProjectionOptions,
} from "./context-request-planner.service"
import { TokenCounterService } from "./token-counter.service"
import type {
  CodexReferenceContextItem,
  CodexReplacementHistoryItem,
  CodexTruncationPolicy,
  ContextConversationState,
} from "./types"

const DEFAULT_CODEX_TRUNCATION_POLICY: CodexTruncationPolicy = {
  mode: "bytes",
  limit: 10_000,
}

export interface CodexCompactReferenceInput {
  conversationId?: string
  model?: string
  systemPrompt?: string
  toolDefinitions?: unknown
  contextTokenLimit?: number
  serviceTier?: string
  reasoningEffort?: string
  truncationPolicy?: CodexTruncationPolicy
}

export type CodexGraphDeltaProjectionOptions = Omit<
  ContextProjectionOptions,
  | "dynamicAttachmentMode"
  | "budgetBoundary"
  | "visibleSessionMemorySourceRecordUuids"
> & {
  /** Exact durable graph records represented by the installed native window. */
  installedSourceRecordIds: Iterable<string>
}

/** Exact immutable state captured before a Remote Compaction V2 request. */
export interface CodexRemoteCompactRequest {
  rawHistory: readonly CodexInputItem[]
  preTriggerInput: readonly CodexInputItem[]
  expectedHistoryVersion: number
  expectedProjectionGeneration: number
  expectedWindowId: string
  signal: AbortSignal
}

/** Exact terminal artifacts returned by the normal Responses stream. */
export interface CodexRemoteCompactResult {
  preTriggerInput: readonly CodexInputItem[]
  requestInput: readonly CodexInputItem[]
  wireInput: readonly CodexInputItem[]
  compactionOutput: CodexReplacementHistoryItem
  responseId: string
  usage?: Readonly<Record<string, unknown>>
}

export type CodexRemoteCompactProvider = (
  request: CodexRemoteCompactRequest
) => Promise<CodexRemoteCompactResult>

export interface CodexContextCompactionCommit {
  id: string
  strategy: ContextCompactionCandidate["strategy"]
  createdAt: number
  archivedThroughRecordId: string
  archivedMessageCount: number
  sourceRecordCount: number
  sourceTokenCount: number
  retainedStartRecordId?: string
  retainedRecordCount: number
  retainedTokenCount: number
}

/**
 * Provider-neutral audit returned to Cursor orchestration. It deliberately has
 * no plaintext summary: V2 returns an opaque native compaction item, and the
 * generic transcript remains untouched for a future provider projection.
 */
export interface CodexContextCompactionPlan {
  commit: CodexContextCompactionCommit
  estimatedTokens: number
}

@Injectable()
export class CodexContextEngineService {
  private readonly logger = new Logger(CodexContextEngineService.name)

  constructor(
    private readonly compaction: ContextCompactionService,
    private readonly tokenCounter: TokenCounterService,
    private readonly planner: ContextRequestPlannerService
  ) {}

  /**
   * Project only graph facts that are absent from the installed native
   * history. The generic planner never receives a Codex coverage exception.
   */
  projectGraphDelta(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    budget: ContextProjectionBudget,
    options: CodexGraphDeltaProjectionOptions
  ): ContextCompactionResult {
    const installedSourceRecordIds = new Set(
      [...options.installedSourceRecordIds].map((sourceRecordId, index) =>
        requireExactDurableIdentifier(
          sourceRecordId,
          `Codex installed source record id[${index}]`
        )
      )
    )
    const deltaState: ContextConversationState = {
      ...state,
      records: state.records.filter(
        (record) => !installedSourceRecordIds.has(record.id)
      ),
    }
    const {
      installedSourceRecordIds: _installedSourceRecordIds,
      ...projectionOptions
    } = options
    return this.planner.projectState(deltaState, snapshot, budget, {
      ...projectionOptions,
      dynamicAttachmentMode: "provider-native",
      visibleSessionMemorySourceRecordUuids: installedSourceRecordIds,
      budgetBoundary: "provider-native-request",
    })
  }

  createProjectionState(nativeThreadId: string): CodexProjectionState {
    return createCodexProjectionState(nativeThreadId)
  }

  replayProjectionState(
    rollout: readonly CodexProjectionRolloutItem[],
    nativeThreadId: string
  ): CodexProjectionState {
    return replayCodexRollout(rollout, nativeThreadId)
  }

  recordProviderResponseItems(
    projectionState: CodexProjectionState,
    records: readonly CodexResponseRolloutRecord[]
  ): CodexRecordedResponseItem[] {
    return recordCodexResponseItems(projectionState, records)
  }

  recordProviderInputBindings(
    projectionState: CodexProjectionState,
    input: CodexRecordInputBindingsInput
  ): CodexProjectionInputBinding[] {
    return recordCodexInputBindings(projectionState, input)
  }

  linkProviderSourceRecord(
    projectionState: CodexProjectionState,
    input: CodexSourceRecordLinkInput
  ): void {
    linkCodexSourceRecords(projectionState, input)
  }

  replaceProviderInputBindings(
    projectionState: CodexProjectionState,
    input: CodexProjectionBindingReplacementInput
  ): void {
    replaceCodexProjectionBindings(projectionState, input)
  }

  recordProviderRolloutMetadata(
    projectionState: CodexProjectionState,
    input: {
      rolloutId: string
      kind: Extract<
        CodexProjectionRolloutItem,
        {
          kind: "turn_context" | "event_msg" | "inter_agent"
        }
      >["kind"]
      item: Record<string, unknown>
      recordedAt?: number
    }
  ): void {
    recordCodexRolloutMetadata(projectionState, input)
  }

  installProviderCompaction(
    projectionState: CodexProjectionState,
    input: CodexCompactionInstallInput
  ): void {
    installCodexCompaction(projectionState, input)
  }

  rollbackProviderProjection(
    projectionState: CodexProjectionState,
    input: CodexRollbackInput
  ): CodexRollbackResult {
    return rollbackCodexProjectionUserTurns(projectionState, input)
  }

  buildReferenceContextItem(
    input: CodexCompactReferenceInput
  ): CodexReferenceContextItem {
    return {
      conversationId: input.conversationId,
      model: input.model,
      systemPromptHash: input.systemPrompt
        ? this.hashStable(input.systemPrompt)
        : undefined,
      toolSpecHash: input.toolDefinitions
        ? this.hashStable(input.toolDefinitions)
        : undefined,
      contextTokenLimit: input.contextTokenLimit,
      serviceTier: input.serviceTier,
      reasoningEffort: input.reasoningEffort,
      truncationPolicy: {
        ...(input.truncationPolicy || DEFAULT_CODEX_TRUNCATION_POLICY),
      },
      updatedAt: Date.now(),
    }
  }

  async compactIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      /**
       * Request-wide fixed cost already included in `nativePressureTokens`.
       * It remains explicit for diagnostics and audit of the complete count.
       */
      providerRequestOverheadTokens: number
      contextProfile?: ContextModelProfile
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      /**
       * Exact complete token count of the pending native Codex request. For a
       * pre-turn compact this includes the not-yet-installed context and user
       * suffix even though that suffix is deliberately absent from the compact
       * request itself.
       */
      nativePressureTokens?: number
      /**
       * Exact immutable provider history owned by this compact operation.
       * Pre-turn callers supply the installed history; mid-turn callers supply
       * the complete staged sampling history.
       */
      nativeCompactionInput?: readonly CodexInputItem[]
      /** Graph source ids represented by nativeCompactionInput, for audit mapping. */
      mappedSourceRecordIds?: readonly string[]
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      referenceContextItem: CodexReferenceContextItem
      injectionMode: "pre_turn" | "mid_turn"
      /**
       * Lifecycle boundary for a real Remote Compaction V2 attempt. A skipped
       * pressure check never calls this callback.
       */
      onAttemptStarted?: (
        candidate: ContextCompactionCandidate
      ) => void | Promise<void>
      hookProvider?: (
        candidate: ContextCompactionCandidate
      ) => Promise<string | undefined>
      remoteCompactProvider: CodexRemoteCompactProvider
      projectionState: CodexProjectionState
      /** Required upstream identity; never inferred from a local reference. */
      nativeThreadId: string
      signal: AbortSignal
      meta?: {
        sessionId?: string
        conversationId?: string
        agentId?: string
        querySource?: string
      }
    }
  ): Promise<CodexContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const projectionState = options.projectionState
    const nativeThreadId = requireExactDurableIdentifier(
      options.nativeThreadId,
      "Codex Remote Compaction V2 native thread id"
    )
    if (projectionState.nativeThreadId !== nativeThreadId) {
      throw new Error(
        `Codex Remote Compaction V2 native thread mismatch: state=${projectionState.nativeThreadId}, input=${nativeThreadId}`
      )
    }
    const hasPreparedInput = options.nativeCompactionInput !== undefined
    const hasPreparedTokenCount = options.nativePressureTokens !== undefined
    const hasPreparedSourceMapping = options.mappedSourceRecordIds !== undefined
    if (
      hasPreparedInput !== hasPreparedTokenCount ||
      hasPreparedInput !== hasPreparedSourceMapping
    ) {
      throw new Error(
        "Codex native compaction boundary requires pressure, input, and source mapping from one prepared request boundary"
      )
    }
    const projectedCompactionInput =
      projectCodexRemoteCompactionV2Input(projectionState)
    const preTriggerInput = hasPreparedInput
      ? options.nativeCompactionInput!.map((item) => structuredClone(item))
      : projectedCompactionInput
    if (
      stableCodexJsonStringify(preTriggerInput) !==
      stableCodexJsonStringify(projectedCompactionInput)
    ) {
      throw new Error(
        "Codex native compaction input does not match its candidate projection state"
      )
    }
    const nativePressureTokens =
      options.nativePressureTokens ??
      this.tokenCounter.countJsonValue(preTriggerInput, true, "openai") +
        options.providerRequestOverheadTokens
    if (!Number.isFinite(nativePressureTokens) || nativePressureTokens < 0) {
      throw new Error("Codex native pressure token count must be finite")
    }
    // Codex candidate accounting already includes request-wide fixed cost, so
    // compare it with the complete configured window and auto-compact limit.
    const { effectiveMaxTokens } =
      this.compaction.resolveCompactionPressureBudget({
        maxTokens: options.maxTokens,
        systemPromptTokens: 0,
        autoCompactTokenLimit: options.autoCompactTokenLimit,
        predictiveCompactTokenLimit: options.predictiveCompactTokenLimit,
      })
    // A manual compact is an explicit user action and a reactive compact is
    // backed by a provider context-full signal.  Automatic compaction alone
    // is gated by the exact native prompt token count.
    const requiresCompaction =
      options.strategy === "manual" ||
      options.strategy === "reactive" ||
      nativePressureTokens > effectiveMaxTokens
    if (!requiresCompaction) {
      this.logger.debug(
        `Codex Remote Compaction V2 skipped: pressure=${nativePressureTokens} <= effective=${effectiveMaxTokens} ` +
          `providerRequestOverhead=${options.providerRequestOverheadTokens}`
      )
      return undefined
    }

    if (preTriggerInput.length === 0) {
      this.logger.debug(
        `Codex Remote Compaction V2 skipped: pressure=${nativePressureTokens}, installed native history is empty`
      )
      return undefined
    }

    // Generic context records provide durable source/UI accounting and hook
    // metadata only.  They are deliberately consulted after the native gate
    // above, so an untrimmed generic graph can never force another Codex
    // remote compaction after the native window was already replaced.
    const candidate = this.compaction.prepareCompactionMappingCandidate(
      state,
      snapshot,
      {
        maxTokens: options.maxTokens,
        systemPromptTokens: options.providerRequestOverheadTokens,
        contextProfile: options.contextProfile,
        autoCompactTokenLimit: options.autoCompactTokenLimit,
        predictiveCompactTokenLimit: options.predictiveCompactTokenLimit,
        strategy: options.strategy || "auto",
        integrityMode: options.integrityMode,
        sourceRecordIds:
          options.mappedSourceRecordIds ??
          projectionState.projectedSourceRecordIds,
      }
    )
    if (!candidate) {
      throw new Error(
        `Codex Remote Compaction V2 native pressure has no durable source mapping candidate ` +
          `(pressure=${nativePressureTokens}, effective=${effectiveMaxTokens}, ` +
          `providerRequestOverhead=${options.providerRequestOverheadTokens}, ` +
          `sourceRecords=${state.records.length}, ` +
          `conversation=${options.meta?.conversationId || options.referenceContextItem.conversationId || "(unknown)"})`
      )
    }

    await options.onAttemptStarted?.(candidate)
    options.signal.throwIfAborted()
    await options.hookProvider?.(candidate)
    options.signal.throwIfAborted()

    const rawHistory = projectionState.activeHistory.map((item) =>
      structuredClone(item)
    )
    const compactionInput = trimCodexFunctionCallOutputsToContextWindow({
      items: preTriggerInput,
      contextWindowTokens: options.maxTokens,
      requestOverheadTokens: options.providerRequestOverheadTokens,
    })
    if (compactionInput.rewrittenOutputs > 0) {
      this.logger.log(
        `Codex Remote Compaction V2 rewrote ${compactionInput.rewrittenOutputs} trailing tool outputs ` +
          `before=${compactionInput.estimatedTokensBefore} after=${compactionInput.estimatedTokensAfter} ` +
          `window=${options.maxTokens}`
      )
    }
    const expectedHistoryVersion = projectionState.historyVersion
    const expectedProjectionGeneration = projectionState.projectionGeneration
    const expectedWindowId = projectionState.activeWindow.windowId

    const compactResult = await options.remoteCompactProvider({
      rawHistory,
      preTriggerInput: compactionInput.input,
      expectedHistoryVersion,
      expectedProjectionGeneration,
      expectedWindowId,
      signal: options.signal,
    })
    options.signal.throwIfAborted()

    this.logger.debug(
      JSON.stringify({
        event: "codex.compaction_attempt_completed",
        compactionId: candidate.commitId,
        injectionMode: options.injectionMode,
        rawHistoryItems: rawHistory.length,
        preTriggerItems: compactResult.preTriggerInput.length,
        requestItems: compactResult.requestInput.length,
        wireItems: compactResult.wireInput.length,
        rawHistoryHash: this.hashStable(rawHistory),
        requestHash: this.hashStable(compactResult.requestInput),
        wireHash: this.hashStable(compactResult.wireInput),
        responseId: compactResult.responseId,
      })
    )

    installCodexCompaction(projectionState, {
      rolloutId: `compaction:${candidate.commitId}`,
      nativeThreadId,
      compactionId: candidate.commitId,
      injectionMode: options.injectionMode,
      expectedHistoryVersion,
      expectedProjectionGeneration,
      expectedWindowId,
      rawHistory,
      preTriggerInput: compactResult.preTriggerInput,
      requestInput: compactResult.requestInput,
      wireInput: compactResult.wireInput,
      compactionOutput: structuredClone(compactResult.compactionOutput),
      responseId: compactResult.responseId,
      usage: compactResult.usage,
    })

    const archivedThroughRecord = candidate.archivedRecords.at(-1)
    if (!archivedThroughRecord) {
      throw new Error("Codex compaction candidate has no archived records")
    }
    const plan: CodexContextCompactionPlan = {
      commit: {
        id: candidate.commitId,
        strategy: candidate.strategy,
        createdAt: candidate.createdAt,
        archivedThroughRecordId: archivedThroughRecord.id,
        archivedMessageCount:
          candidate.archivedRecords.filter(isMessageRecord).length,
        sourceRecordCount: candidate.archivedRecords.length,
        sourceTokenCount: candidate.sourceTokenCount,
        retainedStartRecordId: candidate.retainedRecords[0]?.id,
        retainedRecordCount: candidate.retainedRecords.length,
        retainedTokenCount: candidate.retainedTokenCount,
      },
      estimatedTokens: this.tokenCounter.countJsonValue(
        projectionState.activeHistory,
        true,
        "openai"
      ),
    }

    this.logger.log(
      `Codex Remote Compaction V2 installed commit=${plan.commit.id} ` +
        `mode=${options.injectionMode} window=${projectionState.activeWindow.windowId} ` +
        `items=${projectionState.activeHistory.length} response=${compactResult.responseId}`
    )
    return plan
  }

  private hashStable(value: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(this.sortJsonValue(value)))
      .digest("hex")
      .slice(0, 16)
  }

  private sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJsonValue(item))
    }
    if (!value || typeof value !== "object") return value
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = this.sortJsonValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }
}
