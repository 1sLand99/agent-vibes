import { Injectable, Logger } from "@nestjs/common"
import { createHash } from "crypto"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import {
  processCodexMessageContent,
  truncateCodexTextByBytes,
} from "./codex-context-content-policy"
import { orderCodexMetaMessagesBeforeTranscript } from "./codex-context-message-policy"
import { ContextCollapseService } from "./context-collapse.service"
import {
  ContextCompactionCandidate,
  ContextCompactionPlan,
  ContextCompactionService,
} from "./context-compaction.service"
import { repairOrphanedToolPairs } from "./orphan-tool-pair-repair"
import {
  deriveCompactionHistoryFromTranscript,
  isAttachmentRecord,
  isCompactSummaryRecord,
  isContextCollapseSummaryRecord,
  isHookResultRecord,
  isMessageRecord,
  resolveContextReplacementAnchor,
} from "./context-transcript-events"
import {
  buildTopicContinuityGuard,
  composeCompactHookMessage,
  extractLatestUserUtterance,
} from "./context-continuity-guard"
import { TokenCounterService } from "./token-counter.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import {
  CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
  CodexContextState,
  CodexContextWindowState,
  CodexRawResponseItemBlock,
  CodexReferenceContextItem,
  ContextCollapseCommit,
  CodexReplacementHistory,
  CodexReplacementHistoryItem,
  CodexTruncationPolicy,
  ContextConversationState,
  ContextTranscriptRecord,
  LooseMessageContent,
  UnifiedMessage,
  extractText,
} from "./types"

export const CODEX_SUMMARIZATION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n")

export const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"

export const CODEX_HISTORICAL_SUMMARY_NOTICE = [
  "This is compressed historical context, not the current task directive.",
  "Any later messages and topic-continuity guard that follow this summary are authoritative for the current request and next action.",
  "Do not resume a task from this summary unless later messages explicitly continue it.",
].join(" ")

const CODEX_EMPTY_REMOTE_COMPACTION_SUMMARY =
  "Remote compaction returned no textual summary after filtering synthetic context. Continue from the compacted context and any later messages."

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

export interface CodexRemoteCompactRequest {
  messages: UnifiedMessage[]
  maxTokens: number
  candidate: ContextCompactionCandidate
  referenceContextItem: CodexReferenceContextItem
  /**
   * Aborted when the surrounding turn is superseded or cancelled. The
   * provider must thread this through to the underlying Codex Responses
   * compact request so a stale compaction does not race the next turn.
   */
  signal: AbortSignal
}

export interface CodexRemoteCompactResult {
  replacementHistory: CodexReplacementHistoryItem[]
}

export type CodexRemoteCompactProvider = (
  request: CodexRemoteCompactRequest
) => Promise<CodexRemoteCompactResult>

export interface CodexProjectedMessagesResult {
  messages: UnifiedMessage[]
  hardFitApplied: boolean
  beforeHardFitTokens: number
  hardMaxTokens: number
}

@Injectable()
export class CodexContextAdapterService {
  private readonly logger = new Logger(CodexContextAdapterService.name)

  constructor(
    private readonly compaction: ContextCompactionService,
    private readonly contextCollapse: ContextCollapseService,
    private readonly tokenCounter: TokenCounterService,
    private readonly toolIntegrity: ToolIntegrityService
  ) {}

  ensureState(state: ContextConversationState): CodexContextState {
    if (!state.codexContext) {
      state.codexContext = {
        historyVersion: 0,
        truncationPolicy: { ...DEFAULT_CODEX_TRUNCATION_POLICY },
      }
    }
    if (!state.codexContext.truncationPolicy) {
      state.codexContext.truncationPolicy = {
        ...DEFAULT_CODEX_TRUNCATION_POLICY,
      }
    }
    if (state.codexContext.metaMessageLedger) {
      delete state.codexContext.metaMessageLedger
      state.codexContext.historyVersion =
        (state.codexContext.historyVersion || 0) + 1
    }
    return state.codexContext
  }

  resolveCurrentWindowState(
    state: ContextConversationState,
    conversationId: string
  ): CodexContextWindowState {
    const codex = this.ensureState(state)
    const activeWindow = this.resolveWindowState(
      codex,
      conversationId,
      Date.now()
    )
    codex.activeWindow = activeWindow
    return activeWindow
  }

