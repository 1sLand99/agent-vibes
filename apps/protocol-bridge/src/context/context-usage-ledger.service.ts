import { Injectable } from "@nestjs/common"
import { fingerprintProjectedAttachments } from "./attachment-fingerprint"
import { ContextAttachmentSnapshot } from "./context-attachment-builder.service"
import { ContextProjectionService } from "./context-projection.service"
import { createContextUsageSnapshot } from "./context-usage-contract"
import {
  ContextModelProfile,
  isContextAccountingProfileCompatible,
} from "./context-model-profile"
import { TokenCounterService } from "./token-counter.service"
import {
  ContextConversationState,
  ContextUsageLedgerState,
  ContextUsageSnapshot,
  ProjectedContextMessage,
  UnifiedMessage,
} from "./types"

@Injectable()
export class ContextUsageLedgerService {
  constructor(
    private readonly tokenCounter: TokenCounterService,
    private readonly projection: ContextProjectionService
  ) {}

  recordResponseUsage(
    state: ContextConversationState,
    recordId: string,
    usage: Omit<ContextUsageSnapshot, "totalTokens" | "recordedAt">,
    options?: {
      projectedTokenCount?: number
      accountingProfileKey?: string
      recordedCompactionId?: string
      attachmentFingerprint?: string
    }
  ): void {
    const snapshot = createContextUsageSnapshot(usage, {
      label: "context usage ledger",
    })
    state.usageLedger = {
      anchorRecordId: recordId,
      lastUsage: snapshot,
      projectedTokenCount: options?.projectedTokenCount,
      accountingProfileKey: options?.accountingProfileKey,
      recordedCompactionId: options?.recordedCompactionId,
      attachmentFingerprint: options?.attachmentFingerprint,
    }
  }

  buildProjectionLedger(
    state: ContextConversationState,
    projectedMessages: ProjectedContextMessage[],
    contextProfile: ContextModelProfile
  ): Pick<
    ContextUsageLedgerState,
    | "projectedTokenCount"
    | "accountingProfileKey"
    | "recordedCompactionId"
    | "attachmentFingerprint"
  > {
    const asUnified = projectedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]

    return {
      projectedTokenCount: this.tokenCounter.countMessages(
        asUnified,
        true,
        contextProfile.tokenizer
      ),
      accountingProfileKey: contextProfile.key,
      recordedCompactionId: this.projection.getActiveCommit(state)?.id,
      attachmentFingerprint: fingerprintProjectedAttachments(projectedMessages),
    }
  }

  estimateProjectedTokens(
    state: ContextConversationState,
    projectedMessages?: ProjectedContextMessage[],
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
      contextProfile?: ContextModelProfile
    }
  ): number {
    const projected =
      projectedMessages ??
      this.projection.project(state, {
        attachmentSnapshot: options?.attachmentSnapshot,
        attachmentTokenBudget: options?.attachmentTokenBudget,
      }).messages
    const asUnified = projected.map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]
    const tokenizer = options?.contextProfile?.tokenizer ?? "claude"
    const rawEstimate = this.tokenCounter.countMessages(
      asUnified,
      true,
      tokenizer
    )
    const anchorId = state.usageLedger.anchorRecordId
    const usage = state.usageLedger.lastUsage
    const projectedTokenCount = state.usageLedger.projectedTokenCount

    if (
      options?.contextProfile &&
      !isContextAccountingProfileCompatible(
        state.usageLedger.accountingProfileKey,
        options.contextProfile.key
      )
    ) {
      return rawEstimate
    }

    if (!anchorId || !usage || projectedTokenCount == null) {
      return rawEstimate
    }

    const currentCompactionId = this.projection.getActiveCommit(state)?.id
    if (state.usageLedger.recordedCompactionId !== currentCompactionId) {
      return rawEstimate
    }

    const lastAppliedCompaction = state.lastAppliedCompaction
    if (
      currentCompactionId &&
      lastAppliedCompaction &&
      lastAppliedCompaction.compactionId !== currentCompactionId
    ) {
      return rawEstimate
    }

    const currentAttachmentFingerprint =
      fingerprintProjectedAttachments(projected)
    if (
      (state.usageLedger.attachmentFingerprint || "") !==
      currentAttachmentFingerprint
    ) {
      return rawEstimate
    }

    const anchorIndex = projected.findIndex(
      (message) => message.recordId === anchorId
    )
    if (anchorIndex < 0) {
      return rawEstimate
    }

    const suffixMessages = projected.slice(anchorIndex + 1).map((message) => ({
      role: message.role,
      content: message.content,
    })) as UnifiedMessage[]

    if (suffixMessages.length === 0) {
      return projectedTokenCount
    }

    return (
      projectedTokenCount +
      this.tokenCounter.countMessages(suffixMessages, true, tokenizer)
    )
  }
}
