import { Module } from "@nestjs/common"
import { CompactWarningHookService } from "./compact-warning-hook.service"
import { CompactWarningStateService } from "./compact-warning-state.service"
import { ClaudeConversationProjector } from "./claude-conversation-projector"
import { ContextAttachmentBuilderService } from "./context-attachment-builder.service"
import { CodexContextEngineService } from "./codex-context-engine.service"
import { ContextCompactRunnerService } from "./context-compact-runner.service"
import { ContextCompactionService } from "./context-compaction.service"
import { ContextManagerService } from "./context-manager.service"
import { ContextNativeManagementService } from "./context-native-management.service"
import { ContextPipeline } from "./context-pipeline.service"
import { ContextProjectionService } from "./context-projection.service"
import { ContextRequestPlannerService } from "./context-request-planner.service"
import { ContextTelemetryService } from "./context-telemetry.service"
import { ContextUsageLedgerService } from "./context-usage-ledger.service"
import { ReasoningPreambleProjectorService } from "./reasoning-preamble-projector.service"
import { TokenCounterService } from "./token-counter.service"
import { SessionMemoryService } from "./session-memory.service"
import { ToolIntegrityService } from "./tool-integrity.service"
import { ToolResultStorageService } from "./tool-result-storage.service"

/**
 * Context Module
 *
 * Provides unified context management for proxy request paths.
 *
 * Components:
 * - TokenCounterService: Accurate token counting (tiktoken)
 * - ToolIntegrityService: Tool-pair-aware truncation helpers (no repair)
 * - ContextProjectionService: Read-time API view over transcript + compaction boundary
 * - ContextCompactRunnerService: No-tools backend compact-summary execution
 * - ContextCompactionService: Boundary-based compaction + explicit budget failure
 * - ContextManagerService: Single orchestration entry point for session and stateless requests
 * - ContextRequestPlannerService: Request budget + pre-send projection planner
 * - ContextNativeManagementService: Provider-native context edit strategy builder
 * - SessionMemoryService: Explicit structured memory events retained across boundaries
 * - ContextTelemetryService: Lightweight in-memory event counters for diagnostics
 *
 * Design:
 * - Maintain a canonical transcript or ephemeral transcript state
 * - Project backend-facing messages at send time
 * - Record compaction as first-class state instead of ad hoc truncation
 */
@Module({
  providers: [
    TokenCounterService,
    ClaudeConversationProjector,
    CodexContextEngineService,
    CompactWarningStateService,
    CompactWarningHookService,
    ToolIntegrityService,
    ToolResultStorageService,
    ContextAttachmentBuilderService,
    ContextCompactRunnerService,
    ContextPipeline,
    ContextProjectionService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextManagerService,
    ContextNativeManagementService,
    ContextRequestPlannerService,
    ReasoningPreambleProjectorService,
    SessionMemoryService,
  ],
  exports: [
    TokenCounterService,
    ClaudeConversationProjector,
    CodexContextEngineService,
    CompactWarningStateService,
    CompactWarningHookService,
    ToolIntegrityService,
    ToolResultStorageService,
    ContextAttachmentBuilderService,
    ContextCompactRunnerService,
    ContextPipeline,
    ContextProjectionService,
    ContextTelemetryService,
    ContextUsageLedgerService,
    ContextCompactionService,
    ContextManagerService,
    ContextNativeManagementService,
    ContextRequestPlannerService,
    ReasoningPreambleProjectorService,
    SessionMemoryService,
  ],
})
export class ContextModule {}
