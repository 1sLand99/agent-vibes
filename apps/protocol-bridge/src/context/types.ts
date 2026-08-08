/**
 * Unified History Management Types
 *
 * This module defines unified message types used by the proxy,
 * supporting both content-block tool calls and function-call style fields.
 */

import {
  CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
  type CodexRawResponseItemBlock,
  type CodexReplacementHistoryItem,
} from "../shared/provider-content"

export {
  CODEX_RAW_RESPONSE_ITEM_BLOCK_TYPE,
  type CodexRawResponseItemBlock,
  type CodexReplacementHistoryItem,
}

/**
 * Text content block
 */
export interface TextBlock {
  type: "text"
  text: string
  cache_control?: {
    type: string
    ttl?: string
  }
}

/**
 * Tool use content block (Anthropic format)
 * Represents an AI request to use a tool
 */
export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: {
    type: string
    ttl?: string
  }
}

/**
 * Tool result content block (Anthropic format)
 * Represents the result of a tool execution
 */
export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
  structuredContent?: Record<string, unknown>
  cache_reference?: string
  cache_control?: {
    type: string
    ttl?: string
  }
}

/**
 * Image content block
 */
export interface ImageBlock {
  type: "image"
  /** Responses API image fidelity retained by the provider-neutral graph. */
  detail?: "auto" | "low" | "high" | "original"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
  cache_control?: {
    type: string
    ttl?: string
  }
}

/**
 * Thinking content block (Claude extended thinking)
 */
export interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
  cache_control?: {
    type: string
    ttl?: string
  }
}

/**
 * Opaque reasoning payload emitted by providers that intentionally do not
 * expose the underlying chain of thought.  It is a first-class content block:
 * coercing it into text would both lose the provider boundary and make the
 * redacted bytes appear as user-visible prose.
 */
export interface RedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
  cache_control?: {
    type: string
    ttl?: string
  }
}

export interface CacheEditsBlock {
  type: "cache_edits"
  edits: Array<{
    type: "delete"
    cache_reference: string
  }>
}

/**
 * All possible content block types
 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | CacheEditsBlock

/**
 * Function-call style tool call
 */
export interface FunctionToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContextMessageSource =
  | "record"
  | "boundary"
  | "summary"
  | "attachment"
  | "snip"
  | "microcompact"
  | "hook"
  | "protected_context"

export type LooseMessageContent =
  | string
  | ContentBlock[]
  | Array<{ type: string; [key: string]: unknown }>

/**
 * Unified message format
 * Supports both content-block and function-call style formats.
 */
export interface UnifiedMessage {
  role: "system" | "user" | "assistant"
  content: string | ContentBlock[]

  // Function-call style tool calls (assistant messages)
  tool_calls?: FunctionToolCall[]

  // Function-call style tool result reference (tool role messages)
  tool_call_id?: string

  // Metadata
  token_count?: number
  created_at?: number

  /**
   * Anthropic message id when known (assistant messages only). Multiple
   * UnifiedMessage entries may share the same id — that's the split-sibling
   * pattern from claude-code/src/services/api/claude.ts:2281-2300, where
   * each `content_block_stop` emits its own AssistantMessage carrying the
   * turn-wide `message.id`. Send-time normalization
   * (apps/protocol-bridge/src/llm/shared/normalize-for-api.ts:
   * `mergeAssistantMessagesById`) folds siblings by this key. Optional
   * because attachment / boundary / summary / hook projections have no
   * Anthropic id to attach.
   */
  messageId?: string

  /**
   * cc-style isMeta — when true, this message exists for context
   * plumbing only (compaction summaries, attachment hoists, hook
   * injections) and the IDE-facing transcript should hide it. Mirrors
   * cc utils/messages.ts:484 + bridge/bridgeMessaging.ts:117. The
   * normalize-for-api pipeline already understands the field on its
   * FlatUser shape (`mergeUserMessages` favours non-meta uuid /
   * preserves meta only when both sides are meta — line 325-326).
   * User-side only; the type allows the field on assistants for
   * structural simplicity but writers should leave it absent there.
   */
  isMeta?: boolean

