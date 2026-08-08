import { Injectable } from "@nestjs/common"
import {
  ClaudeConversationProjector,
  ClaudeMicrocompactProjection,
} from "./claude-conversation-projector"
import {
  ContextAttachmentBuilderService,
  ContextAttachmentSnapshot,
} from "./context-attachment-builder.service"
import {
  getActiveCompactCommitFromTranscript,
  getRecordsAfterCompactBoundary,
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isAttachmentRecord,
  isHookResultRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
  renderCompactBoundary,
  renderCompactSummary,
} from "./context-transcript-events"
import { requireExactDurableIdentifier } from "./durable-identifier"
import { stripCursorUiTaskSuccessFromProviderContent } from "./subagent-ui-payload"
import {
  ContextCompactionCommit,
  ContextConversationState,
  ContextTranscriptRecord,
  ClaudeProjectionCapabilitySnapshot,
  ClaudeProjectionRecipe,
  ProjectedContextMessage,
  ProjectionManifest,
} from "./types"
import { assertTerminalSessionMemoryProvenance } from "./session-memory.service"

export interface ContextProjectionResult {
  messages: ProjectedContextMessage[]
  /** Present only when this exact projection used Claude wire semantics. */
  claudeManifest?: ProjectionManifest
}

@Injectable()
export class ContextProjectionService {
  constructor(
    private readonly attachments: ContextAttachmentBuilderService,
    private readonly claudeProjector: ClaudeConversationProjector
  ) {}

