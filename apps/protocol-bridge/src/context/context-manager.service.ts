import { Injectable } from "@nestjs/common"
import { randomUUID } from "crypto"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import { requireExactDurableIdentifier } from "./durable-identifier"
import {
  ContextBudgetEnforcement,
  ContextCompactionResult,
  ContextCompactionService,
  ContextProjectionBudgetBoundary,
} from "./context-compaction.service"
import type { ContextModelProfile } from "./context-model-profile"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { TokenCounterService } from "./token-counter.service"
import {
  ClaudeProjectionCapabilitySnapshot,
  ClaudeProjectionRecipe,
  ContextConversationState,
  ContextUsageSnapshot,
  DurableGraphProjectionMessage,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"

export interface ContextManagerProjectionOptions {
  maxTokens: number
  systemPromptTokens: number
  contextProfile?: ContextModelProfile
  autoCompactTokenLimit?: number
  predictiveCompactTokenLimit?: number
  integrityMode?: "strict-adjacent" | "global"
  pendingToolUseIds?: Iterable<string>
  strategy?: "auto" | "manual" | "reactive"
  dryRun?: boolean
  budgetEnforcement?: ContextBudgetEnforcement
  budgetBoundary?: ContextProjectionBudgetBoundary
  dynamicAttachmentMode?: "history" | "provider-native"
  claudeCapability?: ClaudeProjectionCapabilitySnapshot
  claudeRecipe?: ClaudeProjectionRecipe
  visibleSessionMemorySourceRecordUuids?: Iterable<string>
}

@Injectable()
export class ContextManagerService {
  constructor(
    private readonly compaction: ContextCompactionService,
    private readonly usageLedger: ContextUsageLedgerService,
    private readonly tokenCounter: TokenCounterService
  ) {}

  buildBackendMessages(
    state: ContextConversationState,
    snapshot: ContextAttachmentSnapshot,
    options: ContextManagerProjectionOptions
  ): ContextCompactionResult {
    return this.compaction.ensureWithinBudget(state, snapshot, options)
  }

  buildBackendMessagesFromMessages(
    messages: UnifiedMessage[],
    snapshot: ContextAttachmentSnapshot,
    options: ContextManagerProjectionOptions
  ): ContextCompactionResult {
    return this.buildBackendMessages(
      this.createRawEphemeralState(messages),
      snapshot,
      options
    )
  }

  /**
   * Project messages that came from a durable graph without changing their
   * identity. This is intentionally distinct from
   * `buildBackendMessagesFromMessages`: raw messages receive transient ids,
   * while graph messages must keep their source UUID as the ephemeral record
   * id so provider-native history can bind them exactly once.
   */
  buildBackendMessagesFromDurableGraphMessages(
    messages: readonly DurableGraphProjectionMessage[],
    snapshot: ContextAttachmentSnapshot,
    options: ContextManagerProjectionOptions
  ): ContextCompactionResult {
    return this.buildBackendMessages(
      this.createDurableGraphEphemeralState(messages),
      snapshot,
      options
    )
  }

  recordAssistantUsage(
    state: ContextConversationState,
    recordId: string | undefined,
    usage: ContextUsageSnapshot | undefined,
    options?: {
      promptTokenCount?: number
      contextProfile?: ContextModelProfile
      recordedCompactionId?: string
      attachmentFingerprint?: string
      assistantMessage?: UnifiedMessage
    }
  ): void {
    if (!recordId || !usage) return
    const assistantMessageTokens = options?.assistantMessage
      ? this.tokenCounter.countMessages(
          [options.assistantMessage],
          true,
          options.contextProfile?.tokenizer ?? "claude"
        )
      : 0
    this.usageLedger.recordResponseUsage(
      state,
      recordId,
      {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        outputTokens: usage.outputTokens,
      },
      {
        projectedTokenCount:
          options?.promptTokenCount != null
            ? options.promptTokenCount + assistantMessageTokens
            : undefined,
        accountingProfileKey: options?.contextProfile?.key,
        recordedCompactionId: options?.recordedCompactionId,
        attachmentFingerprint: options?.attachmentFingerprint,
      }
    )
  }

  buildProjectionLedger(
    state: ContextConversationState,
    projectedMessages: ProjectedContextMessage[],
    contextProfile: ContextModelProfile
  ): {
    projectedTokenCount?: number
    accountingProfileKey?: string
    recordedCompactionId?: string
    attachmentFingerprint?: string
  } {
    return this.usageLedger.buildProjectionLedger(
      state,
      projectedMessages,
      contextProfile
    )
  }

  countMessages(messages: UnifiedMessage[]): number {
    return this.tokenCounter.countMessages(messages)
  }

  /**
   * Raw requests have no durable graph owner. They deliberately receive new
   * transient identities, but may not smuggle a graph `sourceUuid` into this
   * path: doing so would silently sever a provider-native binding.
   */
  private createRawEphemeralState(
    messages: UnifiedMessage[]
  ): ContextConversationState {
    for (const [index, message] of messages.entries()) {
      if ((message as { sourceUuid?: unknown }).sourceUuid !== undefined) {
        throw new Error(
          `Raw message projection cannot accept durable sourceUuid at index ${index}; use buildBackendMessagesFromDurableGraphMessages instead`
        )
      }
    }
    return this.createEphemeralState(messages, () => randomUUID())
  }

  /**
   * Construct an ephemeral state whose record ids are exactly the persisted
   * graph identities. There is no trim, fallback, or generated replacement:
   * changing an id here would make an incremental provider history ambiguous.
   */
  private createDurableGraphEphemeralState(
    messages: readonly DurableGraphProjectionMessage[]
  ): ContextConversationState {
    const seen = new Set<string>()
    for (const [index, message] of messages.entries()) {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new Error(
          `Durable graph message at index ${index} has unsupported role ${String(message.role)}`
        )
      }
      const sourceUuid = (message as { sourceUuid?: unknown }).sourceUuid
      let exactSourceUuid: string
      try {
        exactSourceUuid = requireExactDurableIdentifier(
          sourceUuid,
          `Durable graph message at index ${index} sourceUuid`
        )
      } catch {
        throw new Error(
          `Durable graph message at index ${index} requires a non-empty exact sourceUuid`
        )
      }
      if (seen.has(exactSourceUuid)) {
        throw new Error(
          `Durable graph projection contains duplicate sourceUuid ${exactSourceUuid}`
        )
      }
      seen.add(exactSourceUuid)
    }
    return this.createEphemeralState(
      messages,
      (_message, index) => messages[index]!.sourceUuid
    )
  }

  private createEphemeralState(
    messages: readonly Pick<
      UnifiedMessage,
      "role" | "content" | "messageId" | "isMeta"
    >[],
    resolveRecordId: (
      message: Pick<
        UnifiedMessage,
        "role" | "content" | "messageId" | "isMeta"
      >,
      index: number
    ) => string
  ): ContextConversationState {
    const baseTimestamp = Date.now()
    const records = messages.map((message, index) => ({
      id: resolveRecordId(message, index),
      role:
        message.role === "assistant"
          ? ("assistant" as const)
          : ("user" as const),
      content: message.content,
      createdAt: baseTimestamp + index,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.isMeta ? { isMeta: true } : {}),
    }))

    return {
      records,
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
      sessionMemory: [],
      graphWatermarkUuid: records.at(-1)?.id,
    }
  }
}