  /**
   * Origin of synthesized context messages. This must survive send-time
   * normalization so provider adapters can keep internal context separate
   * from user-authored conversation text.
   */
  source?: ContextMessageSource

  /** Durable graph identity carried only between projection layers. */
  sourceUuid?: string

  /**
   * More specific attachment classifier when source === "attachment".
   */
  attachmentKind?: ContextProjectionAttachment["kind"]
}

/**
 * A message projected from an already-persisted graph fragment.
 *
 * Unlike a raw API message, this input has a durable source identity which
 * must survive every intermediate context representation. Callers use the
 * strict graph projection API rather than the raw-message API so an
 * incremental provider ledger can bind the resulting native input to the
 * same graph record on every request.
 */
export interface DurableGraphProjectionMessage extends Omit<
  UnifiedMessage,
  "role" | "sourceUuid"
> {
  role: "user" | "assistant"
  sourceUuid: string
}

/**
 * Tool pair for integrity checking
 */
export interface ToolPair {
  tool_use_id: string
  tool_use_message_index: number
  tool_result_message_index: number | null
  tool_name: string
}

export interface ContextUsageSnapshot {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  totalTokens: number
  recordedAt: number
}

export interface ContextTranscriptRecord {
  id: string
  /** Durable graph edge. The provider message id is never used as identity. */
  parentUuid?: string
  /** Logical predecessor used when a compacted segment reconnects the graph. */
  logicalParentUuid?: string
  /** Assistant fragment that emitted the tool_use matched by this result. */
  sourceToolAssistantUuid?: string
  /** Provider that emitted this graph fragment. */
  provider?: string
  /** Provider-native id. Multiple records may intentionally share it. */
  providerMessageId?: string
  /** Stable occurrence within a provider message's streamed content blocks. */
  blockIndex?: number
  turnId?: string
  threadId?: string
  branchId?: string
  agentId?: string
  isSidechain?: boolean
  forkSourceUuid?: string
  forkLineage?: string[]
  /** Retained for audit/replay but excluded from subsequent provider prompts. */
  excludedFromProviderProjection?: boolean
  role: "user" | "assistant"
  content: LooseMessageContent
  createdAt: number
  /**
   * Anthropic message id (when known). Multiple records may share the same
   * `messageId` — that's the split-sibling pattern from
   * claude-code/src/services/api/claude.ts:2281-2300, where each
   * content_block_stop emits its own AssistantMessage with a fresh `uuid`
   * but the turn-wide `message.id`. Send-time normalization merges siblings
   * by this key.
   */
  messageId?: string
  /**
   * cc-style isMeta carried from SessionUserMessage. Message records normally
   * represent real transcript turns, but internal recovery/context prompts are
   * also persisted through the same record path and must remain distinguishable
   * from user-authored input after projection.
   */
  isMeta?: boolean
  kind?:
    | "message"
    | "compact_boundary"
    | "compact_summary"
    | "snip_boundary"
    | "microcompact_boundary"
    | "attachment"
    | "hook_result"
  compactMetadata?: {
    commit?: ContextCompactionCommit
    summary?: string
  }
  attachmentMetadata?: ContextProjectionAttachment
  hookMetadata?: {
    trigger: "manual" | "auto" | "reactive"
    compactionId: string
  }
  snipMetadata?: {
    /** Immutable main-graph record immediately preceding this boundary. */
    afterGraphUuid: string
    removedRecordIds: string[]
  }
  microcompactMetadata?: {
    trigger: "auto" | "idle"
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
  }
}

export interface ContextProjectionAttachment {
  kind:
    | "session_memory"
    | "sub_agent"
    | "read_paths"
    | "file_states"
    | "file_snapshots"
    | "todos"
  label: string
  content: string
  tokenCount: number
}

/** One compact summary event derived from transcript-native boundary records. */
export interface ContextCompactionCommit {
  id: string
  strategy: "auto" | "manual" | "reactive"
  createdAt: number
  epoch?: number
  parentCompactionId?: string
  archivedThroughRecordId: string
  projectionAnchorRecordId?: string
  archivedMessageCount: number
  sourceRecordCount?: number
  retainedStartRecordId?: string
  retainedRecordCount?: number
  retainedTextRecordCount?: number
  retainedTokenCount?: number
  attachmentFingerprint?: string
  sourceTokenCount: number
  summary: string
  summaryTokenCount: number
  projectedTokenCount: number
}

