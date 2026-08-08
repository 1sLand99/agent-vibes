/**
 * Context Module Exports
 *
 * Provides conversation history management, projection, and compaction.
 */

// Types
export * from "./types"

// Context services
export {
  resolveAutoCompactTokenLimit,
  type ContextAutoCompactInput,
} from "./context-auto-compact-policy"
export { CompactWarningStateService } from "./compact-warning-state.service"
export { CompactWarningHookService } from "./compact-warning-hook.service"
export {
  ClaudeCheckpointCorruptError,
  ClaudeConversationProjector,
  ClaudeToolPairIntegrityError,
} from "./claude-conversation-projector"
export type {
  ClaudeConversationProjection,
  ClaudeConversationProjectionOptions,
  ClaudeMicrocompactProjection,
} from "./claude-conversation-projector"
export { CodexContextEngineService } from "./codex-context-engine.service"
export type { CodexGraphDeltaProjectionOptions } from "./codex-context-engine.service"
export type {
  CodexCompactReferenceInput,
  CodexContextCompactionCommit,
  CodexContextCompactionPlan,
  CodexRemoteCompactProvider,
  CodexRemoteCompactRequest,
  CodexRemoteCompactResult,
} from "./codex-context-engine.service"
export { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
export type {
  ContextAttachmentSnapshot,
  SessionTodoAttachmentLike,
} from "./context-attachment-builder.service"
export {
  buildContextCompactSummaryMessages,
  ContextCompactRunnerService,
} from "./context-compact-runner.service"
export type {
  ContextCompactRunnerHookProvider,
  ContextCompactRunnerSummaryProvider,
  ContextCompactRunnerSummaryRequest,
  ContextCompactRunnerSummaryResult,
} from "./context-compact-runner.service"
export {
  ContextCompactionService,
  ContextProjectionBudgetExceededError,
  orderContextCompactionProjectionRecords,
  rebaseSnipBoundariesIntoCompactProjection,
  splitContextCompactionRecords,
} from "./context-compaction.service"
export type {
  ContextCompactionCandidate,
  ContextCompactionInstallInput,
  ContextBudgetEnforcement,
  ContextProjectionBudgetBoundary,
  ContextCompactionPlan,
  ContextCompactionResult,
  ContextCompactionSplit,
} from "./context-compaction.service"
export {
  buildContextCompactPrompt,
  CONTEXT_COMPACT_MAX_OUTPUT_TOKENS,
  formatContextCompactSummary,
  type ContextCompactionMode,
} from "./context-compact-prompt"
export { ContextManagerService } from "./context-manager.service"
export {
  buildContextProjectionBudgetSignature,
  isContextAccountingProfileCompatible,
  resolveContextModelProfile,
  resolveContextTokenizer,
} from "./context-model-profile"
export type {
  ContextModelFamily,
  ContextModelProfile,
  ContextModelProfileInput,
  ContextProjectionBudgetSignatureInput,
  ContextTokenizer,
} from "./context-model-profile"
export { ContextNativeManagementService } from "./context-native-management.service"
export type {
  AnthropicNativeContextManagementInput,
  ContextNativeEditStrategy,
  ContextNativeManagementConfig,
} from "./context-native-management.service"
export { ContextPipeline } from "./context-pipeline.service"
export { ContextProjectionService } from "./context-projection.service"
export type { ContextProjectionResult } from "./context-projection.service"
export { ContextRequestPlannerService } from "./context-request-planner.service"
export {
  requireExactDurableIdentifier,
  requireOptionalExactDurableIdentifier,
} from "./durable-identifier"
export { ReasoningPreambleProjectorService } from "./reasoning-preamble-projector.service"
export type {
  ReasoningRecord,
  ReasoningPreamble,
  ReasoningPreambleBudget,
  ReasoningPreambleBuildInput,
} from "./reasoning-preamble-projector.service"
export type {
  ContextProjectionOptions,
  ContextProjectionBudget,
  ContextRequestBudget,
  ContextRequestBudgetDecision,
  ContextRequestBudgetInput,
  ContextRequestBudgetSelectionSource,
} from "./context-request-planner.service"
export { ContextTelemetryService } from "./context-telemetry.service"
export type {
  ContextTelemetryEvent,
  ContextTelemetryEventDetail,
} from "./context-telemetry.service"
export { CONTEXT_MICROCOMPACT_CLEARED_MARKER } from "../shared/context-compaction"
export {
  createCompactBoundaryRecord,
  createCompactSummaryRecord,
  createAttachmentRecord,
  createHookResultRecord,
  createMicrocompactBoundaryRecord,
  createSnipBoundaryRecord,
  deriveCompactionHistoryFromTranscript,
  findLastCompactBoundaryIndex,
  getActiveCompactCommitFromTranscript,
  getRecordsAfterCompactBoundary,
  resolveCompactSummaryReplacementAnchor,
  resolveContextReplacementAnchor,
  isAttachmentRecord,
  isCompactBoundaryRecord,
  isCompactSummaryRecord,
  isHookResultRecord,
  isMessageRecord,
  isMicrocompactBoundaryRecord,
  isSnipBoundaryRecord,
  projectSnippedView,
  stripInternalContextEvents,
} from "./context-transcript-events"
export { ContextUsageLedgerService } from "./context-usage-ledger.service"
export { SessionMemoryService } from "./session-memory.service"
export { TokenCounterService } from "./token-counter.service"
export { ToolIntegrityService } from "./tool-integrity.service"
export type { EnforceToolProtocolOptions } from "./tool-integrity.service"
export { ToolResultStorageService } from "./tool-result-storage.service"
export type {
  ToolResultStorageProcessInput,
  ToolResultStorageProcessResult,
} from "./tool-result-storage.service"
export {
  applyToolResultReplacementMutations,
  createToolResultReplacementMutation,
  createToolResultSeenMutation,
} from "./tool-result-replacement-state"

// Round-aware truncation helpers
export {
  findRoundAlignedTruncationIndex,
  groupMessagesByApiRound,
  groupTranscriptRecordsByApiRound,
} from "./api-round-grouping"

// Attachment fingerprinting (shared by compaction planner and usage ledger)
export {
  fingerprintAttachments,
  fingerprintProjectedAttachments,
} from "./attachment-fingerprint"

// Backend-agnostic prompt-too-long error inspection
export { detectPromptTooLong } from "./prompt-too-long"
export type { PromptTooLongDetection } from "./prompt-too-long"

// Sub-agent session-memory formatting (shared by streaming service
// and compaction-time extraction so the two entry shapes stay aligned)
export {
  buildSubAgentMemorySourceEventId,
  createSubAgentCompletionArtifact,
  formatSubAgentMemoryBody,
  formatSubAgentMemoryEntry,
  renderSubAgentCompletionReport,
  toSubAgentMemoryPayload,
} from "./sub-agent-memory-formatter"

export type {
  SubAgentMemoryFormatInput,
  SubAgentCompletionArtifact,
  SubAgentMemoryFormatOptions,
} from "./sub-agent-memory-formatter"

// Modules
export { ContextModule } from "./context.module"
