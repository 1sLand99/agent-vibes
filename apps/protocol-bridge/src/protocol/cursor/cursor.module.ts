import { Module } from "@nestjs/common"
import { ContextModule } from "../../context/context.module"
import { GoogleModule } from "../../llm/google/google.module"
import { KiroModule } from "../../llm/aws/kiro.module"
import { ImageGenerationModule } from "../../llm/image-generation/image-generation.module"
import { CodexModule } from "../../llm/openai/codex.module"
import { OpenaiCompatModule } from "../../llm/openai/openai-compat.module"
import { ModelModule } from "../../llm/shared/model.module"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { AntigravityIdeSyncService } from "./antigravity-ide-sync.service"
import { AiserverMockController } from "./controllers/aiserver-mock.controller"
import { AuthController } from "./controllers/auth.controller"
import { CursorAdapterController } from "./controllers/cursor-adapter.controller"
import { WorkspaceBranchController } from "./controllers/workspace-branch.controller"
import { WorkspacePreferenceController } from "./controllers/workspace-preference.controller"
import { CursorAuthService } from "./cursor-auth.service"
import { CursorConnectStreamService } from "./cursor-connect-stream.service"
import { CursorGrpcService } from "./cursor-grpc.service"
import { CursorSummaryDeliveryService } from "./cursor-summary-delivery.service"
import { CursorHookLifecycleService } from "./hooks/cursor-hook-lifecycle.service"
import { KnowledgeBaseService } from "./knowledge-base.service"
import { KvStorageService } from "./kv-storage.service"
import { SemanticSearchProviderService } from "./semantic-search-provider.service"
import { SessionLifecycleService } from "./session/session-lifecycle.service"
import { ExecDispatchSerializerService } from "./session/exec-dispatch-serializer.service"
import { InteractionQueryDeadlineSweeper } from "./session/interaction-query-deadline-sweeper.service"
import { ToolExecutionCoordinatorService } from "./session/tool-execution-coordinator.service"
import { WorkspacePreferenceService } from "./session/workspace-preference.service"
import { GitBranchService } from "./session/git-branch.service"
import { CursorSkillsManager } from "./skills"
import { SubagentLoaderService } from "./subagents/subagent-loader.service"
import { SubagentRegistryService } from "./subagents/subagent-registry.service"
import { SubagentExecBridgeService } from "./subagents/subagent-exec-bridge.service"
import { SubagentTranscriptStore } from "./subagents/subagent-transcript-store.service"
import { SubagentTaskRegistry } from "./subagents/subagent-task-registry.service"
import { SubagentBackgroundWorker } from "./subagents/subagent-background-worker.service"
import { ToolUseSummaryService } from "./subagents/tool-use-summary.service"
import { ClientSideToolV2ExecutorService } from "./tools/client-side-tool-v2-executor.service"
import { WebSearchAdapterFactory, WebSearchService } from "./web-search"
import { TurnLifecycle } from "./turn/turn-lifecycle.service"
import { TurnCleanupCoordinator } from "./turn/turn-cleanup-coordinator.service"
import { TopLevelAgentTurnRunnerService } from "./turn/top-level-agent-turn-runner.service"
import { MessageStore } from "./session/message-store.service"
import { ToolCallLedger } from "./session/tool-call-ledger.service"
import { SessionPersistenceService } from "./session/session-persistence.service"
import { AssistantToolBatchService } from "./session/assistant-tool-batch.service"
import { SessionStreamService } from "./session/session-stream.service"
import { ContextStateService } from "./session/context-state.service"
import { CursorWireStore } from "./session/cursor-wire-store.service"
import { ExecDispatchStore } from "./session/exec-dispatch-store.service"
import { ProviderActiveHeadStore } from "./session/provider-active-head.store"
import { ClaudeProjectionStore } from "./session/claude-projection-store.service"
import { ClaudeProjectionMutationLog } from "./session/claude-projection-mutation-log.service"
import { ContextProjectionHeadStore } from "./session/context-projection-active-head.store"
import { ContextProjectionStore } from "./session/context-projection-store.service"
import { CodexRolloutStore } from "./session/codex-rollout-store.service"
import { CodexProjectionStore } from "./session/codex-projection-store.service"
import { SnipBoundaryStore } from "./session/snip-boundary-store.service"
import { SessionMemoryEventStore } from "./session/session-memory-event-store.service"
import { SubagentBranchStore } from "./session/subagent-branch-store.service"
import { SubagentRunStore } from "./session/subagent-run-store.service"
import { ProjectionAttemptGate } from "./session/projection-attempt-gate.service"
import { BackgroundCommandStore } from "./session/background-command-store.service"
import { ConversationContextRuntimeService } from "./session/conversation-context-runtime.service"
import { AsyncUserInteractionStore } from "./session/async-user-interaction-store.service"

