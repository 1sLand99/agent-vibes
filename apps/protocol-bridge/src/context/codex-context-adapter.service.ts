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
  isAttachmentRecord,
  isContextCollapseSummaryRecord,
  isHookResultRecord,
  isMessageRecord,
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
  CodexRawResponseItemBlock,
  CodexReferenceContextItem,
  ContextCollapseCommit,
  CodexMetaMessageLedgerEntry,
  CodexMetaMessageLedgerState,
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
  "The retained recent messages and any topic-continuity guard that follow this summary are authoritative for the current request and next action.",
  "Do not resume a task from this summary unless the retained recent messages explicitly continue it.",
].join(" ")

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
    return state.codexContext
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
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      projectedTokenOverride?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
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
    const sourceRecords = [
      ...candidate.archivedRecords,
      ...candidate.retainedRecords,
    ]
    const sourceMessages = this.recordsToMessages(sourceRecords)
    const compactMessages = this.projectCodexMessages(state, sourceMessages, {
      maxTokens: options.maxTokens,
      systemPromptTokens: options.systemPromptTokens,
      truncationPolicy: options.referenceContextItem.truncationPolicy,
      replacementRecords: sourceRecords,
    })
    const compactResult = await options.remoteCompactProvider({
      messages: compactMessages,
      maxTokens: candidate.summaryBudget,
      candidate,
      referenceContextItem: options.referenceContextItem,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const replacementHistory = this.processRemoteReplacementHistory(
      compactResult.replacementHistory,
      options.injectionMode,
      options.referenceContextItem
    )
    if (replacementHistory.length === 0) {
      throw new Error("Codex remote compact returned empty replacement history")
    }

    const summary = this.buildReplacementSummary(replacementHistory)
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
    const anchorRecordId =
      candidate.retainedRecords[candidate.retainedRecords.length - 1]?.id ||
      candidate.archivedRecords[candidate.archivedRecords.length - 1]?.id
    plan.commit.codexReplacementHistory = {
      compactionId: plan.commit.id,
      createdAt: Date.now(),
      injectionMode: options.injectionMode,
      anchorRecordId,
      anchorRecordCount: state.records.length,
      summary,
      items: replacementHistory,
    }

    const codex = this.ensureState(state)
    codex.historyVersion = codex.historyVersion + 1
    codex.tokenInfo = {
      totalTokens: plan.estimatedTokens,
      modelContextWindow: options.maxTokens,
      updatedAt: Date.now(),
    }
    codex.replacementHistory = plan.commit.codexReplacementHistory
    codex.referenceContextItem =
      options.injectionMode === "mid_turn"
        ? options.referenceContextItem
        : undefined
    codex.truncationPolicy = {
      ...options.referenceContextItem.truncationPolicy,
    }

    this.logger.log(
      `Codex compact applied commit=${plan.commit.id} mode=${options.injectionMode} replacementItems=${replacementHistory.length}`
    )
    return plan
  }

  async applyCollapsesIfNeeded(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: {
      maxTokens: number
      systemPromptTokens: number
      autoCompactTokenLimit?: number
      predictiveCompactTokenLimit?: number
      strategy?: "auto" | "manual" | "reactive"
      integrityMode?: "strict-adjacent" | "global"
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

    const sourceRecords = [
      ...candidate.archivedRecords,
      ...candidate.retainedRecords,
    ]
    const sourceMessages = this.recordsToMessages(sourceRecords)
    const compactMessages = this.projectCodexMessages(state, sourceMessages, {
      maxTokens: options.maxTokens,
      systemPromptTokens: options.systemPromptTokens,
      truncationPolicy: options.referenceContextItem.truncationPolicy,
      replacementRecords: sourceRecords,
    })
    const compactResult = await options.remoteCompactProvider({
      messages: compactMessages,
      maxTokens: candidate.summaryBudget,
      candidate,
      referenceContextItem: options.referenceContextItem,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const replacementHistory = this.processRemoteReplacementHistory(
      compactResult.replacementHistory,
      "pre_turn",
      options.referenceContextItem
    )
    if (replacementHistory.length === 0) {
      throw new Error(
        "Codex remote collapse returned empty replacement history"
      )
    }

    const summary = this.buildReplacementSummary(replacementHistory)
    const commit = this.contextCollapse.applyGeneratedCollapse(
      state,
      candidate,
      { summary }
    )
    this.logger.log(
      `Codex context collapse applied commit=${commit.id} replacementItems=${replacementHistory.length}`
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
    }
  ): UnifiedMessage[] {
    return this.projectCodexMessagesWithMetadata(state, baseMessages, options)
      .messages
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
    }
  ): CodexProjectedMessagesResult {
    const codex = this.ensureState(state)
    const truncationPolicy = options.truncationPolicy || codex.truncationPolicy
    let messages = baseMessages
    let protectedPrefixCount = 0
    const replacement = codex.replacementHistory
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

    messages = repairOrphanedToolPairs(
      this.projectAppendOnlyLiveMetaMessages(
        codex,
        this.prepareMessagesForCodex(messages, truncationPolicy)
      ),
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
    injectionMode: "pre_turn" | "mid_turn",
    referenceContextItem: CodexReferenceContextItem
  ): CodexReplacementHistoryItem[] {
    const filtered = items.filter((item) =>
      this.shouldKeepRemoteHistoryItem(item)
    )
    if (injectionMode !== "mid_turn") {
      return filtered
    }
    const contextItem = this.referenceContextAsMessage(referenceContextItem)
    const insertionIndex = this.findLastRealUserOrSummaryIndex(filtered)
    if (insertionIndex < 0) {
      return [...filtered, contextItem]
    }
    return [
      ...filtered.slice(0, insertionIndex),
      contextItem,
      ...filtered.slice(insertionIndex),
    ]
  }

  private shouldKeepRemoteHistoryItem(
    item: CodexReplacementHistoryItem
  ): boolean {
    if (item.type === "compaction") return true
    const role = typeof item.role === "string" ? item.role : undefined
    if (role === "developer" || role === "system") return false
    if (role === "assistant") return true
    if (role !== "user") return false
    return this.extractResponseItemText(item).trim().length > 0
  }

  private referenceContextAsMessage(
    reference: CodexReferenceContextItem
  ): CodexReplacementHistoryItem {
    const lines = [
      "Current Codex turn context:",
      reference.model ? `model: ${reference.model}` : undefined,
      reference.conversationId
        ? `conversation_id: ${reference.conversationId}`
        : undefined,
      reference.contextTokenLimit
        ? `context_window: ${reference.contextTokenLimit}`
        : undefined,
      reference.serviceTier
        ? `service_tier: ${reference.serviceTier}`
        : undefined,
      reference.systemPromptHash
        ? `system_prompt_hash: ${reference.systemPromptHash}`
        : undefined,
      reference.toolSpecHash
        ? `tool_spec_hash: ${reference.toolSpecHash}`
        : undefined,
    ].filter((line): line is string => !!line)
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: lines.join("\n") }],
    }
  }

  private findLastRealUserOrSummaryIndex(
    items: CodexReplacementHistoryItem[]
  ): number {
    let lastUserOrSummaryIndex: number | undefined
    let lastCompactionIndex: number | undefined
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!
      if (item.type === "compaction") {
        lastCompactionIndex ??= index
        continue
      }
      if (item.role !== "user") continue
      lastUserOrSummaryIndex ??= index
      if (!this.isSummaryHistoryItem(item)) {
        return index
      }
    }
    return lastUserOrSummaryIndex ?? lastCompactionIndex ?? -1
  }

  private isSummaryHistoryItem(item: CodexReplacementHistoryItem): boolean {
    return this.extractResponseItemText(item).startsWith(
      `${CODEX_SUMMARY_PREFIX}\n`
    )
  }

  private buildReplacementSummary(
    items: CodexReplacementHistoryItem[]
  ): string {
    const body =
      items
        .map((item) => this.extractResponseItemText(item))
        .filter((text) => text.trim().length > 0)
        .join("\n\n")
        .trim() || "(no summary available)"
    const compacted = truncateCodexTextByBytes(body, 32_000)
    return [
      CODEX_SUMMARY_PREFIX,
      CODEX_HISTORICAL_SUMMARY_NOTICE,
      "",
      compacted,
    ].join("\n")
  }

  private replacementHistoryToMessages(
    items: CodexReplacementHistoryItem[]
  ): UnifiedMessage[] {
    return items.flatMap((item) => {
      if (item.type === "compaction") {
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
      return [{ role, content: text } satisfies UnifiedMessage]
    })
  }

  private projectAppendOnlyLiveMetaMessages(
    codex: CodexContextState,
    messages: UnifiedMessage[]
  ): UnifiedMessage[] {
    const liveMetaMessages: Array<{
      key: string
      message: UnifiedMessage
    }> = []
    const visibleMessages: UnifiedMessage[] = []
    const liveMetaOrdinalsByKind = new Map<string, number>()

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!
      if (this.isAppendOnlyLiveMetaMessage(message)) {
        const kind = message.attachmentKind || "attachment"
        const ordinal = liveMetaOrdinalsByKind.get(kind) || 0
        liveMetaOrdinalsByKind.set(kind, ordinal + 1)
        liveMetaMessages.push({
          key: this.buildLiveMetaMessageKey(message, ordinal),
          message,
        })
      } else {
        visibleMessages.push(message)
      }
    }

    if (
      liveMetaMessages.length === 0 &&
      !codex.metaMessageLedger?.messages.length
    ) {
      return orderCodexMetaMessagesBeforeTranscript(messages)
    }

    const orderedVisible =
      orderCodexMetaMessagesBeforeTranscript(visibleMessages)
    const ledger = this.ensureMetaMessageLedger(codex)
    const insertionIndex = ledger.initialized
      ? this.findCurrentTurnInsertionIndex(orderedVisible)
      : 0
    const currentByKey = new Map(
      liveMetaMessages.map((entry) => [entry.key, entry])
    )
    const pending: CodexMetaMessageLedgerEntry[] = []

    if (!ledger.initialized) {
      for (const { key, message } of liveMetaMessages) {
        pending.push(this.anchorLiveMetaMessage(key, message, insertionIndex))
      }
    } else {
      for (const [key, signature] of Object.entries(
        ledger.latestSignaturesByKey
      )) {
        if (currentByKey.has(key)) {
          continue
        }
        pending.push(
          this.anchorRemovedLiveMetaMessage(
            key,
            signature,
            ledger.latestKindsByKey[key],
            insertionIndex
          )
        )
      }

      for (const { key, message } of liveMetaMessages) {
        const signature = this.signLiveMetaMessage(key, message)
        if (ledger.latestSignaturesByKey[key] === signature) {
          continue
        }
        pending.push(this.anchorLiveMetaMessage(key, message, insertionIndex))
      }
    }

    if (!ledger.initialized || pending.length > 0) {
      ledger.messages.push(...pending)
      ledger.initialized = true
      ledger.latestSignaturesByKey = Object.fromEntries(
        liveMetaMessages.map(({ key, message }) => [
          key,
          this.signLiveMetaMessage(key, message),
        ])
      )
      ledger.latestKindsByKey = Object.fromEntries(
        liveMetaMessages.map(({ key, message }) => [
          key,
          message.attachmentKind || "investigation_memory",
        ])
      )
    }

    return this.mergeAnchoredMetaMessages(ledger.messages, orderedVisible)
  }

  private ensureMetaMessageLedger(
    codex: CodexContextState
  ): CodexMetaMessageLedgerState {
    if (!codex.metaMessageLedger) {
      codex.metaMessageLedger = {
        initialized: false,
        messages: [],
        latestSignaturesByKey: {},
        latestKindsByKey: {},
      }
    }
    return codex.metaMessageLedger
  }

  private isAppendOnlyLiveMetaMessage(message: UnifiedMessage): boolean {
    return (
      message.role === "user" &&
      message.isMeta === true &&
      message.source === "attachment" &&
      !this.getMessageRecordId(message) &&
      !this.messageContainsToolResult(message)
    )
  }

  private messageContainsToolResult(message: UnifiedMessage): boolean {
    return (
      Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "tool_result")
    )
  }

  private buildLiveMetaMessageKey(
    message: UnifiedMessage,
    ordinal: number
  ): string {
    const kind = message.attachmentKind || "attachment"
    return `attachment:${kind}:${ordinal}`
  }

  private anchorLiveMetaMessage(
    key: string,
    message: UnifiedMessage,
    beforeVisibleIndex: number
  ): CodexMetaMessageLedgerEntry {
    return {
      key,
      signature: this.signLiveMetaMessage(key, message),
      beforeVisibleIndex,
      role: "user",
      content: message.content,
      source: message.source,
      isMeta: message.isMeta,
      attachmentKind: message.attachmentKind,
    }
  }

  private anchorRemovedLiveMetaMessage(
    key: string,
    previousSignature: string,
    kind: CodexMetaMessageLedgerEntry["attachmentKind"],
    beforeVisibleIndex: number
  ): CodexMetaMessageLedgerEntry {
    return {
      key,
      signature: `removed:${previousSignature}`,
      beforeVisibleIndex,
      role: "user",
      content: `[Context attachment removed: ${kind || "attachment"}]`,
      source: "attachment",
      isMeta: true,
      attachmentKind: kind,
    }
  }

  private signLiveMetaMessage(key: string, message: UnifiedMessage): string {
    return this.hashStable({
      key,
      role: message.role,
      source: message.source,
      attachmentKind: message.attachmentKind,
      content: message.content,
    })
  }

  private mergeAnchoredMetaMessages(
    metaMessages: CodexMetaMessageLedgerEntry[],
    visibleMessages: UnifiedMessage[]
  ): UnifiedMessage[] {
    const byIndex = new Map<number, CodexMetaMessageLedgerEntry[]>()
    for (const message of metaMessages) {
      const index = Math.max(
        0,
        Math.min(message.beforeVisibleIndex, visibleMessages.length)
      )
      const existing = byIndex.get(index)
      if (existing) {
        existing.push(message)
      } else {
        byIndex.set(index, [message])
      }
    }

    const merged: UnifiedMessage[] = []
    for (let index = 0; index <= visibleMessages.length; index++) {
      for (const message of byIndex.get(index) ?? []) {
        merged.push({
          role: message.role,
          content: message.content as UnifiedMessage["content"],
          source: message.source,
          isMeta: message.isMeta,
          attachmentKind: message.attachmentKind,
        })
      }
      const visible = visibleMessages[index]
      if (visible) {
        merged.push(visible)
      }
    }
    return merged
  }

  private findCurrentTurnInsertionIndex(messages: UnifiedMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.role === "user") {
        return this.messageContainsToolResult(message) ? index + 1 : index
      }
    }
    return messages.length
  }

  private getMessageRecordId(message: UnifiedMessage): string {
    const recordId = (message as unknown as { recordId?: unknown }).recordId
    return typeof recordId === "string" ? recordId : ""
  }

  private recordsAfterReplacementAnchor(
    records: readonly ContextTranscriptRecord[],
    anchorRecordId: string | undefined,
    fullRecords: readonly ContextTranscriptRecord[] = records
  ): ContextTranscriptRecord[] {
    if (!anchorRecordId) return []
    const anchorIndex = records.findIndex(
      (record) => isMessageRecord(record) && record.id === anchorRecordId
    )
    if (anchorIndex >= 0) return records.slice(anchorIndex + 1)

    const firstRecord = records[0]
    const lastRecord = records[records.length - 1]
    if (!firstRecord || !lastRecord) return []
    const fullAnchorIndex = fullRecords.findIndex(
      (record) => isMessageRecord(record) && record.id === anchorRecordId
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
          isMessageRecord(record) || isContextCollapseSummaryRecord(record)
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
      if (isMessageRecord(record) || isContextCollapseSummaryRecord(record)) {
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