  project(
    state: ContextConversationState,
    options?: {
      attachmentSnapshot?: ContextAttachmentSnapshot
      attachmentTokenBudget?: number
      /**
       * Dynamic attachments normally become generic history messages. Codex
       * owns them through its provider-native context input ledger instead,
       * so its graph projection must omit them entirely.
       */
      dynamicAttachmentMode?: "history" | "provider-native"
      recordsOverride?: readonly ContextTranscriptRecord[]
      claudeCapability?: ClaudeProjectionCapabilitySnapshot
      /** Exact provider-owned checkpoint selected by the Claude active head. */
      claudeRecipe?: ClaudeProjectionRecipe
      claudeMicrocompact?: ClaudeMicrocompactProjection
      /**
       * Exact graph records already represented by a provider-native input
       * history.  This is supplied by Codex's durable projection ledger; an
       * empty set is meaningful and must not fall back to content inference.
       */
      visibleSessionMemorySourceRecordUuids?: Iterable<string>
    }
  ): ContextProjectionResult {
    const unfilteredSourceRecords = options?.recordsOverride || state.records
    const sourceRecords = unfilteredSourceRecords
    const claudeCapability = options?.claudeCapability
    let claudeManifest: ProjectionManifest | undefined
    const compactSlice = claudeCapability
      ? [...sourceRecords]
      : getRecordsAfterCompactBoundary(sourceRecords)
    const rawProjected = claudeCapability
      ? (() => {
          const result = this.claudeProjector.project(compactSlice, {
            capability: claudeCapability,
            recipe: options?.claudeRecipe,
            replacementState: state.toolResultReplacementState,
            microcompact: options?.claudeMicrocompact,
          })
          claudeManifest = result.manifest
          return result.messages
        })()
      : compactSlice.flatMap((record) => this.projectRecord(record))
    // `taskSuccess` is Cursor transcript UI state, never provider context.
    // This is the sole state.records → provider transformation point, shared
    // by generic, Claude, Google, and Codex projections. The durable source
    // record is intentionally left unchanged for Cursor replay.
    const projected = rawProjected.map((message) => {
      const content = stripCursorUiTaskSuccessFromProviderContent(
        message.content
      )
      return content === message.content ? message : { ...message, content }
    })
    const activeCommit = getActiveCompactCommitFromTranscript(sourceRecords)
    const hasPostCompactAttachments = compactSlice.some(isAttachmentRecord)
    // A sub-agent memory attachment is an aid when its exact graph source was
    // compacted away. It must not repeat a terminal delivery that the model
    // already sees in its actual prompt. Generic/Claude projections can prove
    // that from final projected records; Codex must use the installed native
    // history binding supplied by the caller instead of guessing from content.
    const hasProviderVisibleSourceSet =
      options?.visibleSessionMemorySourceRecordUuids !== undefined
    const visibleSessionMemorySourceRecordUuids = hasProviderVisibleSourceSet
      ? new Set(options?.visibleSessionMemorySourceRecordUuids)
      : this.collectVisibleRecordSourceUuids(projected)
    const attachmentSnapshot = options?.attachmentSnapshot
      ? this.withDeduplicatedSessionMemory(
          options.attachmentSnapshot,
          visibleSessionMemorySourceRecordUuids
        )
      : undefined
    const rebuiltAttachments = attachmentSnapshot
      ? this.buildLiveAttachments(attachmentSnapshot, {
          maxTokens: options?.attachmentTokenBudget,
        })
      : []
    const rebuiltSessionMemory = rebuiltAttachments.find(
      (attachment) => attachment.kind === "session_memory"
    )
    const persistedSessionMemoryRecords = compactSlice.filter(
      (record) =>
        isAttachmentRecord(record) &&
        record.attachmentMetadata?.kind === "session_memory"
    )
    // Compaction attachments are normally frozen historical snapshots. Session
    // memory is different: it is a materialized event stream, so a new event,
    // revision, or source-visibility change must replace the old materialized
    // attachment. Reuse an identical durable attachment to avoid needless
    // projection churn; otherwise omit stale rows from the current view.
    const reusesPersistedSessionMemory =
      persistedSessionMemoryRecords.length === 1 &&
      rebuiltSessionMemory !== undefined &&
      persistedSessionMemoryRecords[0]?.content === rebuiltSessionMemory.content
    const replacesPersistedSessionMemory =
      persistedSessionMemoryRecords.length > 0 && !reusesPersistedSessionMemory
    const persistedSessionMemoryIds = new Set(
      persistedSessionMemoryRecords.map((record) => record.id)
    )
    const projectedForAttachments = replacesPersistedSessionMemory
      ? projected.filter(
          (message) =>
            !(
              message.attachmentKind === "session_memory" &&
              message.recordId &&
              persistedSessionMemoryIds.has(message.recordId)
            )
        )
      : projected
    if (replacesPersistedSessionMemory && claudeCapability && claudeManifest) {
      claudeManifest = {
        ...claudeManifest,
        sourceEntries: claudeManifest.sourceEntries.map((entry) =>
          persistedSessionMemoryIds.has(entry.sourceUuid)
            ? {
                ...entry,
                included: false,
                reason: "provider_exclusion",
              }
            : entry
        ),
      }
    }
    const liveAttachments = rebuiltAttachments.filter((attachment) => {
      if (attachment.kind === "session_memory") {
        return !reusesPersistedSessionMemory
      }
      return !hasPostCompactAttachments
    })

    if (options?.dynamicAttachmentMode === "provider-native") {
      // Codex does not inherit generic attachment rows, including compacted
      // attachment records. Its current attachment snapshot is represented
      // exclusively by replaceable provider-native context bindings. Keeping
      // one here would duplicate the same fact and would wrongly require a
      // graph source UUID for a mutable attachment.
      return {
        messages: projectedForAttachments.filter(
          (message) => message.source !== "attachment"
        ),
        ...(claudeManifest
          ? { claudeManifest: structuredClone(claudeManifest) }
          : {}),
      }
    }

    return {
      messages: [
        ...projectedForAttachments,
        ...this.buildAttachmentMessages(liveAttachments, activeCommit?.id),
      ],
      ...(claudeManifest
        ? { claudeManifest: structuredClone(claudeManifest) }
        : {}),
    }
  }

  getActiveCommit(
    state: ContextConversationState
  ): ContextCompactionCommit | undefined {
    return getActiveCompactCommitFromTranscript(state.records)
  }

  /**
   * Build the current, non-durable attachment snapshot once. Both generic
   * projection and Codex's provider-native context path use this method, so
   * source-aware session-memory deduplication cannot drift between them.
   */
  buildLiveAttachments(
    snapshot: ContextAttachmentSnapshot,
    options?: {
      maxTokens?: number
      visibleSessionMemorySourceRecordUuids?: Iterable<string>
    }
  ): ReturnType<ContextAttachmentBuilderService["buildAttachments"]> {
    const visible = new Set(
      options?.visibleSessionMemorySourceRecordUuids || []
    )
    const deduplicated = this.withDeduplicatedSessionMemory(snapshot, visible)
    return this.attachments.buildAttachments(deduplicated, {
      maxTokens: options?.maxTokens,
    })
  }

  renderCompactionBoundary(commit: ContextCompactionCommit): string {
    return renderCompactBoundary(commit)
  }

  renderCompactionSummary(commit: ContextCompactionCommit): string {
    return renderCompactSummary(commit)
  }