export interface ClaudeProjectionCapabilitySnapshot {
  model: string
  toolCatalogHash: string
  betaFlags: string[]
  supportsThinking: boolean
  supportsImages: boolean
}

export interface ClaudePreservedSegment {
  headUuid: string
  anchorUuid: string
  tailUuid: string
}

/**
 * Exact, ordered recipe for reconstructing a Claude model window. It is not a
 * generic checkpoint and does not infer membership from a linear sequence.
 */
export interface ClaudeProjectionRecipe {
  id: string
  createdAt: number
  boundaryRecordId: string
  summaryRecordId: string
  orderedRecordIds: string[]
  attachmentRecordIds: string[]
  hookResultRecordIds: string[]
  excludedRecordIds: string[]
  preservedSegment?: ClaudePreservedSegment
  capability: ClaudeProjectionCapabilitySnapshot
}

export type ProjectionExclusionReason =
  | "checkpoint_excluded"
  | "snipped"
  | "provider_exclusion"
  | "incomplete_tool_use"
  | "orphan_tool_result"
  | "duplicate_tool_use"
  | "provider_capability"
  | "internal_marker"
  | "ui_only"

export interface ProjectionManifestEntry {
  sourceUuid: string
  included: boolean
  reason?: ProjectionExclusionReason
}

export interface ProjectionManifest {
  provider: "claude" | "codex"
  generation: string
  sourceEntries: ProjectionManifestEntry[]
  toolCatalogHash: string
  capabilityHash: string
  /** Last durable graph fragment visible in this provider projection. */
  activeLeafUuid?: string
  tokenBreakdown?: Record<string, number>
}

export interface ContextUsageLedgerState {
  anchorRecordId?: string
  lastUsage?: ContextUsageSnapshot
  projectedTokenCount?: number
  accountingProfileKey?: string
  recordedCompactionId?: string
  attachmentFingerprint?: string
}

export interface ContextCompactionBasis {
  recordCount: number
  attachmentFingerprint: string
  appliedAt: number
  compactionId: string
  epoch: number
}

export interface ContextStoredToolResultReference {
  toolUseId: string
  documentId: string
  relativePath: string
  toolName: string
  originalSizeChars: number
  originalLineCount: number
  previewChars: number
  chunkSize: number
  chunkCount: number
  contentType: "text" | "json"
  sha256: string
  createdAt: number
}

export interface ContextToolResultReplacementRecord {
  kind: "tool-result"
  toolUseId: string
  replacement: string
  /** Exact provider-visible replacement format version. */
  projectionVersion?: number
  provider?: "claude"
  documentId?: string
  reason?: "per_tool" | "aggregate" | "empty" | "microcompact" | "snip"
  createdAt: number
}

export interface ContextToolResultReplacementState {
  seenToolUseIds: string[]
  replacementByToolUseId: Record<string, string>
  storedByToolUseId?: Record<string, ContextStoredToolResultReference>
  records?: ContextToolResultReplacementRecord[]
}

/**
 * One immutable, replay-safe change to Claude's tool-result projection.
 *
 * Tool-result graph rows are committed before their provider projection is
 * installed.  Passing a semantic mutation across that boundary, rather than
 * a mutable state snapshot, lets the projection owner merge independently
 * committed results in order without overwriting a sibling tool result.
 */
export type ContextToolResultReplacementMutation =
  | {
      kind: "seen"
      toolUseId: string
    }
  | {
      kind: "replacement"
      toolUseId: string
      replacement: string
      record: ContextToolResultReplacementRecord
      storedReference?: ContextStoredToolResultReference
    }

export interface CodexTruncationPolicy {
  mode: "bytes" | "tokens"
  limit: number
}

export interface CodexReferenceContextItem {
  conversationId?: string
  model?: string
  systemPromptHash?: string
  toolSpecHash?: string
  contextTokenLimit?: number
  serviceTier?: string
  reasoningEffort?: string
  truncationPolicy: CodexTruncationPolicy
  updatedAt: number
}