  installReplacementHistoryWindow(
    state: ContextConversationState,
    input: {
      conversationId?: string
      compactionId: string
      createdAt?: number
      injectionMode: "pre_turn" | "mid_turn"
      anchorRecordId?: string
      summary: string
      items: CodexReplacementHistoryItem[]
    }
  ): CodexReplacementHistory {
    const codex = this.ensureState(state)
    const createdAt = input.createdAt ?? Date.now()
    const currentWindow = this.resolveWindowState(
      codex,
      input.conversationId,
      createdAt
    )
    const anchor = resolveContextReplacementAnchor(
      state.records,
      input.anchorRecordId || `compact_summary_${input.compactionId}`
    )
    const windowNumber = currentWindow.windowNumber + 1
    const windowId = this.buildWindowId(input.conversationId, windowNumber)
    const replacementHistory: CodexReplacementHistory = {
      compactionId: input.compactionId,
      createdAt,
      injectionMode: input.injectionMode,
      windowNumber,
      firstWindowId: currentWindow.firstWindowId,
      previousWindowId: currentWindow.windowId,
      windowId,
      anchorRecordId: anchor.anchorRecordId,
      anchorRecordCount: anchor.anchorRecordCount,
      summary: input.summary,
      items: input.items.map((item) => this.cloneReplacementItem(item)),
    }
    let installedOnCompactCommit = false
    for (const record of state.records) {
      const commit = record.compactMetadata?.commit
      if (commit?.id !== input.compactionId) continue
      commit.codexReplacementHistory = replacementHistory
      installedOnCompactCommit = true
    }
    if (installedOnCompactCommit) {
      state.compactionHistory = deriveCompactionHistoryFromTranscript(
        state.records
      )
    }
    codex.activeWindow = {
      windowNumber,
      firstWindowId: currentWindow.firstWindowId,
      previousWindowId: currentWindow.windowId,
      windowId,
      createdAt,
      compactionId: input.compactionId,
      replacementHistory,
    }
    codex.historyVersion = codex.historyVersion + 1
    return replacementHistory
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
      systemPromptTokens: number
      compactInputMaxTokens?: number
      compactInputSystemPromptTokens?: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      projectedTokenOverride?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      referenceContextItem: CodexReferenceContextItem
      injectionMode: "pre_turn" | "mid_turn"
      hookUserMessage?: string
      hookProvider?: (
        candidate: ContextCompactionCandidate
      ) => Promise<string | undefined>
      remoteCompactProvider: CodexRemoteCompactProvider
      signal: AbortSignal
      meta?: {
        sessionId?: string
        conversationId?: string
        agentId?: string
        querySource?: string
        notifyPromptCacheCompaction?: () => void
      }
    }
  ): Promise<ContextCompactionPlan | undefined> {
    options.signal.throwIfAborted()
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      {
        maxTokens: options.maxTokens,
        systemPromptTokens: options.systemPromptTokens,
        autoCompactTokenLimit: options.autoCompactTokenLimit,
        predictiveCompactTokenLimit: options.predictiveCompactTokenLimit,
        projectedTokenOverride: options.projectedTokenOverride,
        strategy: options.strategy || "auto",
        integrityMode: options.integrityMode,
      }
    )
    if (!candidate) return undefined

    const explicitHookUserMessage =
      options.hookUserMessage || (await options.hookProvider?.(candidate))
    const continuityGuard = buildTopicContinuityGuard(
      extractLatestUserUtterance(state)
    )
    const hookUserMessage = composeCompactHookMessage(
      explicitHookUserMessage,
      continuityGuard
    )
    options.signal.throwIfAborted()
    const compactMessages = this.projectRemoteCompactInputMessages(
      state,
      candidate,
      {
        maxTokens: options.compactInputMaxTokens ?? options.maxTokens,
        systemPromptTokens:
          options.compactInputSystemPromptTokens ?? options.systemPromptTokens,
        truncationPolicy: options.referenceContextItem.truncationPolicy,
        pendingToolUseIds: options.pendingToolUseIds,
      }
    )
    if (compactMessages.length === 0) {
      throw new Error(
        `Codex compact projection produced empty input history ` +
          `conversation=${options.meta?.conversationId || options.referenceContextItem.conversationId || "(unknown)"} ` +
          `archived=${candidate.archivedRecords.length} retained=${candidate.retainedRecords.length} ` +
          `sourceTokens=${candidate.sourceTokenCount}`
      )
    }
    const compactResult = await options.remoteCompactProvider({
      messages: compactMessages,
      maxTokens: candidate.summaryBudget,
      candidate,
      referenceContextItem: options.referenceContextItem,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const remoteReplacement = this.buildRemoteReplacementHistory(
      compactResult.replacementHistory,
      options.injectionMode,
      options.referenceContextItem
    )
    const replacementHistory = remoteReplacement.items
    const summary = remoteReplacement.summary
    const plan = this.compaction.applyGeneratedSummaryCompaction(
      state,
      snapshot,
      candidate,
      {
        summary,
        hookUserMessage,
        meta: options.meta,
      }
    )
    const codexReplacementHistory = this.installReplacementHistoryWindow(
      state,
      {
        conversationId: options.referenceContextItem.conversationId,
        compactionId: plan.commit.id,
        injectionMode: options.injectionMode,
        summary,
        items: replacementHistory,
      }
    )

    const codex = this.ensureState(state)
    codex.tokenInfo = {
      totalTokens: plan.estimatedTokens,
      modelContextWindow: options.maxTokens,
      updatedAt: Date.now(),
    }
    codex.referenceContextItem =
      options.injectionMode === "mid_turn"
        ? options.referenceContextItem
        : undefined
    codex.truncationPolicy = {
      ...options.referenceContextItem.truncationPolicy,
    }

    this.logger.log(
      `Codex compact applied commit=${plan.commit.id} mode=${options.injectionMode} ` +
        `window=${codexReplacementHistory.windowId} ` +
        `previousWindow=${codexReplacementHistory.previousWindowId || "none"} ` +
        `replacementItems=${replacementHistory.length} ` +
        `remoteRawItems=${remoteReplacement.rawItemCount} ` +
        `remoteFilteredItems=${remoteReplacement.filteredItemCount} ` +
        `remoteDiscardedItems=${remoteReplacement.discardedItemCount}`
    )
    return plan
  }

  async applyCollapsesIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      compactInputMaxTokens?: number
      compactInputSystemPromptTokens?: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
      pendingToolUseIds?: Iterable<string>
      referenceContextItem: CodexReferenceContextItem
      remoteCompactProvider: CodexRemoteCompactProvider
      signal: AbortSignal
    }
  ): Promise<ContextCollapseCommit | undefined> {
    options.signal.throwIfAborted()
    const candidate = this.compaction.prepareCompactionCandidate(
      state,
      snapshot,
      {
        maxTokens: options.maxTokens,
        systemPromptTokens: options.systemPromptTokens,
        autoCompactTokenLimit: options.autoCompactTokenLimit,
        predictiveCompactTokenLimit: options.predictiveCompactTokenLimit,
        strategy: options.strategy || "auto",
        integrityMode: options.integrityMode,
      }
    )
    if (!candidate) return undefined

    const compactMessages = this.projectRemoteCompactInputMessages(
      state,
      candidate,
      {
        maxTokens: options.compactInputMaxTokens ?? options.maxTokens,
        systemPromptTokens:
          options.compactInputSystemPromptTokens ?? options.systemPromptTokens,
        truncationPolicy: options.referenceContextItem.truncationPolicy,
        pendingToolUseIds: options.pendingToolUseIds,
      }
    )
    if (compactMessages.length === 0) {
      throw new Error(
        `Codex collapse projection produced empty input history ` +
          `conversation=${options.referenceContextItem.conversationId || "(unknown)"} ` +
          `archived=${candidate.archivedRecords.length} retained=${candidate.retainedRecords.length} ` +
          `sourceTokens=${candidate.sourceTokenCount}`
      )
    }
    const compactResult = await options.remoteCompactProvider({
      messages: compactMessages,
      maxTokens: candidate.summaryBudget,
      candidate,
      referenceContextItem: options.referenceContextItem,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const remoteReplacement = this.buildRemoteReplacementHistory(
      compactResult.replacementHistory,
      "pre_turn",
      options.referenceContextItem
    )
    const replacementHistory = remoteReplacement.items
    const summary = remoteReplacement.summary
    const commit = this.contextCollapse.applyGeneratedCollapse(
      state,
      candidate,
      { summary }
    )
    const codexReplacementHistory = this.installReplacementHistoryWindow(
      state,
      {
        conversationId: options.referenceContextItem.conversationId,
        compactionId: commit.id,
        injectionMode: "pre_turn",
        anchorRecordId: commit.summaryRecordId,
        summary,
        items: replacementHistory,
      }
    )
    this.logger.log(
      `Codex context collapse applied commit=${commit.id} ` +
        `window=${codexReplacementHistory.windowId} ` +
        `previousWindow=${codexReplacementHistory.previousWindowId || "none"} ` +
        `replacementItems=${replacementHistory.length} ` +
        `remoteRawItems=${remoteReplacement.rawItemCount} ` +
        `remoteFilteredItems=${remoteReplacement.filteredItemCount} ` +
        `remoteDiscardedItems=${remoteReplacement.discardedItemCount}`
    )
    return commit
  }

  projectCodexMessages(
    state: ContextConversationState,
    baseMessages: UnifiedMessage[],
    options: {
      maxTokens: number
      systemPromptTokens: number
      pendingToolUseIds?: Iterable<string>
      truncationPolicy?: CodexTruncationPolicy
      allowHardFit?: boolean
      replacementRecords?: readonly ContextTranscriptRecord[]
      useActiveReplacementHistory?: boolean
      includeLiveMetaMessages?: boolean
    }
  ): UnifiedMessage[] {
    return this.projectCodexMessagesWithMetadata(state, baseMessages, options)
      .messages
  }

  private projectRemoteCompactInputMessages(
    state: ContextConversationState,
    candidate: ContextCompactionCandidate,
    options: {
      maxTokens: number
      systemPromptTokens: number
      pendingToolUseIds?: Iterable<string>
      truncationPolicy?: CodexTruncationPolicy
    }
  ): UnifiedMessage[] {
    return this.projectCompactInputMessages(
      state,
      this.recordsToMessages(candidate.archivedRecords),
      options
    )
  }

  private projectCompactInputMessages(
    state: ContextConversationState,
    baseMessages: UnifiedMessage[],
    options: {
      maxTokens: number
      systemPromptTokens: number
      pendingToolUseIds?: Iterable<string>
      truncationPolicy?: CodexTruncationPolicy
    }
  ): UnifiedMessage[] {
    const codex = this.ensureState(state)
    const truncationPolicy = options.truncationPolicy || codex.truncationPolicy
    const pendingToolUseIds = new Set(options.pendingToolUseIds ?? [])
    let messages = repairOrphanedToolPairs(
      this.prepareMessagesForCodex(baseMessages, truncationPolicy),
      {
        pendingToolUseIds,
      }
    )
    const hardMaxTokens = Math.max(
      256,
      options.maxTokens - options.systemPromptTokens
    )
    const beforeHardFitTokens = this.tokenCounter.countMessages(messages)
    if (beforeHardFitTokens <= hardMaxTokens) {
      return messages
    }

    const fitted = this.extractCompactInputSuffix(
      messages,
      hardMaxTokens,
      pendingToolUseIds
    )
    const afterHardFitTokens = this.tokenCounter.countMessages(fitted)
    this.logger.warn(
      `[codex-compact-input] fitted archived compact input ` +
        `messages=${messages.length}->${fitted.length} ` +
        `tokens=${beforeHardFitTokens}->${afterHardFitTokens} ` +
        `budget=${hardMaxTokens}`
    )
    messages = fitted
    return messages
  }

  private extractCompactInputSuffix(
    messages: UnifiedMessage[],
    hardMaxTokens: number,
    pendingToolUseIds?: Iterable<string>
  ): UnifiedMessage[] {
    const startIndex = this.tokenCounter.findTruncationIndex(
      messages,
      hardMaxTokens
    )
    for (let index = startIndex; index <= messages.length; index++) {
      const candidate = repairOrphanedToolPairs(messages.slice(index), {
        pendingToolUseIds,
      })
      if (
        candidate.length > 0 &&
        this.tokenCounter.countMessages(candidate) <= hardMaxTokens
      ) {
        return candidate
      }
    }
    return []
  }

  projectCodexMessagesWithMetadata(
    state: ContextConversationState,
    baseMessages: UnifiedMessage[],
    options: {
      maxTokens: number
      systemPromptTokens: number
      pendingToolUseIds?: Iterable<string>
      truncationPolicy?: CodexTruncationPolicy
      allowHardFit?: boolean
      replacementRecords?: readonly ContextTranscriptRecord[]
      useActiveReplacementHistory?: boolean
      includeLiveMetaMessages?: boolean
    }
  ): CodexProjectedMessagesResult {
    const codex = this.ensureState(state)
    const truncationPolicy = options.truncationPolicy || codex.truncationPolicy
    let messages = baseMessages
    let protectedPrefixCount = 0
    const replacement =
      options.useActiveReplacementHistory === false
        ? undefined
        : codex.activeWindow?.replacementHistory
    if (replacement?.items?.length) {
      const replacementMessages = this.replacementHistoryToMessages(
        replacement.items
      )
      if (replacementMessages.length > 0) {
        protectedPrefixCount = replacementMessages.length
        const postAnchor = this.recordsAfterReplacementAnchor(
          options.replacementRecords || state.records,
          replacement.anchorRecordId,
          state.records
        )
        messages = [
          ...replacementMessages,
          ...this.recordsToPostReplacementMessages(postAnchor),
        ]
      }
    }

    const preparedMessages = this.prepareMessagesForCodex(
      messages,
      truncationPolicy
    )
    messages = repairOrphanedToolPairs(
      options.includeLiveMetaMessages === false
        ? preparedMessages
        : this.projectCurrentLiveMetaMessages(preparedMessages),
      {
        pendingToolUseIds: options.pendingToolUseIds,
      }
    )
    const hardMaxTokens = Math.max(
      256,
      options.maxTokens - options.systemPromptTokens
    )
    const beforeHardFitTokens = this.tokenCounter.countMessages(messages)
    if (
      beforeHardFitTokens <= hardMaxTokens ||
      options.allowHardFit === false
    ) {
      return {
        messages,
        hardFitApplied: false,
        beforeHardFitTokens,
        hardMaxTokens,
      }
    }

    const retained =
      protectedPrefixCount > 0
        ? this.extractWithProtectedPrefix(messages, hardMaxTokens, {
            protectedPrefixCount,
            pendingToolUseIds: options.pendingToolUseIds,
          })
        : repairOrphanedToolPairs(
            this.toolIntegrity.extractWithIntegrity(messages, hardMaxTokens, {
              mode: "global",
            }),
            {
              pendingToolUseIds: options.pendingToolUseIds,
            }
          )
    return {
      messages: retained,
      hardFitApplied: retained.length < messages.length,
      beforeHardFitTokens,
      hardMaxTokens,
    }
  }

  private extractWithProtectedPrefix(
    messages: UnifiedMessage[],
    hardMaxTokens: number,
    options: {
      protectedPrefixCount: number
      pendingToolUseIds?: Iterable<string>
    }
  ): UnifiedMessage[] {
    const prefixCount = Math.max(
      0,
      Math.min(options.protectedPrefixCount, messages.length)
    )
    const protectedPrefix = messages.slice(0, prefixCount)
    const suffix = messages.slice(prefixCount)
    const prefixTokens = this.tokenCounter.countMessages(protectedPrefix)
    if (prefixTokens > hardMaxTokens) {
      throw new Error(
        `Codex replacement history exceeds context window (${prefixTokens} > ${hardMaxTokens})`
      )
    }
    const suffixBudget = Math.max(0, hardMaxTokens - prefixTokens)
    const retainedSuffix =
      suffixBudget > 0 && suffix.length > 0
        ? this.toolIntegrity.extractWithIntegrity(suffix, suffixBudget, {
            mode: "global",
          })
        : []

    return repairOrphanedToolPairs([...protectedPrefix, ...retainedSuffix], {
      pendingToolUseIds: options.pendingToolUseIds,
    })
  }

  prepareMessagesForCodex(
    messages: UnifiedMessage[],
    policy: CodexTruncationPolicy = DEFAULT_CODEX_TRUNCATION_POLICY
  ): UnifiedMessage[] {
    return messages.map((message) => ({
      ...message,
      content: processCodexMessageContent(message.content, policy),
    })) as UnifiedMessage[]
  }

  private processRemoteReplacementHistory(
    items: CodexReplacementHistoryItem[],
    _injectionMode: "pre_turn" | "mid_turn",
    _referenceContextItem: CodexReferenceContextItem
  ): CodexReplacementHistoryItem[] {
    const filtered = items.filter((item) =>
      this.shouldKeepRemoteHistoryItem(item)
    )
    if (filtered.length !== items.length) {
      this.logger.debug(
        `Filtered Codex replacement history items: ${items.length}->${filtered.length}`
      )
    }
    return filtered
  }

  private buildRemoteReplacementHistory(
    items: CodexReplacementHistoryItem[],
    injectionMode: "pre_turn" | "mid_turn",
    referenceContextItem: CodexReferenceContextItem
  ): {
    summary: string
    items: CodexReplacementHistoryItem[]
    rawItemCount: number
    filteredItemCount: number
    discardedItemCount: number
  } {
    const filtered = this.processRemoteReplacementHistory(
      items,
      injectionMode,
      referenceContextItem
    )
    const rawCompactionItems = filtered.filter((item) =>
      this.isRawCompactionItem(item)
    )
    if (rawCompactionItems.length > 0) {
      const summary = this.buildReplacementSummary(
        filtered.filter((item) => !this.isRawCompactionItem(item)),
        "Remote compacted history is attached as a Codex compaction item. Continue from the compacted context and any later messages."
      )
      return {
        summary,
        items: [
          this.cloneReplacementItem(
            rawCompactionItems[rawCompactionItems.length - 1]!
          ),
        ],
        rawItemCount: items.length,
        filteredItemCount: filtered.length,
        discardedItemCount: Math.max(0, items.length - 1),
      }
    }

    const summary = this.buildReplacementSummary(filtered)
    return {
      summary,
      items: [this.buildSyntheticCompactionSummaryItem(summary)],
      rawItemCount: items.length,
      filteredItemCount: filtered.length,
      discardedItemCount: Math.max(0, items.length - 1),
    }
  }

  private shouldKeepRemoteHistoryItem(
    item: CodexReplacementHistoryItem
  ): boolean {
    if (this.isRawCompactionItem(item)) {
      return true
    }
    if (item.type === "compaction_trigger") return false
    const role = typeof item.role === "string" ? item.role : undefined
    if (role === "developer" || role === "system") return false
    if (role === "assistant") return true
    if (role !== "user") return false
    const text = this.extractResponseItemText(item).trim()
    if (!text) return false
    return !this.isSyntheticCodexHistoryText(text)
  }

  private isCodexReferenceContextText(text: string): boolean {
    return text.trimStart().startsWith("Current Codex turn context:")
  }

  private isSyntheticCodexHistoryText(text: string): boolean {
    const trimmed = text.trimStart()
    return (
      this.isCodexReferenceContextText(trimmed) ||
      trimmed.startsWith(CODEX_SUMMARY_PREFIX) ||
      trimmed.startsWith("This is compressed historical context") ||
      /^(?:\[Context (?:attachment|summary|collapse|boundary|attachment removed)|\[Result of an earlier tool call|\[tool_result stored\])/i.test(
        trimmed
      ) ||
      /^# AGENTS\.md instructions\b/i.test(trimmed) ||
      /^<environment_context>/i.test(trimmed) ||
      /^<turn_aborted>/i.test(trimmed) ||
      /^Grep completed:\s*pattern=/i.test(trimmed) ||
      /\bDocumentId:\s*tool_result:/i.test(trimmed) ||
      /\/\.agent-vibes\/tool-results\//i.test(trimmed) ||
      /\n(?:Session Memory|Investigation Memory|Recent File Snapshots|Tracked File Changes)\b/i.test(
        trimmed
      )
    )
  }

  private buildReplacementSummary(
    items: CodexReplacementHistoryItem[],
    fallbackBody: string = CODEX_EMPTY_REMOTE_COMPACTION_SUMMARY
  ): string {
    const seen = new Set<string>()
    const parts: string[] = []
    for (const item of items) {
      const text = this.extractReplacementSummaryText(item).trim()
      if (!text) continue
      const key = text.replace(/\s+/g, " ").trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      parts.push(text)
    }
    const body = parts.join("\n\n").trim() || fallbackBody
    const compacted = truncateCodexTextByBytes(body, 32_000)
    return [
      CODEX_SUMMARY_PREFIX,
      CODEX_HISTORICAL_SUMMARY_NOTICE,
      "",
      compacted,
    ].join("\n")
  }

  private summarizeReplacementHistoryItems(
    items: CodexReplacementHistoryItem[]
  ): string {
    if (items.length === 0) return "none"
    const counts = new Map<string, number>()
    for (const item of items) {
      const type =
        typeof item.type === "string" && item.type.trim()
          ? item.type.trim()
          : "unknown"
      const role =
        typeof item.role === "string" && item.role.trim()
          ? item.role.trim()
          : "none"
      const key = `${type}:${role}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([key, count]) => `${key}:${count}`)
      .join(",")
  }

  private buildSyntheticCompactionSummaryItem(
    summary: string
  ): CodexReplacementHistoryItem {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: summary }],
    }
  }

  private replacementHistoryToMessages(
    items: CodexReplacementHistoryItem[]
  ): UnifiedMessage[] {
    return items.flatMap((item) => {
      if (this.isRawCompactionItem(item)) {
        const rawBlock: CodexRawResponseItemBlock = {
          type: CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
          item: this.cloneReplacementItem(item),
        }
        return [
          {
            role: "user",
            content: [rawBlock],
          } as unknown as UnifiedMessage,
        ]
      }
      const role = item.role === "assistant" ? "assistant" : "user"
      const text = this.extractResponseItemText(item).trim()
      if (!text) return []
      if (this.isSyntheticCodexHistoryText(text)) return []
      return [{ role, content: text } satisfies UnifiedMessage]
    })
  }

  private isRawCompactionItem(item: CodexReplacementHistoryItem): boolean {
    return item.type === "compaction" || item.type === "context_compaction"
  }

  private extractReplacementSummaryText(
    item: CodexReplacementHistoryItem
  ): string {
    if (this.isRawCompactionItem(item)) {
      return ""
    }
    const text = this.extractResponseItemText(item).trim()
    return this.isSyntheticCodexHistoryText(text) ? "" : text
  }

  private projectCurrentLiveMetaMessages(
    messages: UnifiedMessage[]
  ): UnifiedMessage[] {
    const currentMessages = messages.filter(
      (message) => !this.isLegacyRemovedAttachmentMessage(message)
    )
    return orderCodexMetaMessagesBeforeTranscript(currentMessages)
  }

  private isLegacyRemovedAttachmentMessage(message: UnifiedMessage): boolean {
    if (
      message.role !== "user" ||
      message.isMeta !== true ||
      message.source !== "attachment"
    ) {
      return false
    }
    const text = extractText(message.content).trim()
    return /^\[Context attachment removed: [^\]]+\]$/u.test(text)
  }

  private recordsAfterReplacementAnchor(
    records: readonly ContextTranscriptRecord[],
    anchorRecordId: string | undefined,
    fullRecords: readonly ContextTranscriptRecord[] = records
  ): ContextTranscriptRecord[] {
    if (!anchorRecordId) return []
    const anchorIndex = records.findIndex(
      (record) => record.id === anchorRecordId
    )
    if (anchorIndex >= 0) return records.slice(anchorIndex + 1)

    const firstRecord = records[0]
    const lastRecord = records[records.length - 1]
    if (!firstRecord || !lastRecord) return []
    const fullAnchorIndex = fullRecords.findIndex(
      (record) => record.id === anchorRecordId
    )
    const fullFirstIndex = fullRecords.findIndex(
      (record) => record.id === firstRecord.id
    )
    const fullLastIndex = fullRecords.findIndex(
      (record) => record.id === lastRecord.id
    )
    if (fullAnchorIndex < 0 || fullFirstIndex < 0 || fullLastIndex < 0) {
      return []
    }
    if (fullAnchorIndex < fullFirstIndex) return [...records]
    if (fullAnchorIndex >= fullLastIndex) return []
    return []
  }

  private recordsToMessages(
    records: readonly ContextTranscriptRecord[]
  ): UnifiedMessage[] {
    return records
      .filter(
        (record) =>
          isMessageRecord(record) ||
          isContextCollapseSummaryRecord(record) ||
          isCompactSummaryRecord(record)
      )
      .map((record) => ({
        role: record.role,
        content: record.content,
        ...(record.messageId ? { messageId: record.messageId } : {}),
        ...(record.isMeta ? { isMeta: true } : {}),
      })) as UnifiedMessage[]
  }

  private recordsToPostReplacementMessages(
    records: readonly ContextTranscriptRecord[]
  ): UnifiedMessage[] {
    const lastUserInputIndex = this.findLastUserInputIndex(records)
    return records.flatMap((record, index) => {
      if (
        isMessageRecord(record) ||
        isCompactSummaryRecord(record) ||
        isContextCollapseSummaryRecord(record)
      ) {
        return [
          {
            role: record.role,
            content: record.content,
            ...(record.messageId ? { messageId: record.messageId } : {}),
            ...(record.isMeta ? { isMeta: true } : {}),
            recordId: record.id,
          } as UnifiedMessage & { recordId: string },
        ]
      }
      if (isAttachmentRecord(record)) {
        return [
          {
            role: "user",
            content: record.content,
            source: "attachment",
            isMeta: true,
            recordId: record.id,
            ...(record.attachmentMetadata?.kind
              ? { attachmentKind: record.attachmentMetadata.kind }
              : {}),
          } as UnifiedMessage & { recordId: string },
        ]
      }
      if (isHookResultRecord(record)) {
        if (index < lastUserInputIndex) return []
        return [
          {
            role: "user",
            content: record.content,
            source: "hook",
            isMeta: true,
            recordId: record.id,
          } as UnifiedMessage & { recordId: string },
        ]
      }
      return []
    })
  }

  private findLastUserInputIndex(
    records: readonly ContextTranscriptRecord[]
  ): number {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]
      if (!record) continue
      if (record.role !== "user") continue
      if (record.kind && record.kind !== "message") continue
      return index
    }
    return -1
  }

  private cloneReplacementItem(
    item: CodexReplacementHistoryItem
  ): CodexReplacementHistoryItem {
    return JSON.parse(JSON.stringify(item)) as CodexReplacementHistoryItem
  }

  private resolveWindowState(
    codex: CodexContextState,
    conversationId: string | undefined,
    createdAt: number
  ): CodexContextWindowState {
    const windowNumber =
      typeof codex.activeWindow?.windowNumber === "number" &&
      Number.isFinite(codex.activeWindow.windowNumber) &&
      codex.activeWindow.windowNumber >= 0
        ? Math.floor(codex.activeWindow.windowNumber)
        : 0
    const expectedWindowId = this.buildWindowId(conversationId, windowNumber)
    if (
      codex.activeWindow?.windowId === expectedWindowId &&
      typeof codex.activeWindow.firstWindowId === "string" &&
      codex.activeWindow.firstWindowId.length > 0
    ) {
      return codex.activeWindow
    }

    return {
      windowNumber: 0,
      firstWindowId: this.buildWindowId(conversationId, 0),
      windowId: this.buildWindowId(conversationId, 0),
      createdAt,
    }
  }

  private buildWindowId(
    conversationId: string | undefined,
    windowNumber: number
  ): string {
    const normalizedConversationId = conversationId?.trim() || "codex"
    return `${normalizedConversationId}:${Math.max(0, Math.floor(windowNumber))}`
  }

  private extractResponseItemText(item: CodexReplacementHistoryItem): string {
    const content = item.content
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part || typeof part !== "object") return ""
          const record = part as Record<string, unknown>
          if (typeof record.text === "string") return record.text
          if (typeof record.output_text === "string") return record.output_text
          return ""
        })
        .filter(Boolean)
        .join("\n")
    }
    if (typeof item.summary === "string") return item.summary
    if (typeof item.message === "string") return item.message
    try {
      return extractText(content as LooseMessageContent)
    } catch {
      return ""
    }
  }

  private hashStable(value: unknown): string {
    return createHash("sha256")
      .update(this.stableStringify(value))
      .digest("hex")
      .slice(0, 16)
  }

  private stableStringify(value: unknown): string {
    return JSON.stringify(this.sortJsonValue(value))
  }

  private sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJsonValue(item))
    }
    if (!value || typeof value !== "object") {
      return value
    }
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = this.sortJsonValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }
}