  private projectRecord(
    record: ContextTranscriptRecord
  ): ProjectedContextMessage[] {
    if (isMessageRecord(record)) {
      return [
        {
          role: record.role,
          content: record.content,
          source: "record",
          recordId: record.id,
          sourceUuid: record.id,
          // Carry the Anthropic split-sibling key through compaction so
          // send-time mergeAssistantMessagesById can fold siblings.
          // Undefined for assistant rows persisted before commit 17b66d3
          // and for every user record (Anthropic only mints message.id
          // on assistant turns).
          ...(record.messageId ? { messageId: record.messageId } : {}),
          ...(record.isMeta ? { isMeta: true } : {}),
        },
      ]
    }

    if (isCompactBoundaryRecord(record)) {
      // Claude Code keeps compact boundaries as system transcript markers;
      // normalizeMessagesForAPI filters them before provider dispatch.
      return []
    }

    if (isCompactSummaryRecord(record)) {
      const commit = record.compactMetadata?.commit
      return [
        {
          role: "user",
          content:
            typeof record.content === "string"
              ? record.content
              : commit
                ? renderCompactSummary(commit)
                : "",
          source: "summary",
          // Compaction-summary user messages are infrastructure plumbing.
          isMeta: true,
          commitId: commit?.id,
          recordId: record.id,
          sourceUuid: record.id,
          compactionEvent: commit
            ? {
                type: "summary",
                commitId: commit.id,
                epoch: commit.epoch,
                parentCompactionId: commit.parentCompactionId,
                archivedThroughRecordId: commit.archivedThroughRecordId,
                summaryTokenCount: commit.summaryTokenCount,
                sourceTokenCount: commit.sourceTokenCount,
                projectedTokenCount: commit.projectedTokenCount,
              }
            : undefined,
        },
      ]
    }

    if (isSnipBoundaryRecord(record)) {
      // Snip boundaries are likewise system-only replay markers.
      return []
    }
    if (isMicrocompactBoundaryRecord(record)) {
      return []
    }

    if (isAttachmentRecord(record)) {
      return [
        {
          role: "user",
          content: record.content,
          source: "attachment",
          // Attachment records are infrastructure plumbing — file
          // contents / diff snippets the IDE injects so the model has
          // working context. cc has no exact mirror here (its attachment
          // surface lives in the prompt template, not the message
          // stream), but isMeta is the closest semantic match for
          // "synthesised, hide from transcript".
          isMeta: true,
          recordId: record.id,
          sourceUuid: record.id,
          attachmentKind: record.attachmentMetadata?.kind,
        },
      ]
    }

    if (isHookResultRecord(record)) {
      return [
        {
          role: "user",
          content: record.content,
          source: "hook",
          // Hook results are user-defined script output injected for the
          // model's benefit, not user input. Mirrors cc's PreToolUse /
          // PostToolUse hook injection (settings.json hooks contract).
          isMeta: true,
          recordId: record.id,
          sourceUuid: record.id,
          commitId: record.hookMetadata?.compactionId,
        },
      ]
    }

    return []
  }

  private buildAttachmentMessages(
    attachments: ReturnType<
      ContextAttachmentBuilderService["buildAttachments"]
    >,
    commitId?: string
  ): ProjectedContextMessage[] {
    return attachments.map((attachment) => ({
      role: "user" as const,
      content: attachment.content,
      source: "attachment" as const,
      // Same reasoning as the attachment-record branch above.
      isMeta: true,
      commitId,
      attachmentKind: attachment.kind,
    }))
  }

  private withDeduplicatedSessionMemory(
    snapshot: ContextAttachmentSnapshot,
    visibleSourceRecordUuids: ReadonlySet<string>
  ): ContextAttachmentSnapshot {
    const sessionMemory = snapshot.sessionMemory
    if (!sessionMemory || sessionMemory.length === 0) return snapshot

    const retained = sessionMemory.filter((memory, index) => {
      assertTerminalSessionMemoryProvenance(
        memory,
        `ContextProjectionService: sessionMemory[${index}]`
      )
      return !visibleSourceRecordUuids.has(memory.sourceRecordUuid)
    })
    if (retained.length === sessionMemory.length) return snapshot
    return { ...snapshot, sessionMemory: retained }
  }

  private collectVisibleRecordSourceUuids(
    projected: readonly ProjectedContextMessage[]
  ): Set<string> {
    const visible = new Set<string>()
    for (const message of projected) {
      // Identity comes from the final provider projection, never from a
      // message's wording or block shape. Only durable graph records can own
      // session-memory provenance; attachments and summaries cannot.
      if (message.source !== "record") continue
      const sourceUuid = requireExactDurableIdentifier(
        message.sourceUuid,
        "ContextProjectionService provider-visible record source UUID"
      )
      visible.add(sourceUuid)
    }
    return visible
  }
}