export type ContextSessionMemoryKind =
  | "objective"
  | "decision"
  | "progress"
  | "file"
  | "constraint"
  | "verification"
  | "risk"
  | "command"
  | "sub_agent"
  | "open_item"

/**
 * A compact fact produced from one concrete sub-agent tool step.  This is
 * deliberately structured before it is rendered into either the parent task
 * result or durable session memory; no reader is allowed to recover it by
 * scanning a report string later.
 */
export interface SubAgentMemoryEvidence {
  toolName: string
  summary: string
}

/**
 * Provider-neutral payload for a completed/interrupted sub-agent event.
 * `resultText` is the sub-agent's own final answer; it is bounded by the
 * writer before persistence and is not reconstructed from a transcript.
 */
export interface SubAgentMemoryPayload {
  agentId: string
  agentType?: string
  status: string
  turnCount?: number
  toolCallCount?: number
  durationMs?: number
  modifiedFiles?: string[]
  resultText?: string
  evidence: SubAgentMemoryEvidence[]
  task?: string
}

/**
 * The durable terminal graph fragment that proves where a session-memory
 * event came from. A memory event is never anchored to a task invocation:
 * only the accepted task result or the exact Cursor control notification that
 * delivered the terminal report can be its source.
 */
export type SessionMemorySourceKind = "tool_result" | "control_notification"

/**
 * Structured domain event owned by a sub-agent lifecycle. The event is
 * persisted append-only; a later state change is a new revision of the same
 * `sourceEventId`, never an update of the original row.
 */
export interface SubAgentMemoryEvent {
  /** Conversation scope; event identities are unique only inside it. */
  conversationId: string
  /** Stable lifecycle identity, normally `sub_agent:<agentId>`. */
  sourceEventId: string
  /** Parent task tool-call identity. */
  sourceToolUseId: string
  /** Exact accepted graph fragment verified by the event store. */
  sourceRecordUuid: string
  sourceKind: SessionMemorySourceKind
  payload: SubAgentMemoryPayload
  weight: number
  createdAt: number
}

export interface ContextSessionMemoryEntry {
  /** Stable durable event identity, not a wording-derived key. */
  id: string
  kind: ContextSessionMemoryKind
  text: string
  /** Stable domain event identity, e.g. `sub_agent:<agentId>`. */
  sourceEventId: string
  /** Exact parent task tool-use identity for the terminal delivery. */
  sourceToolUseId: string
  /** Exact durable graph fragment that accepted the terminal delivery. */
  sourceRecordUuid: string
  /** Formal terminal delivery route that owns the graph fragment. */
  sourceKind: SessionMemorySourceKind
  /** Monotonic revision within one durable event identity. */
  revision: number
  createdAt: number
  weight: number
}

export interface SessionMemorySummaryLike {
  kind: ContextSessionMemoryKind
  text: string
  createdAt?: number
  weight?: number
  sourceToolUseId: string
  sourceRecordUuid: string
  sourceKind: SessionMemorySourceKind
}

/**
 * Aggregate root for one conversation's context state.
 *
 * **Mutability contract — single-writer**
 *
 * This object is mutated in place by `ContextCompactionService` and
 * related services (records pushed, compaction history appended,
 * replacement state pruned, etc.).  The
 * design only stays sound under a single-writer assumption: at any
 * moment exactly one async task should be calling into the context
 * services for a given state.
 *
 * Two callers in the bridge currently obey this:
 *
 * 1. `cursor-connect-stream.service.ts` serialises requests per session
 *    via `SessionLifecycleService` so the writer is the request handler.
 * 2. `anthropic/messages.service.ts` is stateless — every request
 *    creates an ephemeral state via `ContextManagerService`.
 *
 * If you ever introduce a new caller (background composer follow-up,
 * push-driven session updates, etc.), wrap concurrent access in a
 * per-session mutex BEFORE calling any context service.  The state
 * shape is graph-y enough that interleaved mutation will produce
 * silently corrupt projections (commit chain torn, replacement
 * dictionary out of sync with records, etc.) and the test suite
 * cannot catch that because tests run serially by construction.
 *
 * Do not "fix" this by deep-cloning on every read — it would be
 * correct but allocates O(records × rounds) on every request and
 * defeats the ledger's projected-token cache.
 */