@Module({
  imports: [
    AnthropicModule,
    CodexModule,
    GoogleModule,
    ImageGenerationModule,
    KiroModule,
    ContextModule,
    ModelModule,
    OpenaiCompatModule,
  ],
  controllers: [
    CursorAdapterController,
    AuthController,
    AiserverMockController,
    WorkspacePreferenceController,
    WorkspaceBranchController,
  ],
  providers: [
    SessionLifecycleService,
    ToolExecutionCoordinatorService,
    WorkspacePreferenceService,
    GitBranchService,
    ExecDispatchSerializerService,
    ClientSideToolV2ExecutorService,
    AntigravityIdeSyncService,
    CursorAuthService,
    CursorConnectStreamService,
    CursorGrpcService,
    CursorSummaryDeliveryService,
    CursorHookLifecycleService,
    CursorSkillsManager,
    KvStorageService,
    SemanticSearchProviderService,
    KnowledgeBaseService,
    SubagentLoaderService,
    SubagentRegistryService,
    SubagentExecBridgeService,
    SubagentTranscriptStore,
    SubagentTaskRegistry,
    SubagentBackgroundWorker,
    ToolUseSummaryService,
    WebSearchAdapterFactory,
    WebSearchService,
    // Structured turn ownership and cleanup.
    TurnLifecycle,
    TurnCleanupCoordinator,
    TopLevelAgentTurnRunnerService,
    // Durable graph, ledger, provider projections, and normalized sessions.
    MessageStore,
    ToolCallLedger,
    SessionPersistenceService,
    AssistantToolBatchService,
    SessionStreamService,
    ContextStateService,
    CursorWireStore,
    ExecDispatchStore,
    BackgroundCommandStore,
    AsyncUserInteractionStore,
    ConversationContextRuntimeService,
    CursorSummaryDeliveryService,
    ProviderActiveHeadStore,
    SnipBoundaryStore,
    SessionMemoryEventStore,
    SubagentBranchStore,
    SubagentRunStore,
    ProjectionAttemptGate,
    ContextProjectionHeadStore,
    ContextProjectionStore,
    ClaudeProjectionMutationLog,
    ClaudeProjectionStore,
    CodexRolloutStore,
    CodexProjectionStore,
    InteractionQueryDeadlineSweeper,
  ],
  exports: [
    CursorAuthService,
    CursorConnectStreamService,
    SessionLifecycleService,
    ToolExecutionCoordinatorService,
    SubagentRegistryService,
    SubagentExecBridgeService,
    SubagentTaskRegistry,
    SubagentTranscriptStore,
    TurnLifecycle,
    TurnCleanupCoordinator,
    TopLevelAgentTurnRunnerService,
    MessageStore,
    ToolCallLedger,
    SessionPersistenceService,
    AssistantToolBatchService,
    SessionStreamService,
    ContextStateService,
    CursorWireStore,
    ExecDispatchStore,
    BackgroundCommandStore,
    AsyncUserInteractionStore,
    ConversationContextRuntimeService,
    ProviderActiveHeadStore,
    SnipBoundaryStore,
    SessionMemoryEventStore,
    SubagentBranchStore,
    SubagentRunStore,
    ProjectionAttemptGate,
    ContextProjectionHeadStore,
    ContextProjectionStore,
    ClaudeProjectionMutationLog,
    ClaudeProjectionStore,
    CodexRolloutStore,
    CodexProjectionStore,
  ],
})
export class CursorModule {}