export interface ContextCompactWarningState {
  /**
   * True after a successful microcompact / cache_edit emission /
   * boundary compaction. Suppresses the next round of "compaction
   * imminent" telemetry emissions until cleared on the next
   * ensureWithinBudget entry.
   */
  suppressed: boolean
  /** Wall-clock time of the last `compaction.warning_imminent` emission. */
  lastEmittedEpoch?: number
}

export interface ContextConversationState {
  records: ContextTranscriptRecord[]
  compactionHistory: ContextCompactionCommit[]
  activeCompactionId?: string
  compactionEpoch?: number
  lastAppliedCompaction?: ContextCompactionBasis
  usageLedger: ContextUsageLedgerState
  toolResultReplacementState?: ContextToolResultReplacementState
  sessionMemory: ContextSessionMemoryEntry[]
  compactWarningState?: ContextCompactWarningState
  /** Exact last fragment in this projection owner's mounted durable graph. */
  graphWatermarkUuid?: string
}

export interface ProjectedContextMessage {
  role: "user" | "assistant"
  content: LooseMessageContent
  source: ContextMessageSource
  recordId?: string
  sourceUuid?: string
  /**
   * Anthropic message id (when source === "record" and the underlying
   * `ContextTranscriptRecord.messageId` was set). Carries the same
   * split-sibling key as `UnifiedMessage.messageId`; preserved through
   * compaction so send-time merge can fold siblings.
   */
  messageId?: string
  /**
   * cc-style isMeta — set when this projected message is infrastructure
   * (compaction summary / boundary / attachment / hook). Forwarded onto
   * UnifiedMessage so the IDE-facing transcript layer can choose to
   * hide it. `record` source rows reflect actual user/assistant turns
   * and stay non-meta unless the underlying SessionMessage already
   * carries isMeta=true.
   */
  isMeta?: boolean
  commitId?: string
  attachmentKind?: ContextProjectionAttachment["kind"]
  compactionEvent?: {
    type: "boundary" | "summary"
    commitId: string
    epoch?: number
    parentCompactionId?: string
    archivedThroughRecordId?: string
    summaryTokenCount?: number
    sourceTokenCount?: number
    projectedTokenCount?: number
  }
}

/**
 * Helper type guard for TextBlock
 */
export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text"
}

/**
 * Helper type guard for ToolUseBlock
 */
export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use"
}

/**
 * Helper type guard for ToolResultBlock
 */
export function isToolResultBlock(
  block: ContentBlock
): block is ToolResultBlock {
  return block.type === "tool_result"
}

/**
 * Helper type guard for ImageBlock
 */
export function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image"
}

/**
 * Helper type guard for ThinkingBlock
 */
export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === "thinking"
}

export function isCacheEditsBlock(
  block: ContentBlock
): block is CacheEditsBlock {
  return block.type === "cache_edits"
}

/**
 * Parse content that may be a JSON string or array
 * Returns null if parsing fails or content is not array-like
 */
export function parseContent(content: unknown): ContentBlock[] | null {
  // Already an array
  if (Array.isArray(content)) {
    return content as ContentBlock[]
  }

  // Try to parse JSON string
  if (typeof content === "string") {
    const trimmed = content.trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          return parsed as ContentBlock[]
        }
      } catch {
        // Not valid JSON, return null
      }
    }
  }

  return null
}

/**
 * Normalize message content to array format
 * Handles both string and array content
 */
export function normalizeContent(content: LooseMessageContent): ContentBlock[] {
  if (typeof content === "string") {
    // Try to parse as JSON array first
    const parsed = parseContent(content)
    if (parsed) {
      return parsed
    }
    // Plain text string - wrap in TextBlock
    return [{ type: "text", text: content }]
  }
  return content as ContentBlock[]
}

/**
 * Extract text from content (string or array)
 */
export function extractText(content: LooseMessageContent): string {
  if (typeof content === "string") {
    // Try to parse as JSON array
    const parsed = parseContent(content)
    if (parsed) {
      return parsed
        .filter(isTextBlock)
        .map((b) => b.text)
        .join("")
    }
    return content
  }

  return (content as ContentBlock[])
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("")
}
