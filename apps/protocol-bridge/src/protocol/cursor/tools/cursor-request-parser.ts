import { create, toBinary } from "@bufbuild/protobuf"
import { Logger } from "@nestjs/common"
import type { ContentBlock } from "../../../context/types"
import type { SubagentTerminalDeliveryCommit } from "../subagents/subagent-terminal-delivery"
import type { CursorToolResultStatus } from "./tool-result-status"

import {
  buildBuiltInKarpathyRule,
  buildBuiltInDisciplineRule,
  isKarpathyRule,
} from "./built-in-rules"

import {
  AgentClientMessage,
  AgentRunRequest,
  BackgroundTaskCompletionReason,
  BackgroundTaskStatus,
  type ConversationAction,
  type ConversationStep,
  type CursorRule,
  ExecClientControlMessage,
  ExecClientMessage,
  ExecClientMessageSchema,
  InteractionResponse,
  type ResumeAction,
  type RequestedModel_ModelParameterValue,
  type SandboxPolicy,
  UserMessage,
  UserMessageAction,
  type SkillOptions,
  SkillOptionsSchema,
} from "../../../gen/agent/v1_pb"
import { parseModelRequest } from "../../../llm/shared/model-request"
import { doesModelSupportThinking } from "../../../llm/shared/model-registry"
import { normalizeRequestedThinkingEffort } from "../../../llm/shared/thinking-intent"
import { parseCursorVariantString } from "../cursor-model-protocol"
import type { ContextTokenLimitSource } from "../session/context-window-transition"
import type { CursorManagedReadResource } from "../session/cursor-managed-read-resource"
import type { BackgroundShellCompletionIdentity } from "../session/background-command-store.service"
import {
  getDefaultAgentToolNames,
  isCursorBuiltInToolAllowed,
} from "./cursor-tool-mapper"
import { type BridgeGoalState, fromProtoGoalState } from "./goal-state"
import {
  parseSubagentModelOverrides,
  type SubagentModelOverridesMap,
} from "../subagents/subagent-model-override"
import {
  parseSelectedSubagentModels,
  type SelectedSubagentModelCatalog,
} from "../subagents/subagent-model-selection"
import {
  getCursorSkillMetadata,
  normalizeSkillName,
  normalizePathForMatch,
} from "../skills"
import {
  deriveProjectContextPresentation,
  parseCursorWorkspaceState,
  type ConversationStateWorkspaceInput,
  type ParsedResumeWorkspaceReference,
  type ParsedWorkspaceDeclaration,
  type WorkspaceFolderExtractionInput,
} from "./workspace-declaration"
import { CursorProtocolTraceService } from "../cursor-protocol-trace.service"
import { safeJsonStringify } from "../safe-json"
import {
  createCursorRequestWireState,
  CursorInterruptedPendingToolCallResolutionCodecError,
  decodeCursorAgentClientFrame,
  extractCursorInterruptedPendingToolCallResolutions,
  type CursorAgentClientFrame,
  type CursorConversationEntry,
  type CursorInterruptedPendingToolCallResolutionsWire,
  type CursorProtocolReferenceResolver,
  type CursorRequestWireState,
} from "../codec/cursor-conversation-codec"
import {
  createCursorExecResultRecord,
  type CursorExecResultRecord,
} from "../exec-dispatch-contract"
import { cursorBlobIdToKey } from "../codec/cursor-blob-id"
import type { ChatTurnExecutionIntent } from "../turn/chat-turn-execution-intent"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import {
  parseCursorHookAdditionalContextReceipts,
  selectCursorAgentHookSteps,
  type CursorAgentHookStep,
  type CursorHookAdditionalContextReceipt,
} from "../hooks/cursor-hook-contract"
import { getEffectiveCursorUserMessageAction } from "./subscription-notification-action"

const CURSOR_UINT32_MAX = 0xffff_ffff

function mergeSkillOptions(
  ...options: Array<SkillOptions | undefined>
): SkillOptions | undefined {
  const descriptors = []
  const seen = new Set<string>()
  for (const option of options) {
    for (const descriptor of option?.skillDescriptors || []) {
      const key = [
        descriptor.readmeFilePath || "",
        descriptor.folderPath || "",
        descriptor.name || "",
      ]
        .map((value) => value.trim().toLowerCase())
        .find((value) => value.length > 0)
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      descriptors.push(descriptor)
    }
  }
  if (descriptors.length === 0) {
    return undefined
  }
  return create(SkillOptionsSchema, { skillDescriptors: descriptors })
}

/** The only Cursor thinking levels represented by the Agent v1 protocol. */
export type CursorThinkingLevel = 0 | 1 | 2

// 已解析的 tool 结果
export interface ParsedToolResult {
  /**
   * Runtime tool-call identity for bridge-created inline results. A real
   * Cursor ExecClientMessage must use `execIdentity` instead.
   */
  runtimeToolCallId?: string
  toolType: number
  resultCase: string
  resultData: Buffer
  /**
   * The IDs actually carried by the client result frame. Synthetic bridge
   * results do not have a Cursor ExecClientMessage and therefore omit it.
   */
  execIdentity?: CursorExecResultRecord
  // Optional synthetic result content injected by server-side inline tools.
  inlineContent?: string
  /**
   * Optional provider-neutral graph content for synthetic inline tools.
   * Provider-native response items are reconstructed by the owning projector
   * and must never enter this durable content-block boundary.
   */
  inlineGraphContent?: string | ContentBlock[]
  /** Structured graph data used to reconstruct an owning provider's item. */
  inlineGraphStructuredContent?: Record<string, unknown>
  /**
   * Protocol audit metadata persisted with the durable graph fragment, never
   * treated as model-facing tool-result content.
   */
  inlineGraphMetadata?: Record<string, unknown>
  inlineState?: {
    status: CursorToolResultStatus
    message?: string
  }
  /** Hook context already executed by Cursor around a client-owned tool. */
  hookAdditionalContexts?: readonly CursorHookAdditionalContextReceipt[]
  inlineProjection?: {
    taskSuccess?: {
      conversationSteps?: ReadonlyArray<
        ConversationStep | Record<string, unknown>
      >
      agentId?: string
      isBackground?: boolean
      durationMs?: bigint | number
      resultSuffix?: string
      backgroundReason?: number
      transcriptPath?: string
    }
    askQuestionResult?: {
      resultCase: "success" | "async" | "rejected" | "error"
      answers?: Array<{
        questionId?: string
        selectedOptionIds?: string[]
        freeformText?: string
      }>
      reason?: string
      errorMessage?: string
    }
    webSearchResult?: {
      query?: string
      references?: Array<{
        title?: string
        url?: string
        chunk?: string
      }>
    }
    webFetchResult?: {
      url?: string
      title?: string
      contentType?: string
      markdown?: string
    }
  }
  inlineExtraData?: {
    shellResult?: {
      command?: string
      workingDirectory?: string
      stdout?: string
      stderr?: string
      exitCode?: number
      signal?: string
      executionTime?: number
      shellId?: number
      pid?: number
      msToWait?: number
      terminalsFolder?: string
      backgroundReason?: number
      isBackground?: boolean
      aborted?: boolean
      abortReason?: number
      localExecutionTimeMs?: number
      interleavedOutput?: string
      outputHead?: string
      outputTail?: string
      elidedChars?: number
      outputLocation?: {
        filePath?: string
        sizeBytes?: bigint | number
        lineCount?: bigint | number
      }
      timeoutMs?: number
      isReadonly?: boolean
      terminalMessage?: string
      requestedSandboxPolicy?: SandboxPolicy | Record<string, unknown> | null
    }
    taskError?: string
    writeShellStdinSuccess?: {
      shellId?: number
      terminalFileLengthBeforeInputWritten?: number
    }
    generateImageSuccess?: {
      filePath?: string
      imageData?: string
    }
    replaceEnvResult?:
      | { case: "success"; setupLogs?: string }
      | { case: "failure"; errorMessage?: string; setupLogs?: string }
    prManagementResult?:
      | {
          case: "success"
          prUrl?: string
          prNumber?: number
          message?: string
        }
      | { case: "error"; error?: string }
      | { case: "rejected"; reason?: string }
      | {
          case: "registered"
          message?: string
          title?: string
          body?: string
          baseBranch?: string
          draft?: boolean
          branchName?: string
        }
      | {
          case: "needsConfirmation"
          message?: string
          discoveredPrUrl?: string
          discoveredPrNumber?: number
          discoveredPrTitle?: string
          branchName?: string
        }
    diagnosticsSuccess?: {
      path?: string
      diagnostics?: Array<Record<string, unknown>>
      totalDiagnostics?: number
      files?: Array<{
        path: string
        diagnostics: Array<Record<string, unknown>>
        totalDiagnostics: number
      }>
    }
    conversationSearchSuccess?: {
      hits: Array<{
        conversationId: string
        title: string
        updatedAtMs: number
        snippet: string
      }>
      truncated: boolean
      partial: boolean
    }
    awaitResult?: {
      complete: boolean
      runtimeMs: number
      outputFilePath: string
      outputLength: number
      exitCode?: number
      regexRequested: boolean
      regexMatch?: string
    }
  }
}

// MCP 工具定义（从 Cursor 协议 McpToolDefinition 解析）
export interface McpToolDef {
  /** 完整工具名（含 server 前缀），如 "user-Context7-resolve-library-id" */
  name: string
  /** MCP 工具的原始名称，如 "resolve-library-id" */
  toolName: string
  /** MCP server 标识，如 "user-Context7" */
  providerIdentifier: string
  /** 工具描述 */
  description: string
  /** JSON Schema 形式的 input_schema */
  inputSchema?: Record<string, unknown>
  /**
   * IDE-side MCP server registry key — the value the Cursor IDE actually
   * uses to look up the server when bridge forwards `serverName` /
   * `provider_identifier` on `ListMcpResourcesExecArgs`,
   * `ReadMcpResourceExecArgs`, or `McpArgs`.
   *
   * Background: in current Cursor builds, the wire-level
   * `McpToolDefinition.provider_identifier` is the short alias the user
   * typed (e.g. `context7`), but the IDE's MCP registry keys servers
   * with the prefixed form (e.g. `user-context7`). Forwarding the short
   * alias verbatim makes the IDE answer
   * `Server "context7" not found` even though the channel is healthy.
   *
   * Computed once here (`computeMcpIdeRegistryKey`) at parse time, then
   * read by `resolveMountedMcpServer` at dispatch time. Empty string
   * means "no usable key" (caller falls back to `providerIdentifier`).
   *
   * NOTE: when Cursor fixes the wire-level mismatch (i.e. ships a
   * `McpToolDefinition.provider_identifier` that already equals the IDE
   * registry key), this field will simply collapse onto
   * `providerIdentifier` and the resolver becomes an identity function.
   */
  ideRegistryKey: string
}

/**
 * Compute the canonical IDE-side MCP server registry key for a given
 * tool definition. See `McpToolDef.ideRegistryKey` for background.
 *
 * Derivation (in order):
 *   1. If `name` ends with `-${toolName}`, the prefix is the IDE
 *      registry key (e.g. `user-context7-resolve-library-id` minus
 *      `-resolve-library-id` → `user-context7`).
 *   2. Otherwise fall back to `providerIdentifier`. This handles tool
 *      definitions that arrived without a composed `name` (some
 *      protocol variants only carry `toolName` + `providerIdentifier`),
 *      and the future-proof case where Cursor stops mangling the
 *      wire-level identifier.
 *   3. If neither yields a non-empty value, return `""`. Callers must
 *      treat that as "no candidate" and fall through.
 */
export function computeMcpIdeRegistryKey(input: {
  name?: string | null
  toolName?: string | null
  providerIdentifier?: string | null
}): string {
  const name = (input.name || "").trim()
  const toolName = (input.toolName || "").trim()
  const provider = (input.providerIdentifier || "").trim()

  if (name && toolName) {
    const suffix = `-${toolName}`
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return name.slice(0, name.length - suffix.length)
    }
  }
  return provider
}

// Cursor 协议中附加的图片数据（从 SelectedImage 解析）
export interface AttachedImage {
  /** Base64 encoded image data */
  data: string
  /** MIME type, e.g. "image/png" */
  mimeType: string
  /** Optional dimensions */
  width?: number
  height?: number
}

/**
 * A concrete blob body carried by a Cursor AgentRunRequest. These bodies are
 * persisted only after the transport has bound them to a conversation id.
 */
export interface CursorInboundBlobPayload {
  id: Uint8Array
  payload: Uint8Array
  kind: "pre_fetched" | "selected_image"
}

/**
 * Durable identity of the inbound frame that carried a parsed request. The
 * payload itself remains exclusively in CursorWireStore; graph metadata may
 * retain this locator when a derived transcript fact needs auditability.
 */
export interface CursorWireFrameRef {
  streamEpoch: string
  seq: number
  direction: "inbound" | "outbound"
  frameKind: string
}

// 已解析的请求结构。
export interface ParsedCursorRequest {
  /**
   * Bridge execution ownership for a chat entry. It is intentionally absent
   * on protocol-control and tool-result frames; `handleChatMessage` rejects a
   * chat entry without an explicit value instead of guessing from text.
   */
  chatTurnExecutionIntent?: ChatTurnExecutionIntent

  /**
   * How authoritative this frame is for refreshing session-level request
   * configuration. Full AgentRunRequest user turns may replace request-scoped
   * fields; partial ConversationAction and control/reattach frames must not
   * clear existing model parameters, rules, or tool capabilities.
   */
  sessionUpdateScope?: "full" | "partial" | "control"

  /**
   * Authoritative Cursor protocol envelope. It retains raw frame bytes,
   * unknown protobuf fields, typed AgentRunRequest/ConversationState and the
   * full ordered state/history records.
   */
  cursorWire?: CursorRequestWireState

  /** Assigned by the transport only after the raw inbound frame is durable. */
  cursorWireFrameRef?: CursorWireFrameRef

  /** Ordered generic history from UserMessageAction.conversation_history. */
  cursorConversationHistory?: CursorConversationEntry[]

  /**
   * Official terminal records carried alongside a new user turn or cancel.
   * Each item retains its typed protobuf value and exact inbound wire bytes.
   */
  interruptedPendingToolCallResolutions?: CursorInterruptedPendingToolCallResolutionsWire

  /**
   * Bridge-originated continuations never reconstruct a text conversation.
   * They either append one explicit typed current-user fragment or continue
   * from the already durable graph without appending anything.
   */
  syntheticGraphInput?:
    | {
        kind: "current_user"
        content: ContentBlock[]
        metadata?: Record<string, unknown>
        /** Terminal background sub-agent notifications claimed by this row. */
        subagentTerminalDeliveries?: SubagentTerminalDeliveryCommit[]
        /** Terminal background shell notifications claimed by this row. */
        backgroundShellTerminalDeliveries?: BackgroundShellCompletionIdentity[]
      }
    | {
        kind: "control_notification"
        content: ContentBlock[]
        isMeta: boolean
        executionPolicy: "resume_active_task" | "terminal_reconciliation"
        metadata: Record<string, unknown>
        /** Terminal background sub-agent notifications claimed by this row. */
        subagentTerminalDeliveries?: SubagentTerminalDeliveryCommit[]
        /** Terminal background shell notifications claimed by this row. */
        backgroundShellTerminalDeliveries?: BackgroundShellCompletionIdentity[]
        /** Durable queued-interaction resolution claimed by this row. */
        asyncUserInteractionContinuationClaim?: {
          toolCallId: string
          resolutionFingerprint: string
        }
      }
    | {
        kind: "continue_existing_graph"
      }

  /**
   * The user action carries a blob reference for its primary input. The
   * parser preserves this fact before a conversation-scoped blob store can
   * be bound; it is not an in-memory cache hint.
   */
  hasBlobReferencedUserInput?: boolean

  // 新消息
  newMessage: string

  // 模型信息
  model: string
  thinkingLevel: CursorThinkingLevel
  thinkingDetailsRequested?: boolean

  /**
   * Per-subagent model selection captured from
   * `AgentRunRequest.subagent_model_overrides`. Refreshed on every
   * AgentRun (Cursor sends the full table per turn). Consumers:
   *   - `ToolUseSummaryService` (helper LLM call for the per-tool-batch
   *     label) — looks up the synthetic `_tool_use_summary` slot.
   *   - `executeSubAgentTask` / `spawnBackgroundSubAgent` — looks up
   *     the real Cursor subagent_type the model named in `task` args.
   *
   * Defaults to an empty map (no overrides) for `EXEC` / control
   * messages and for older clients that don't emit field 20.
   */
  subagentModelOverrides?: SubagentModelOverridesMap

  /**
   * Exact invocation-level model allow-list from
   * `AgentRunRequest.selected_subagent_models`. An empty catalog means the
   * task tool must omit `model` and inherit through Cursor's normal
   * per-subagent selection policy.
   */
  selectedSubagentModels?: SelectedSubagentModelCatalog

  // 模式和能力
  unifiedMode: "CHAT" | "AGENT" | "EDIT" | "CUSTOM"
  isAgentic: boolean

  // 上下文
  supportedTools: string[]
  useWeb: boolean

  // 会话跟踪
  conversationId?: string
  bubbleId?: string

  /**
   * BiDi attachment that delivered this frame. Assigned by the transport
   * boundary after parsing; it is required for stream-scoped exec control
   * correlation and is never inferred from a "latest" controller.
   */
  cursorStreamEpoch?: string

  /**
   * The protocol-authoritative workspace declaration. Its WorkspaceScope is
   * the only parser-owned root authority; no downstream consumer may rebuild
   * it from projectContext, git metadata, or prior-resume URIs.
   */
  workspaceDeclaration?: ParsedWorkspaceDeclaration

  /**
   * Non-authoritative local references carried by conversation resume state.
   * They intentionally never create or extend workspaceDeclaration.
   */
  resumeWorkspaceReferences?: readonly ParsedResumeWorkspaceReference[]

  /** Exact read-only files registered by Cursor conversation state. */
  cursorManagedReadResources?: readonly CursorManagedReadResource[]

  // 项目上下文（仅为旧下游派生的 presentation，不承担 workspace authority）
  projectContext?: {
    rootPath: string
    directories: string[]
    files: string[]
    workspaceFolders: Array<{
      uri: string
      path: string
      name: string
    }>
  }

  // 附加代码块
  codeChunks?: Array<{
    path: string
    content: string
    startLine?: number
    endLine?: number
  }>

  // Cursor 规则（保留协议原始结构，避免在解析阶段丢失元数据）
  cursorRules?: CursorRule[]
  skillOptions?: SkillOptions
  selectedCursorRulePaths?: string[]
  selectedCursorRuleNames?: string[]

  // Cursor Commands (/ 命令 — 用户定义的可复用工作流)
  cursorCommands?: Array<{ name: string; content: string }>

  // 自定义 system prompt（来自 AgentRunRequest.customSystemPrompt）
  customSystemPrompt?: string

  // 协议中的 token 预算（用于严格跟随 Cursor 参数）
  contextTokenLimit?: number
  contextTokenLimitSource?: ContextTokenLimitSource
  contextMaxMode?: boolean
  usedContextTokens?: number
  requestedMaxOutputTokens?: number
  requestedModelParameters?: Record<string, string>

  /** Agent-runtime hook steps selected from RequestContext.hooks_config. */
  hookConfiguredSteps?: readonly CursorAgentHookStep[]
  /** SessionStart hook context carried by Cursor's RequestContext. */
  hooksAdditionalContext?: string
  /** Durable goal restored from ConversationStateStructure.goal_state. */
  goalState?: BridgeGoalState
  /** ConversationStateStructure.is_root_project_conversation when present. */
  isRootProjectConversation?: boolean

  /** Exact optional response-comparison request identity from UserMessage. */
  bestOfNGroupId?: string
  tryUseBestOfNPromotion?: boolean

  // 显式上下文
  explicitContext?: string

  // RequestContext.env 中的运行时目录/环境元数据
  requestContextEnv?: {
    terminalsFolder?: string
    projectFolder?: string
    shell?: string
    timeZone?: string
    agentTranscriptsFolder?: string
    artifactsFolder?: string
  }

  // 附加图片（从 selectedContext.selectedImages 解析）
  attachedImages?: AttachedImage[]

  // 客户端 Tool 结果
  toolResults?: ParsedToolResult[]

  // Agent 控制消息
  isAgentControlMessage?: boolean
  agentControlType?:
    | "heartbeat"
    | "streamClose"
    | "execHeartbeat"
    | "execStreamClose"
    | "execThrow"
    | "cancelAction"
    | "prewarm"
    | "attachOnly"
    | "unknownConversationAction"
    // ConversationAction 补齐
    | "summarizeAction"
    | "shellCommandAction"
    | "startPlanAction"
    | "executePlanAction"
    | "asyncAskQuestionCompletionAction"
    | "cancelSubagentAction"
    | "backgroundTaskCompletionAction"
    | "backgroundShellAction"
    | "backgroundSubagentAction"
    | "goalContinuationAction"
    | "injectContextAction"
    | "other"
  agentControlExecId?: number
  agentControlError?: string
  agentControlStackTrace?: string
  // ConversationAction 补齐：额外字段
  agentControlSubagentId?: string
  agentControlToolCallId?: string
  agentControlShellCommand?: { command: string; execId: string }
  agentControlTriggeringAuthId?: string
  agentControlTriggeringUserId?: number
  // ConversationAction.asyncAskQuestionCompletionAction 详细 payload。
  // 当 IDE 用户回答了一个 run_async=true 的 ask_question 后，这里
  // 携带原始问题（用于在历史中渲染）和用户答复（结构化的 oneof）。
  agentControlAsyncAskCompletion?: {
    originalToolCallId: string
    originalQuestionText?: string
    originalArgs?: {
      title: string
      questions: Array<{
        id: string
        prompt: string
        options: Array<{ id: string; label: string }>
        allowMultiple: boolean
      }>
      runAsync: boolean
      asyncOriginalToolCallId: string
    }
    resultCase: "success" | "rejected" | "error" | "async" | "unknown"
    answers?: Array<{
      questionId: string
      selectedOptionIds: string[]
      freeformText?: string
    }>
    rejectedReason?: string
    errorMessage?: string
  }
  agentControlBackgroundTaskCompletions?: Array<{
    taskId: string
    kind?: number
    status?: number
    title?: string
    detail?: string
    outputPath?: string
    threadId?: string
    reason?: number
    /** Official BackgroundTaskCompletion.subagent_id. */
    subagentId?: string
    /** Official BackgroundTaskCompletion.tool_call_id. */
    toolCallId?: string
    /** Official BackgroundTaskCompletion.notification_context. */
    notificationContext?: number
  }>
  /** Official ConversationAction.inject_context_action payload. */
  agentControlContextInjection?: {
    injectionId: string
    expectedRunId: string
    kind: "userContext" | "systemContext" | "unknown"
    producer?: string
    systemContent?: string
    userMessageText?: string
  }
  /** Official ConversationAction.request_context_parts. */
  requestContextParts?: {
    rulesBlobId?: Uint8Array
    rulesByteLength?: number
    skillsBlobId?: Uint8Array
    skillsByteLength?: number
    subagentsBlobId?: Uint8Array
    subagentsByteLength?: number
    mcpsBlobId?: Uint8Array
    mcpsByteLength?: number
    dynamicContext?: {
      sendMessageEnabled?: boolean
      adminCommandDenylist?: string[]
    }
  }

  // InteractionQuery 响应（客户端回复服务器查询）
  interactionResponse?: {
    id: number
    resultCase: string
    approved: boolean
    rawResponse: InteractionResponse
  }

  // ConversationAction.resume_action
  isResumeAction?: boolean
  /** Resume is a stream reattachment signal, never a request to replay work. */
  resumeMode?: "reattach"

  // MCP 工具定义（从 Cursor 协议 McpToolDefinition 解析，含完整 input_schema）
  mcpToolDefs?: McpToolDef[]
}

/**
 * Agent 模式 ExecClientMessage 中 oneof 的字段名映射
 *
 * @gen/agent/v1_pb 把 protobuf 的 snake_case 字段名转成 camelCase
 * 暴露给 TypeScript（`shell_result` → `shellResult`），但下游
 * `cursor-connect-stream.service.ts` 在分支决策里用的是 protobuf 原始
 * snake_case 名称（例如 `resultCase === "shell_stream"`）。这个 map
 * 把 oneof case 的 camelCase 还原回 snake_case 标签，保持下游分支
 * 与 proto 字段一一对应。
 *
 * 当 cursor 协议新增 ExecClientMessage 的 oneof case 时，需要在这里
 * 同步加一项（即使 bridge 自己永远不会主动触发该工具的执行流，
 * 客户端 IDE 仍可能主动发起这些 precheck/diagnostics 请求）。
 */
const EXEC_RESULT_CASE_MAP: Record<string, string> = {
  shellResult: "shell_result",
  writeResult: "write_result",
  deleteResult: "delete_result",
  grepResult: "grep_result",
  readResult: "read_result",
  lsResult: "ls_result",
  diagnosticsResult: "diagnostics_result",
  requestContextResult: "request_context_result",
  mcpResult: "mcp_result",
  shellStream: "shell_stream",
  backgroundShellSpawnResult: "background_shell_spawn_result",
  listMcpResourcesExecResult: "list_mcp_resources_exec_result",
  readMcpResourceExecResult: "read_mcp_resource_exec_result",
  fetchResult: "fetch_result",
  recordScreenResult: "record_screen_result",
  computerUseResult: "computer_use_result",
  writeShellStdinResult: "write_shell_stdin_result",
  executeHookResult: "execute_hook_result",
  // ExecClientMessage 补齐
  subagentResult: "subagent_result",
  redactedReadResult: "redacted_read_result",
  forceBackgroundShellResult: "force_background_shell_result",
  forceBackgroundSubagentResult: "force_background_subagent_result",
  mcpStateExecResult: "mcp_state_exec_result",
  subagentAwaitResult: "subagent_await_result",
  // 与最新 cursor agent.v1 ExecClientMessage 对齐：客户端在 IDE 端做
  // smart-mode 分类、canvas diagnostics、shell/mcp/web_fetch 准入
  // 检查（allowlist precheck）后会通过 BiDi 上行带这五种结果。
  // bridge 自身不发起这些工具，但仍需识别字段，避免下游把 camelCase
  // 字符串当作未知 case 走兜底路径而丢失上下文。
  smartModeClassifierResult: "smart_mode_classifier_result",
  canvasDiagnosticsResult: "canvas_diagnostics_result",
  shellAllowlistPrecheckResult: "shell_allowlist_precheck_result",
  mcpAllowlistPrecheckResult: "mcp_allowlist_precheck_result",
  webFetchAllowlistPrecheckResult: "web_fetch_allowlist_precheck_result",
  gitDiffResponse: "git_diff_response",
  piReadResult: "pi_read_result",
  piBashResult: "pi_bash_result",
  piEditResult: "pi_edit_result",
  piWriteResult: "pi_write_result",
  piGrepResult: "pi_grep_result",
  piFindResult: "pi_find_result",
  piLsResult: "pi_ls_result",
  conversationSearchResult: "conversation_search_result",
}

export type ParsedBackgroundTaskCompletion = NonNullable<
  ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
>[number]

/**
 * Cursor emits progress and terminal updates through the same background-task
 * completion action. A progress frame must never claim a pending terminal
 * delivery, even when a client also populates a status field.
 */
export function isTerminalBackgroundTaskCompletion(
  completion: ParsedBackgroundTaskCompletion
): boolean {
  if (completion.reason === BackgroundTaskCompletionReason.TASK_PROGRESS) {
    return false
  }
  return (
    completion.reason === BackgroundTaskCompletionReason.TASK_FINISHED ||
    completion.status === BackgroundTaskStatus.SUCCESS ||
    completion.status === BackgroundTaskStatus.ERROR ||
    completion.status === BackgroundTaskStatus.ABORTED
  )
}

type ParsedAsyncAskCompletion = NonNullable<
  ParsedCursorRequest["agentControlAsyncAskCompletion"]
>

export function normalizeBackgroundTaskCompletions(
  raw: unknown
): ParsedBackgroundTaskCompletion[] {
  if (!Array.isArray(raw)) return []

  const maybeNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined
  const maybeString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined

  const completions: ParsedBackgroundTaskCompletion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const taskId = maybeString(record.taskId)
    if (!taskId) continue
    completions.push({
      taskId,
      kind: maybeNumber(record.kind),
      status: maybeNumber(record.status),
      title: maybeString(record.title),
      detail: maybeString(record.detail),
      outputPath: maybeString(record.outputPath),
      threadId: maybeString(record.threadId),
      reason: maybeNumber(record.reason),
      subagentId: maybeString(record.subagentId),
      toolCallId: maybeString(record.toolCallId),
      notificationContext: maybeNumber(record.notificationContext),
    })
  }
  return completions
}

function summarizeBackgroundTaskCompletionsForLog(
  completions: ParsedBackgroundTaskCompletion[]
): string {
  const rendered = completions
    .map((completion) => {
      const fields = [
        `taskId=${completion.taskId}`,
        completion.kind !== undefined ? `kind=${completion.kind}` : "",
        completion.status !== undefined ? `status=${completion.status}` : "",
        completion.reason !== undefined ? `reason=${completion.reason}` : "",
        completion.title ? `title=${completion.title}` : "",
        completion.detail ? `detail=${completion.detail}` : "",
        completion.outputPath ? `outputPath=${completion.outputPath}` : "",
        completion.threadId ? `threadId=${completion.threadId}` : "",
        completion.subagentId ? `subagentId=${completion.subagentId}` : "",
        completion.toolCallId ? `toolCallId=${completion.toolCallId}` : "",
      ].filter(Boolean)
      return `{${fields.join(", ")}}`
    })
    .join("; ")
  return rendered.length > 800 ? `${rendered.slice(0, 800)}…` : rendered
}

export function normalizeAsyncAskQuestionCompletionAction(
  raw: unknown
): ParsedAsyncAskCompletion | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const asyncAction = raw as {
    originalToolCallId?: string
    originalArgs?: {
      questions?: Array<{
        id?: string
        prompt?: string
        question?: string
        text?: string
        options?: Array<{ id?: string; label?: string }>
        allowMultiple?: boolean
      }>
      title?: string
      runAsync?: boolean
      asyncOriginalToolCallId?: string
    }
    result?: {
      result?: {
        case?: string
        value?: unknown
      }
    }
  }

  const originalQuestionText = (() => {
    const args = asyncAction.originalArgs
    if (!args) return undefined
    const parts: string[] = []
    if (args.title) parts.push(args.title)
    if (Array.isArray(args.questions)) {
      for (const q of args.questions) {
        const text = q.prompt || q.question || q.text || ""
        if (text) parts.push(text)
      }
    }
    const joined = parts.join(" / ").trim()
    return joined || undefined
  })()

  const innerResult = asyncAction.result?.result
  const innerCase = innerResult?.case
  let resultCase: ParsedAsyncAskCompletion["resultCase"] = "unknown"
  let answers: ParsedAsyncAskCompletion["answers"]
  let rejectedReason: string | undefined
  let errorMessage: string | undefined

  if (innerCase === "success") {
    resultCase = "success"
    const successValue = innerResult?.value as
      | {
          answers?: Array<{
            questionId?: string
            selectedOptionIds?: string[]
            freeformText?: string
          }>
        }
      | undefined
    if (Array.isArray(successValue?.answers)) {
      answers = successValue.answers.map((a) => ({
        questionId: a?.questionId || "",
        selectedOptionIds: Array.isArray(a?.selectedOptionIds)
          ? a.selectedOptionIds.filter(
              (id): id is string => typeof id === "string"
            )
          : [],
        freeformText:
          typeof a?.freeformText === "string" && a.freeformText.length > 0
            ? a.freeformText
            : undefined,
      }))
    }
  } else if (innerCase === "rejected") {
    resultCase = "rejected"
    const rejectedValue = innerResult?.value as { reason?: string } | undefined
    rejectedReason =
      typeof rejectedValue?.reason === "string"
        ? rejectedValue.reason
        : undefined
  } else if (innerCase === "error") {
    resultCase = "error"
    const errorValue = innerResult?.value as
      | { errorMessage?: string }
      | undefined
    errorMessage =
      typeof errorValue?.errorMessage === "string"
        ? errorValue.errorMessage
        : undefined
  } else if (innerCase === "async") {
    resultCase = "async"
  }

  return {
    originalToolCallId: asyncAction.originalToolCallId || "",
    originalQuestionText,
    originalArgs: asyncAction.originalArgs
      ? {
          title: asyncAction.originalArgs.title || "",
          questions: Array.isArray(asyncAction.originalArgs.questions)
            ? asyncAction.originalArgs.questions.map((question, index) => ({
                id: question.id || `q${index + 1}`,
                prompt:
                  question.prompt ||
                  question.question ||
                  question.text ||
                  `Question ${index + 1}`,
                options: Array.isArray(question.options)
                  ? question.options.map((option, optionIndex) => ({
                      id: option.id || `opt_${index + 1}_${optionIndex + 1}`,
                      label: option.label || option.id || "",
                    }))
                  : [],
                allowMultiple: question.allowMultiple === true,
              }))
            : [],
          runAsync: asyncAction.originalArgs.runAsync === true,
          asyncOriginalToolCallId:
            asyncAction.originalArgs.asyncOriginalToolCallId || "",
        }
      : undefined,
    resultCase,
    answers,
    rejectedReason,
    errorMessage,
  }
}

/**
 * 创建空控制消息的辅助函数
 */
type ParsedAgentControlType = NonNullable<
  ParsedCursorRequest["agentControlType"]
>

function makeControlMessage(
  agentControlType: ParsedAgentControlType,
  options?: {
    conversationId?: string
    model?: string
    execId?: number
    error?: string
    stackTrace?: string
    subagentId?: string
    toolCallId?: string
    shellCommand?: { command: string; execId: string }
    triggeringAuthId?: string
    triggeringUserId?: number
    asyncAskCompletion?: ParsedCursorRequest["agentControlAsyncAskCompletion"]
    backgroundTaskCompletions?: ParsedCursorRequest["agentControlBackgroundTaskCompletions"]
    contextInjection?: ParsedCursorRequest["agentControlContextInjection"]
    requestContextParts?: ParsedCursorRequest["requestContextParts"]
  }
): ParsedCursorRequest {
  return {
    sessionUpdateScope: "control",
    newMessage: "",
    model: options?.model || "",
    thinkingLevel: 0,
    unifiedMode: "AGENT",
    isAgentic: true,
    supportedTools: [],
    useWeb: false,
    conversationId: options?.conversationId,
    isAgentControlMessage: true,
    agentControlType,
    agentControlExecId: options?.execId,
    agentControlError: options?.error,
    agentControlStackTrace: options?.stackTrace,
    agentControlSubagentId: options?.subagentId,
    agentControlToolCallId: options?.toolCallId,
    agentControlShellCommand: options?.shellCommand,
    agentControlTriggeringAuthId: options?.triggeringAuthId,
    agentControlTriggeringUserId: options?.triggeringUserId,
    agentControlAsyncAskCompletion: options?.asyncAskCompletion,
    agentControlBackgroundTaskCompletions: options?.backgroundTaskCompletions,
    agentControlContextInjection: options?.contextInjection,
    requestContextParts: options?.requestContextParts,
  }
}

function normalizeRequestContextParts(
  parts: ConversationAction["requestContextParts"] | undefined
): ParsedCursorRequest["requestContextParts"] | undefined {
  if (!parts) return undefined
  return {
    rulesBlobId: parts.rulesBlobId?.length
      ? new Uint8Array(parts.rulesBlobId)
      : undefined,
    rulesByteLength: parts.rulesByteLength || undefined,
    skillsBlobId: parts.skillsBlobId?.length
      ? new Uint8Array(parts.skillsBlobId)
      : undefined,
    skillsByteLength: parts.skillsByteLength || undefined,
    subagentsBlobId: parts.subagentsBlobId?.length
      ? new Uint8Array(parts.subagentsBlobId)
      : undefined,
    subagentsByteLength: parts.subagentsByteLength || undefined,
    mcpsBlobId: parts.mcpsBlobId?.length
      ? new Uint8Array(parts.mcpsBlobId)
      : undefined,
    mcpsByteLength: parts.mcpsByteLength || undefined,
    dynamicContext: parts.dynamicContext
      ? {
          sendMessageEnabled: parts.dynamicContext.sendMessageEnabled,
          adminCommandDenylist: [...parts.dynamicContext.adminCommandDenylist],
        }
      : undefined,
  }
}

function normalizeInjectContextAction(
  value: unknown
): NonNullable<ParsedCursorRequest["agentControlContextInjection"]> {
  const action = (value || {}) as {
    injectionId?: string
    expectedRunId?: string
    payload?: {
      case?: string
      value?: {
        producer?: string
        content?: string
        userMessage?: { text?: string }
      }
    }
  }
  const payloadCase = action.payload?.case
  if (payloadCase === "systemContext") {
    return {
      injectionId: action.injectionId || "",
      expectedRunId: action.expectedRunId || "",
      kind: "systemContext",
      producer: action.payload?.value?.producer || undefined,
      systemContent: action.payload?.value?.content || undefined,
    }
  }
  if (payloadCase === "userContext") {
    return {
      injectionId: action.injectionId || "",
      expectedRunId: action.expectedRunId || "",
      kind: "userContext",
      userMessageText: action.payload?.value?.userMessage?.text || undefined,
    }
  }
  return {
    injectionId: action.injectionId || "",
    expectedRunId: action.expectedRunId || "",
    kind: "unknown",
  }
}

export class CursorRequestParser {
  private readonly logger = new Logger(CursorRequestParser.name)

  private extractUserMessagePrompt(
    userMsg: UserMessage | undefined,
    resolver?: CursorProtocolReferenceResolver
  ): string {
    if (!userMsg) return ""

    if (userMsg.text.length > 0) {
      return userMsg.text
    }
    if (!userMsg.textBlobId?.length || !resolver) return ""

    const blob = resolver.resolveBlob(userMsg.textBlobId)
    if (!blob) return ""
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(blob)
    } catch {
      // The graph projector owns the authoritative error with placement and
      // frame context. This convenience field must never reinterpret a blob
      // as JSON or rich text merely to manufacture a prompt.
      return ""
    }
  }

  private extractAttachedImagesFromUserMessage(
    userMsg: UserMessage | undefined,
    resolver?: CursorProtocolReferenceResolver
  ): AttachedImage[] {
    const attachedImages: AttachedImage[] = []
    if (!userMsg?.selectedContext?.selectedImages?.length) {
      return attachedImages
    }

    for (const img of userMsg.selectedContext.selectedImages) {
      const mimeType = img.mimeType || "image/png"
      let base64Data: string | undefined

      switch (img.dataOrBlobId.case) {
        case "data":
          base64Data = Buffer.from(img.dataOrBlobId.value).toString("base64")
          break
        case "blobIdWithData": {
          base64Data = Buffer.from(img.dataOrBlobId.value.data).toString(
            "base64"
          )
          break
        }
        case "blobId": {
          const blobId = cursorBlobIdToKey(img.dataOrBlobId.value)
          const blob = resolver?.resolveBlob(img.dataOrBlobId.value)
          base64Data = blob ? Buffer.from(blob).toString("base64") : undefined
          if (!base64Data) {
            this.logger.error(
              `Image blob not found for selected image (uuid=${img.uuid}, blobId=${blobId})`
            )
          }
          break
        }
      }

      if (base64Data) {
        attachedImages.push({
          data: base64Data,
          mimeType,
          width: img.dimension?.width,
          height: img.dimension?.height,
        })
      }
    }

    if (attachedImages.length > 0) {
      this.logger.log(
        `Extracted ${attachedImages.length} image(s) from selectedContext (total ${attachedImages.reduce((sum, img) => sum + img.data.length, 0)} base64 chars)`
      )
    }

    return attachedImages
  }

  private hasBlobReferencedUserInput(userMsg?: UserMessage): boolean {
    if (!userMsg) return false
    if (
      (userMsg.textBlobId && userMsg.textBlobId.length > 0) ||
      (userMsg.richTextBlobId && userMsg.richTextBlobId.length > 0)
    ) {
      return true
    }
    return Boolean(
      userMsg.selectedContext?.selectedImages.some(
        (image) => image.dataOrBlobId.case === "blobId"
      )
    )
  }

  /**
   * Convert a protobuf google.protobuf.Value to plain JS value.
   */
  private protoValueToJs(value: unknown): unknown {
    if (!value || typeof value !== "object") return value
    const v = value as { kind?: { case?: string; value?: unknown } }
    if (!v.kind || !v.kind.case) return undefined
    switch (v.kind.case) {
      case "nullValue":
        return null
      case "numberValue":
        return v.kind.value
      case "stringValue":
        return v.kind.value
      case "boolValue":
        return v.kind.value
      case "structValue": {
        const struct = v.kind.value as { fields?: Record<string, unknown> }
        if (!struct?.fields) return {}
        const out: Record<string, unknown> = {}
        for (const [key, fieldValue] of Object.entries(struct.fields)) {
          out[key] = this.protoValueToJs(fieldValue)
        }
        return out
      }
      case "listValue": {
        const list = v.kind.value as { values?: unknown[] }
        if (!list?.values) return []
        return list.values.map((item) => this.protoValueToJs(item))
      }
      default:
        return undefined
    }
  }

  private normalizeModelParameterId(id: string): string {
    return id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
  }

  private parsePositiveInteger(raw: string): number | undefined {
    const match = raw.trim().match(/-?\d+/)
    if (!match?.[0]) return undefined

    const parsed = Number.parseInt(match[0], 10)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined
    return parsed
  }

  /**
   * Agent v1 token details are protobuf uint32 fields. Keep their wire domain
   * exact at the parser boundary: malformed runtime input must reject the
   * request rather than be rounded, clamped, or persisted differently.
   */
  private requireCursorUint32(value: unknown, label: string): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > CURSOR_UINT32_MAX
    ) {
      throw new Error(`${label} must be an exact uint32`)
    }
    return value
  }

  private extractRequestedModelParameters(
    parameters: RequestedModel_ModelParameterValue[]
  ): Record<string, string> | undefined {
    if (!parameters.length) return undefined

    const result: Record<string, string> = {}
    for (const parameter of parameters) {
      if (!parameter.id) continue
      const normalizedId = this.normalizeModelParameterId(parameter.id)
      if (!normalizedId) continue
      result[normalizedId] = parameter.value || ""
    }

    return Object.keys(result).length > 0 ? result : undefined
  }

  private mergeRequestedModelParameters(
    variantParameters?: Record<string, string>,
    explicitParameters?: Record<string, string>
  ): Record<string, string> | undefined {
    if (!variantParameters && !explicitParameters) {
      return undefined
    }

    return {
      ...(variantParameters || {}),
      ...(explicitParameters || {}),
    }
  }

  private resolveCursorRequestedModel(
    requestedModelId?: string,
    modelDetailsModelId?: string,
    fallbackModel?: string
  ): {
    model: string
    requestedVariantSelection: ReturnType<
      typeof parseCursorVariantString
    > | null
    requestedBaseModel?: string
    modelDetailsVariantSelection: ReturnType<
      typeof parseCursorVariantString
    > | null
    modelDetailsBaseModel?: string
  } {
    const trimmedRequestedModelId = requestedModelId?.trim() || undefined
    const requestedVariantSelection = trimmedRequestedModelId
      ? parseCursorVariantString(trimmedRequestedModelId)
      : null
    const requestedBaseModel = trimmedRequestedModelId
      ? parseModelRequest(trimmedRequestedModelId).baseModel
      : undefined
    const trimmedModelDetailsModelId = modelDetailsModelId?.trim() || undefined
    const modelDetailsVariantSelection = trimmedModelDetailsModelId
      ? parseCursorVariantString(trimmedModelDetailsModelId)
      : null
    const modelDetailsBaseModel = trimmedModelDetailsModelId
      ? parseModelRequest(trimmedModelDetailsModelId).baseModel
      : undefined

    return {
      model:
        requestedVariantSelection?.baseModel ||
        requestedBaseModel ||
        modelDetailsVariantSelection?.baseModel ||
        modelDetailsBaseModel ||
        trimmedModelDetailsModelId ||
        fallbackModel ||
        "claude-sonnet-4-20250514",
      requestedVariantSelection,
      requestedBaseModel,
      modelDetailsVariantSelection,
      modelDetailsBaseModel,
    }
  }

  private resolveRequestedThinkingLevel(
    requestedModelParameters?: Record<string, string>
  ): 0 | 1 | 2 | undefined {
    if (!requestedModelParameters) {
      return undefined
    }

    const exactIds = [
      "thinking",
      "reasoning",
      "reasoning_effort",
      "thinking_effort",
      "effort_mode",
      "cloud_agent_effort_mode",
      "prompt_effort_level",
      "effort",
    ]

    const candidateValues: string[] = []
    for (const id of exactIds) {
      const value = requestedModelParameters[id]
      if (typeof value === "string" && value.trim().length > 0) {
        candidateValues.push(value)
      }
    }

    for (const [id, rawValue] of Object.entries(requestedModelParameters)) {
      const looksLikeReasoningControl =
        id.includes("reason") ||
        id.includes("think") ||
        (id.includes("effort") && !id.includes("discovery"))
      if (!looksLikeReasoningControl) {
        continue
      }
      if (typeof rawValue === "string" && rawValue.trim().length > 0) {
        candidateValues.push(rawValue)
      }
    }

    for (const rawValue of candidateValues) {
      const normalized = normalizeRequestedThinkingEffort(rawValue)
      switch (normalized) {
        case "none":
          return 0
        case "minimal":
        case "low":
        case "medium":
        case "auto":
        case "high":
          return 1
        case "max":
        case "ultra":
        case "xhigh":
          return 2
        default:
          break
      }
    }

    return undefined
  }

  private extractNumericModelParameter(
    parameters: RequestedModel_ModelParameterValue[],
    predicate: (normalizedId: string) => boolean
  ): number | undefined {
    for (const parameter of parameters) {
      if (!parameter.id) continue
      const normalizedId = this.normalizeModelParameterId(parameter.id)
      if (!predicate(normalizedId)) continue

      const parsed = this.parsePositiveInteger(parameter.value || "")
      if (parsed !== undefined) return parsed
    }
    return undefined
  }

  private extractRequestedMaxOutputTokens(
    parameters: RequestedModel_ModelParameterValue[]
  ): number | undefined {
    const exactIds = new Set([
      "max_tokens",
      "max_output_tokens",
      "desired_max_tokens",
      "max_completion_tokens",
      "output_max_tokens",
      "max_new_tokens",
    ])

    const exact = this.extractNumericModelParameter(parameters, (id) =>
      exactIds.has(id)
    )
    if (exact !== undefined) return exact

    return this.extractNumericModelParameter(parameters, (id) => {
      if (!id.includes("token")) return false
      if (id.includes("context")) return false
      return (
        id.includes("max") ||
        id.includes("desired") ||
        id.includes("output") ||
        id.includes("completion")
      )
    })
  }

  private extractRequestedContextTokenLimit(
    parameters: RequestedModel_ModelParameterValue[]
  ): number | undefined {
    const exactIds = new Set([
      "max_context_tokens",
      "context_token_limit",
      "context_window",
      "context_window_size",
      "max_input_tokens",
    ])

    const exact = this.extractNumericModelParameter(parameters, (id) =>
      exactIds.has(id)
    )
    if (exact !== undefined) return exact

    return this.extractNumericModelParameter(parameters, (id) => {
      if (!id.includes("context")) return false
      return (
        id.includes("token") || id.includes("window") || id.includes("limit")
      )
    })
  }

  /**
   * Return only concrete blob bodies carried by this request. References are
   * deliberately not resolved here: the connection layer is the first place
   * that knows the authoritative Cursor conversation id.
   */
  getInboundBlobPayloads(
    parsed: ParsedCursorRequest
  ): CursorInboundBlobPayload[] {
    const runRequest = parsed.cursorWire?.agentRunRequest
    if (!runRequest) return []

    const blobs: CursorInboundBlobPayload[] = runRequest.preFetchedBlobs.map(
      (blob) => ({
        id: Uint8Array.from(blob.id),
        payload: Uint8Array.from(blob.value),
        kind: "pre_fetched",
      })
    )
    const userMessage = getEffectiveCursorUserMessageAction(
      runRequest.action?.action
    )?.userMessage
    for (const image of userMessage?.selectedContext?.selectedImages || []) {
      if (image.dataOrBlobId.case !== "blobIdWithData") continue
      blobs.push({
        id: Uint8Array.from(image.dataOrBlobId.value.blobId),
        payload: Uint8Array.from(image.dataOrBlobId.value.data),
        kind: "selected_image",
      })
    }
    return blobs
  }

  /**
   * Re-project a parsed frame after the connection has durably bound its
   * opaque blob references to one Cursor conversation. No process-global KV
   * lookup is permitted on this path.
   */
  resolveConversationReferences(
    parsed: ParsedCursorRequest,
    resolver: CursorProtocolReferenceResolver
  ): ParsedCursorRequest {
    const frame = parsed.cursorWire?.frame
    if (!frame) return parsed

    const cursorWire = createCursorRequestWireState(frame, resolver)
    const resolved: ParsedCursorRequest = {
      ...parsed,
      cursorWire,
      cursorConversationHistory: cursorWire.userMessageActionHistory,
    }
    const runUserAction = getEffectiveCursorUserMessageAction(
      cursorWire.agentRunRequest?.action?.action
    )
    const conversationAction = cursorWire.clientMessage.message
    const conversationUserAction =
      conversationAction.case === "conversationAction"
        ? getEffectiveCursorUserMessageAction(conversationAction.value.action)
        : undefined
    const userMessage =
      runUserAction?.userMessage ?? conversationUserAction?.userMessage
    if (!userMessage || parsed.isAgentControlMessage || parsed.isResumeAction) {
      return resolved
    }

    const prompt = this.extractUserMessagePrompt(userMessage, resolver)
    const attachedImages = this.extractAttachedImagesFromUserMessage(
      userMessage,
      resolver
    )

    return {
      ...resolved,
      newMessage: prompt,
      attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
    }
  }

  /**
   * 从 raw buffer 解析 Cursor 请求
   * 使用 @bufbuild/protobuf 的 fromBinary 替代手写 varint 解析
   */
  parseRequest(
    buffer: Buffer,
    traceScope?: {
      readonly conversationId?: string
      readonly streamEpoch?: string
    }
  ): ParsedCursorRequest | null {
    this.logger.debug(
      `parseRequest: buffer length=${buffer.length}, first 20 bytes: ${buffer.subarray(0, 20).toString("hex")}`
    )

    try {
      const frame = decodeCursorAgentClientFrame(buffer)
      const msg = frame.message
      CursorProtocolTraceService.recordClientMessage(msg, {
        bytes: frame.protobufBytes.length,
        compressedBytes:
          frame.compression === "gzip" ? frame.receivedBytes.length : undefined,
        context: "parseRequest",
        conversationId: traceScope?.conversationId,
        streamEpoch: traceScope?.streamEpoch,
      })
      const result = this.parseAgentClientMessage(msg, frame)
      if (result) {
        this.logger.log(
          `解析成功: case=${msg.message.case}, mode=${result.unifiedMode}`
        )
        return result
      }
    } catch (error) {
      if (
        error instanceof CursorInterruptedPendingToolCallResolutionCodecError
      ) {
        throw error
      }
      this.logger.debug(
        `AgentClientMessage 解析失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.logger.warn("无法解析请求")
    return null
  }

  /**
   * Attach the raw protocol-owned envelope. Blob references remain unresolved
   * until the connection has bound the frame to a conversation-scoped durable
   * store.
   */
  private parseAgentClientMessage(
    msg: AgentClientMessage,
    frame: CursorAgentClientFrame
  ): ParsedCursorRequest | null {
    const parsed = this.parseAgentClientMessageBody(msg)
    if (!parsed) return null

    const cursorWire = createCursorRequestWireState(frame)
    const exactExecResultBytes = cursorWire.execClientMessageBytes
    const interruptedPendingToolCallResolutions =
      extractCursorInterruptedPendingToolCallResolutions(frame)
    return {
      ...parsed,
      toolResults:
        exactExecResultBytes && parsed.toolResults?.length
          ? parsed.toolResults.map((toolResult) => ({
              ...toolResult,
              // The ExecClientMessage payload is protocol data. Keep the
              // exact nested bytes from the frame instead of replacing them
              // with a convenience re-encoding.
              resultData: Buffer.from(exactExecResultBytes),
            }))
          : parsed.toolResults,
      cursorWire,
      cursorConversationHistory: cursorWire.userMessageActionHistory,
      interruptedPendingToolCallResolutions,
    }
  }

  /** 从已解析的 AgentClientMessage 提取便利字段。 */
  private parseAgentClientMessageBody(
    msg: AgentClientMessage
  ): ParsedCursorRequest | null {
    const { message } = msg

    switch (message.case) {
      case "runRequest":
        return this.parseRunRequest(message.value)

      case "execClientMessage":
        return this.parseExecClientMessage(message.value)

      case "clientHeartbeat":
        this.logger.debug("收到心跳消息")
        return makeControlMessage("heartbeat")

      case "execClientControlMessage":
        this.logger.debug("收到 execClientControlMessage")
        return this.parseExecClientControlMessage(message.value)

      case "conversationAction": {
        const triggeringUserInfo = message.value.triggeringUserInfo
        const triggeringFields: {
          triggeringAuthId?: string
          triggeringUserId?: number
        } = {}
        const triggeringAuthId =
          triggeringUserInfo?.authId || message.value.triggeringAuthId || ""
        if (triggeringAuthId) {
          triggeringFields.triggeringAuthId = triggeringAuthId
        }
        if (triggeringUserInfo?.userId !== undefined) {
          triggeringFields.triggeringUserId = triggeringUserInfo.userId
        }
        if (
          triggeringFields.triggeringAuthId ||
          triggeringFields.triggeringUserId !== undefined
        ) {
          this.logger.debug(
            `收到 conversationAction.triggeringUserInfo authId=${triggeringFields.triggeringAuthId || "(none)"} userId=${triggeringFields.triggeringUserId ?? "(none)"}`
          )
        }

        const effectiveUserAction = getEffectiveCursorUserMessageAction(
          message.value.action
        )
        if (effectiveUserAction) {
          this.logger.log(
            `收到 conversationAction.${message.value.action.case}`
          )
          return this.parseConversationUserMessageAction(
            effectiveUserAction,
            triggeringFields
          )
        }
        if (message.value.action.case === "subscriptionNotificationAction") {
          this.logger.warn(
            "收到无 notifications 的 conversationAction.subscriptionNotificationAction"
          )
          return null
        }

        if (message.value.action.case === "resumeAction") {
          this.logger.log("收到 conversationAction.resumeAction")
          return this.parseConversationResumeAction(message.value.action.value)
        }

        if (message.value.action.case === "cancelAction") {
          const reason = (message.value.action.value.reason || "").trim()
          this.logger.warn(
            `收到 conversationAction.cancelAction reason=${reason || "(empty)"}`
          )
          return makeControlMessage("cancelAction", {
            ...triggeringFields,
            error: reason,
          })
        }

        // ConversationAction 补齐：逐一识别并路由
        if (message.value.action.case === "summarizeAction") {
          this.logger.log("收到 conversationAction.summarizeAction")
          return makeControlMessage("summarizeAction", triggeringFields)
        }
        if (message.value.action.case === "shellCommandAction") {
          const shellAction = message.value.action.value as {
            shellCommand?: { command?: string }
            execId?: string
          }
          const command = shellAction.shellCommand?.command || ""
          const execId = shellAction.execId || ""
          this.logger.log(
            `收到 conversationAction.shellCommandAction command="${command.substring(0, 80)}" execId=${execId}`
          )
          return makeControlMessage("shellCommandAction", {
            ...triggeringFields,
            shellCommand: { command, execId },
          })
        }
        if (message.value.action.case === "startPlanAction") {
          this.logger.log("收到 conversationAction.startPlanAction")
          return makeControlMessage("startPlanAction", triggeringFields)
        }
        if (message.value.action.case === "executePlanAction") {
          this.logger.log("收到 conversationAction.executePlanAction")
          return makeControlMessage("executePlanAction", triggeringFields)
        }
        if (message.value.action.case === "asyncAskQuestionCompletionAction") {
          const completion = normalizeAsyncAskQuestionCompletionAction(
            message.value.action.value
          )

          this.logger.log(
            `收到 conversationAction.asyncAskQuestionCompletionAction toolCallId=${completion?.originalToolCallId || "(none)"} case=${completion?.resultCase || "unknown"} answers=${completion?.answers?.length ?? 0}`
          )
          return makeControlMessage("asyncAskQuestionCompletionAction", {
            ...triggeringFields,
            toolCallId: completion?.originalToolCallId || "",
            asyncAskCompletion: completion,
          })
        }
        if (message.value.action.case === "cancelSubagentAction") {
          const cancelSub = message.value.action.value as {
            subagentId?: string
          }
          this.logger.log(
            `收到 conversationAction.cancelSubagentAction subagentId=${cancelSub.subagentId || "(none)"}`
          )
          return makeControlMessage("cancelSubagentAction", {
            ...triggeringFields,
            subagentId: cancelSub.subagentId || "",
          })
        }
        if (message.value.action.case === "backgroundTaskCompletionAction") {
          const bgTask = message.value.action.value as {
            completions?: unknown
          }
          const completions = normalizeBackgroundTaskCompletions(
            bgTask.completions
          )
          this.logger.log(
            `收到 conversationAction.backgroundTaskCompletionAction completions=${completions.length}${completions.length ? ` ${summarizeBackgroundTaskCompletionsForLog(completions)}` : ""}`
          )
          return makeControlMessage("backgroundTaskCompletionAction", {
            ...triggeringFields,
            backgroundTaskCompletions: completions,
          })
        }
        if (message.value.action.case === "backgroundShellAction") {
          const bgShell = message.value.action.value as {
            toolCallId?: string
          }
          this.logger.log(
            `收到 conversationAction.backgroundShellAction toolCallId=${bgShell.toolCallId || "(none)"}`
          )
          return makeControlMessage("backgroundShellAction", {
            ...triggeringFields,
            toolCallId: bgShell.toolCallId || "",
          })
        }
        if (message.value.action.case === "backgroundSubagentAction") {
          const bgSub = message.value.action.value as {
            toolCallId?: string
          }
          this.logger.log(
            `收到 conversationAction.backgroundSubagentAction toolCallId=${bgSub.toolCallId || "(none)"}`
          )
          return makeControlMessage("backgroundSubagentAction", {
            ...triggeringFields,
            toolCallId: bgSub.toolCallId || "",
          })
        }
        if (message.value.action.case === "goalContinuationAction") {
          this.logger.log("收到 conversationAction.goalContinuationAction")
          return makeControlMessage("goalContinuationAction", {
            ...triggeringFields,
            requestContextParts: normalizeRequestContextParts(
              message.value.requestContextParts
            ),
          })
        }
        if (message.value.action.case === "injectContextAction") {
          const injection = normalizeInjectContextAction(
            message.value.action.value
          )
          this.logger.log(
            `收到 conversationAction.injectContextAction injectionId=${injection.injectionId || "(none)"} kind=${injection.kind}`
          )
          return makeControlMessage("injectContextAction", {
            ...triggeringFields,
            contextInjection: injection,
            requestContextParts: normalizeRequestContextParts(
              message.value.requestContextParts
            ),
          })
        }

        this.logger.debug(
          `收到 conversationAction（未识别） action=${message.value.action.case || "(none)"}`
        )
        return makeControlMessage("unknownConversationAction", {
          ...triggeringFields,
          requestContextParts: normalizeRequestContextParts(
            message.value.requestContextParts
          ),
        })
      }

      case "kvClientMessage":
        this.logger.debug("收到 kvClientMessage")
        return makeControlMessage("other")

      case "interactionResponse": {
        const resp = message.value
        this.logger.log(
          `收到 interactionResponse id=${resp.id} case=${resp.result.case}`
        )
        // 统一提取嵌套 result oneof，兼容:
        // - XxxRequestResponse.result.{approved|rejected}
        // - AskQuestionInteractionResponse.result.result.{success|error|rejected|async}
        // - CreatePlanRequestResponse.result.result.{success|error}
        // - SetupVmEnvironmentResult.result.{success}
        let approved = false
        if (resp.result.case && resp.result.value) {
          const responseCase = resp.result.case
          // Use Record<string, unknown> instead of `any` for safe nested oneOf probing.
          // Each InteractionResponse variant has its own nested `result` oneOf structure:
          // - Level 1: value.result.case (e.g. SetupVmEnvironmentResult.result.{success})
          // - Level 2: value.result.result.case (e.g. AskQuestionInteractionResponse.result.result.{success|async})
          const value = resp.result.value as Record<string, unknown>
          const resultField = value?.result as
            | { case?: string; value?: Record<string, unknown> }
            | undefined
          const level1Case =
            typeof resultField?.case === "string" ? resultField.case : undefined
          const nestedResult =
            (resultField?.value?.result as { case?: string } | undefined) ||
            ((resultField as { result?: { case?: string } } | undefined)
              ?.result as { case?: string } | undefined)
          const level2Case =
            typeof nestedResult?.case === "string"
              ? nestedResult.case
              : undefined
          const effectiveCase = level2Case || level1Case

          if (responseCase === "setupVmEnvironmentResult") {
            approved = effectiveCase === "success"
          } else if (responseCase === "askQuestionInteractionResponse") {
            approved = effectiveCase === "success" || effectiveCase === "async"
          } else if (responseCase === "createPlanRequestResponse") {
            approved = effectiveCase === "success"
          } else {
            approved =
              effectiveCase === "approved" ||
              effectiveCase === "success" ||
              effectiveCase === "async" ||
              effectiveCase === undefined
          }
        }
        return {
          newMessage: "",
          model: "",
          thinkingLevel: 0,
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools: [],
          useWeb: false,
          isAgentControlMessage: false,
          interactionResponse: {
            id: resp.id,
            resultCase: resp.result.case || "unknown",
            approved,
            rawResponse: resp,
          },
        }
      }

      case "prewarmRequest": {
        const prewarm = (msg.message.value || {}) as {
          requestedModel?: { modelId?: string }
          modelDetails?: { modelId?: string }
          conversationId?: string
          bestOfNGroupId?: string
          tryUseBestOfNPromotion?: boolean
        }
        const requestedModelId =
          prewarm.requestedModel?.modelId?.trim() || undefined
        const modelDetailsModelId =
          prewarm.modelDetails?.modelId?.trim() || undefined
        const { model } = this.resolveCursorRequestedModel(
          requestedModelId,
          modelDetailsModelId,
          prewarm.modelDetails?.modelId
        )
        this.logger.debug(
          `收到 prewarmRequest conversation=${prewarm.conversationId || "(none)"} model=${model || "(empty)"}`
        )
        return {
          ...makeControlMessage("prewarm", {
            conversationId: prewarm.conversationId || undefined,
            model,
          }),
          bestOfNGroupId: prewarm.bestOfNGroupId,
          tryUseBestOfNPromotion: prewarm.tryUseBestOfNPromotion,
        }
      }

      case undefined:
        this.logger.debug("AgentClientMessage.message 未设置")
        return null

      default:
        this.logger.debug(`未知的 message case`)
        return makeControlMessage("other")
    }
  }

  private parseExecClientControlMessage(
    msg: ExecClientControlMessage
  ): ParsedCursorRequest {
    switch (msg.message.case) {
      case "heartbeat": {
        const execId = msg.message.value.id
        this.logger.debug(
          `收到 execClientControlMessage.heartbeat id=${execId}`
        )
        return makeControlMessage("execHeartbeat", { execId })
      }
      case "streamClose": {
        const execId = msg.message.value.id
        this.logger.debug(
          `收到 execClientControlMessage.streamClose id=${execId}`
        )
        return makeControlMessage("execStreamClose", { execId })
      }
      case "throw": {
        const execId = msg.message.value.id
        const error = msg.message.value.error || ""
        const stackTrace = msg.message.value.stackTrace || ""
        this.logger.warn(
          `收到 execClientControlMessage.throw id=${execId}, error=${error || "(empty)"}`
        )
        return makeControlMessage("execThrow", {
          execId,
          error,
          stackTrace,
        })
      }
      case undefined:
      default:
        this.logger.debug("execClientControlMessage.message 未设置")
        return makeControlMessage("other")
    }
  }

  /**
   * Resolve every parser entry through the same protocol authority boundary.
   * The derived projectContext remains presentation-only; all root authority
   * stays on workspaceDeclaration.scope.
   */
  private parseWorkspaceContext(
    requestContext: WorkspaceFolderExtractionInput | undefined,
    conversationState?: ConversationStateWorkspaceInput
  ): Pick<
    ParsedCursorRequest,
    | "workspaceDeclaration"
    | "resumeWorkspaceReferences"
    | "cursorManagedReadResources"
    | "projectContext"
  > {
    const workspaceState = parseCursorWorkspaceState(
      requestContext,
      conversationState
    )
    const declaration = workspaceState.declaration
    return {
      ...(declaration
        ? {
            workspaceDeclaration: declaration,
            projectContext: deriveProjectContextPresentation(declaration),
          }
        : {}),
      ...(workspaceState.resumeReferences.length > 0
        ? { resumeWorkspaceReferences: workspaceState.resumeReferences }
        : {}),
      ...(workspaceState.managedReadResources !== undefined
        ? { cursorManagedReadResources: workspaceState.managedReadResources }
        : {}),
    }
  }

  /**
   * RequestContext environment folders are filesystem paths, not display
   * labels. Keep their exact bytes so a valid whitespace-bearing directory
   * is not rewritten before downstream workspace admission. Shell and time
   * zone remain textual metadata and retain their existing normalization.
   */
  private parseRequestContextEnv(
    env:
      | {
          terminalsFolder?: string
          projectFolder?: string
          shell?: string
          timeZone?: string
          agentTranscriptsFolder?: string
          artifactsFolder?: string
        }
      | undefined
  ): ParsedCursorRequest["requestContextEnv"] {
    if (!env) return undefined
    const pathValue = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 && !value.includes("\u0000")
        ? value
        : undefined
    const textValue = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
    return {
      terminalsFolder: pathValue(env.terminalsFolder),
      projectFolder: pathValue(env.projectFolder),
      shell: textValue(env.shell),
      timeZone: textValue(env.timeZone),
      agentTranscriptsFolder: pathValue(env.agentTranscriptsFolder),
      artifactsFolder: pathValue(env.artifactsFolder),
    }
  }

  private parseConversationUserMessageAction(
    action: UserMessageAction,
    triggeringFields?: {
      triggeringAuthId?: string
      triggeringUserId?: number
    }
  ): ParsedCursorRequest | null {
    void triggeringFields

    const prompt = this.extractUserMessagePrompt(action.userMessage)
    const attachedImages = this.extractAttachedImagesFromUserMessage(
      action.userMessage
    )
    const hasBlobReferencedUserInput = this.hasBlobReferencedUserInput(
      action.userMessage
    )

    if (
      !prompt.trim() &&
      attachedImages.length === 0 &&
      !hasBlobReferencedUserInput
    ) {
      if (action.interruptedPendingToolCallResolutions) {
        // A resolution-only user action is protocol control, not an empty
        // upstream model turn. Its raw envelope is attached after parsing.
        return makeControlMessage("other", triggeringFields)
      }
      this.logger.debug("conversationAction.userMessageAction 中无有效 prompt")
      return null
    }

    const requestContext = action.requestContext
    const workspaceContext = this.parseWorkspaceContext(requestContext)

    const builtInToolCapabilityOptions = {
      webSearchEnabled: requestContext?.webSearchEnabled,
      webFetchEnabled: requestContext?.webFetchEnabled,
      readLintsEnabled: requestContext?.readLintsEnabled,
    }
    const supportedTools = getDefaultAgentToolNames(
      builtInToolCapabilityOptions
    )
    if (requestContext?.searchConversationsEnabled === true) {
      supportedTools.push("search_conversations")
    }
    const useWeb =
      requestContext?.webSearchEnabled === true ||
      requestContext?.webFetchEnabled === true

    this.logger.log(
      `conversationAction.userMessageAction: prompt="${prompt.substring(0, 100)}...", ` +
        `workspace=${workspaceContext.projectContext?.rootPath || "(none)"} folders=${workspaceContext.projectContext?.workspaceFolders.length || 0}, tools=${supportedTools.length}, useWeb=${useWeb}`
    )

    return {
      chatTurnExecutionIntent: "new_top_level",
      sessionUpdateScope: "partial",
      newMessage: prompt,
      model: "",
      thinkingLevel: 0,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools,
      useWeb,
      ...workspaceContext,
      hookConfiguredSteps: selectCursorAgentHookSteps(
        requestContext?.hooksConfig?.configuredSteps
      ),
      hooksAdditionalContext: requestContext?.hooksAdditionalContext,
      bestOfNGroupId: action.userMessage?.bestOfNGroupId,
      tryUseBestOfNPromotion: action.userMessage?.tryUseBestOfNPromotion,
      requestContextEnv: this.parseRequestContextEnv(requestContext?.env),
      attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
      hasBlobReferencedUserInput,
    }
  }

  private parseConversationResumeAction(
    action: ResumeAction
  ): ParsedCursorRequest {
    const requestContext = action.requestContext
    const workspaceContext = this.parseWorkspaceContext(requestContext)
    const builtInToolCapabilityOptions = {
      webSearchEnabled: requestContext?.webSearchEnabled,
      webFetchEnabled: requestContext?.webFetchEnabled,
      readLintsEnabled: requestContext?.readLintsEnabled,
    }
    const supportedTools = getDefaultAgentToolNames(
      builtInToolCapabilityOptions
    )
    if (requestContext?.searchConversationsEnabled === true) {
      supportedTools.push("search_conversations")
    }
    const useWeb =
      requestContext?.webSearchEnabled === true ||
      requestContext?.webFetchEnabled === true

    return {
      sessionUpdateScope: "control",
      newMessage: "",
      model: "",
      thinkingLevel: 0,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools,
      useWeb,
      ...workspaceContext,
      hookConfiguredSteps: selectCursorAgentHookSteps(
        requestContext?.hooksConfig?.configuredSteps
      ),
      hooksAdditionalContext: requestContext?.hooksAdditionalContext,
      requestContextEnv: this.parseRequestContextEnv(requestContext?.env),
      isResumeAction: true,
      resumeMode: "reattach",
    }
  }

  /**
   * 解析 AgentRunRequest → 提取 prompt、model、conversationId
   */
  private parseRunRequest(req: AgentRunRequest): ParsedCursorRequest | null {
    // 提取 prompt
    let prompt = ""
    const action = req.action
    const actionCase = action?.action.case
    const effectiveUserAction = getEffectiveCursorUserMessageAction(
      action?.action
    )
    let requestContext:
      | import("../../../gen/agent/v1_pb").RequestContext
      | undefined
    let userMessage: UserMessage | undefined
    // Blob payloads and references are intentionally not resolved here. This
    // parser has no conversation ownership; the connection binds them to the
    // durable conversation store before the typed graph projector consumes
    // them.

    // 附加图片
    const attachedImages: AttachedImage[] = []
    let hasBlobReferencedUserInput = false

    if (effectiveUserAction) {
      const userMsg: UserMessage | undefined = effectiveUserAction.userMessage
      userMessage = userMsg
      if (userMsg) {
        prompt = this.extractUserMessagePrompt(userMsg)
        attachedImages.push(
          ...this.extractAttachedImagesFromUserMessage(userMsg)
        )
        hasBlobReferencedUserInput = this.hasBlobReferencedUserInput(userMsg)
      }
      // 提取 requestContext（包含 workspace、rules 等信息）
      requestContext = effectiveUserAction.requestContext
    } else if (action && actionCase === "resumeAction") {
      // Resume turns may not contain a new prompt, but still carry requestContext.
      requestContext = action.action.value.requestContext
    }

    const requestedModelId = req.requestedModel?.modelId?.trim() || undefined
    const modelDetailsModelId = req.modelDetails?.modelId?.trim() || undefined
    const {
      model,
      requestedVariantSelection,
      requestedBaseModel,
      modelDetailsVariantSelection,
      modelDetailsBaseModel,
    } = this.resolveCursorRequestedModel(
      requestedModelId,
      modelDetailsModelId,
      req.modelDetails?.modelId
    )

    // Per-subagent model selection (Cursor settings UI: Subagents → Explore /
    // Plan / ... → "Inherit from parent" | "Disable" | <model>). The proto
    // ships the full table on every AgentRunRequest so we re-parse here and
    // hand it to SessionRecord (refreshed-per-turn semantics, mirroring how we
    // refresh `model` / `thinkingLevel`). Empty result means "no overrides
    // declared" — every consumer treats that as inherit-from-parent.
    const subagentModelOverrides = parseSubagentModelOverrides(req)
    const selectedSubagentModels = parseSelectedSubagentModels(req)
    if (!subagentModelOverrides.isEmpty()) {
      this.logger.debug(
        `AgentRunRequest subagent_model_overrides: ${subagentModelOverrides
          .keys()
          .map((subagentType) => {
            const decision = subagentModelOverrides.lookup(subagentType)!
            switch (decision.kind) {
              case "inherit":
                return `${subagentType}=inherit`
              case "disabled":
                return `${subagentType}=disabled`
              case "model":
                return `${subagentType}=${decision.modelId}${decision.maxMode ? "[max]" : ""}`
              default:
                return subagentType
            }
          })
          .join(", ")}`
      )
    }
    if (!selectedSubagentModels.isEmpty()) {
      this.logger.debug(
        `AgentRunRequest selected_subagent_models: ${selectedSubagentModels
          .ids()
          .join(", ")}`
      )
    }

    // 提取 conversationId
    const conversationId = req.conversationId
      ? requireExactDurableIdentifier(
          req.conversationId,
          "AgentRunRequest conversationId"
        )
      : undefined

    // 提取 workspace 路径（从 repositoryInfo 或 conversationState）
    // DEBUG: dump requestContext 关键字段
    if (requestContext) {
      this.logger.debug(
        `[DEBUG] requestContext fields: ` +
          `repositoryInfo=${requestContext.repositoryInfo?.length || 0}, ` +
          `gitRepos=${requestContext.gitRepos?.length || 0}, ` +
          `projectLayouts=${requestContext.projectLayouts?.length || 0}, ` +
          `tools=${requestContext.tools?.length || 0}, ` +
          `customSubagents=${requestContext.customSubagents?.length || 0}, ` +
          `rules=${requestContext.rules?.length || 0}, ` +
          `webSearchEnabled=${requestContext.webSearchEnabled}, ` +
          `webFetchEnabled=${requestContext.webFetchEnabled}`
      )
      if (requestContext.repositoryInfo?.length) {
        for (const repo of requestContext.repositoryInfo) {
          this.logger.debug(
            `[DEBUG] repo: workspaceUri="${repo.workspaceUri}", repoName="${repo.repoName}", isLocal=${repo.isLocal}`
          )
        }
      }
      if (requestContext.gitRepos?.length) {
        for (const git of requestContext.gitRepos) {
          this.logger.debug(
            `[DEBUG] gitRepo: ${safeJsonStringify(git, {
              maxDepth: 4,
              maxArrayItems: 20,
              maxObjectKeys: 50,
              maxStringLength: 2 * 1024,
            }).substring(0, 200)}`
          )
        }
      }
      // DEBUG: dump 每条 rule 的关键信息，排查用户自定义规则是否被发送
      if (requestContext.rules?.length) {
        for (let i = 0; i < requestContext.rules.length; i++) {
          const r = requestContext.rules[i]!
          const typeCase = r.type?.type.case || "(none)"
          const contentPreview = (r.content || "")
            .substring(0, 80)
            .replace(/\n/g, "\\n")
          this.logger.debug(
            `[DEBUG] rule[${i}]: type=${typeCase}, source=${r.source}, ` +
              `path="${r.fullPath || ""}", content="${contentPreview}..."`
          )
        }
      }
    } else {
      this.logger.debug("[DEBUG] requestContext is undefined")
    }
    // DEBUG: dump selectedContext.cursorRules
    if (effectiveUserAction) {
      const _userMsg = effectiveUserAction.userMessage
      const _selRules = _userMsg?.selectedContext?.cursorRules
      this.logger.debug(
        `[DEBUG] selectedContext.cursorRules: ${_selRules?.length ?? "undefined"} item(s)`
      )
      if (_selRules?.length) {
        for (let i = 0; i < _selRules.length; i++) {
          const sr = _selRules[i]!
          const r = sr.rule
          if (r) {
            const contentPreview = (r.content || "")
              .substring(0, 80)
              .replace(/\n/g, "\\n")
            this.logger.debug(
              `[DEBUG] selectedCursorRule[${i}]: type=${r.type?.type.case || "(none)"}, ` +
                `source=${r.source}, path="${r.fullPath || ""}", content="${contentPreview}..."`
            )
          } else {
            this.logger.debug(
              `[DEBUG] selectedCursorRule[${i}]: rule is undefined`
            )
          }
        }
      }
    }
    if (req.conversationState) {
      this.logger.debug(
        `[DEBUG] conversationState: previousWorkspaceUris=${safeJsonStringify(
          req.conversationState.previousWorkspaceUris,
          {
            maxDepth: 3,
            maxArrayItems: 50,
            maxObjectKeys: 50,
            maxStringLength: 2 * 1024,
          }
        )}`
      )
      if (req.conversationState.tokenDetails) {
        this.logger.debug(
          `[DEBUG] conversationState.tokenDetails: used=${req.conversationState.tokenDetails.usedTokens}, max=${req.conversationState.tokenDetails.maxTokens}`
        )
      }
    }
    // The direct Agent v1 workspace declaration is parsed once here. Prior
    // workspace URIs remain resume references and never become root authority.
    const workspaceContext = this.parseWorkspaceContext(
      requestContext,
      req.conversationState
    )

    // 提取 Cursor Rules
    // 规则来自两个来源：
    //   1. requestContext.rules — 工作区级别的 rules（Cursor skills、项目 .cursor/rules 等）
    //   2. userMsg.selectedContext.cursorRules — 用户手动创建的全局 rules（如 "Always Apply" 类型）
    // 两者合并后去重（按 fullPath），确保用户自定义规则不会丢失。
    //
    // 过滤 Cursor 根据系统 locale 自动注入的语言 rule（如 "Always respond in Chinese-simplified"）。
    // 这类 rule 由客户端在每次启动时写入 aicontext.personalContext，
    // 与用户自定义的 rule 叠加而非覆盖，导致删除后重启又出现。
    // 当用户已有自定义 rule 时，这条自动 rule 是多余的，直接过滤即可。
    const AUTO_LANG_RULE_PATTERN = /^Always respond in [A-Za-z-]+$/i

    // 收集 requestContext.rules
    const contextRules = requestContext?.rules ? [...requestContext.rules] : []
    const selectedCursorRulePaths = new Set<string>()
    const selectedCursorRuleNames = new Set<string>()

    // 收集 selectedContext.cursorRules（SelectedCursorRule 包装了 CursorRule）
    if (effectiveUserAction) {
      const userMsg = effectiveUserAction.userMessage
      const selectedRules = userMsg?.selectedContext?.cursorRules
      if (selectedRules && selectedRules.length > 0) {
        // 用 fullPath 集合去重，避免同一条规则重复注入
        const existingPaths = new Set(
          contextRules.map((r) => r.fullPath).filter(Boolean)
        )
        for (const selected of selectedRules) {
          if (selected.rule) {
            if (selected.rule.fullPath) {
              selectedCursorRulePaths.add(
                normalizePathForMatch(selected.rule.fullPath)
              )
            }
            const selectedSkill = getCursorSkillMetadata(selected.rule)
            if (selectedSkill?.name) {
              selectedCursorRuleNames.add(
                normalizeSkillName(selectedSkill.name)
              )
            }
            if (
              !selected.rule.fullPath ||
              !existingPaths.has(selected.rule.fullPath)
            ) {
              contextRules.push(selected.rule)
              if (selected.rule.fullPath) {
                existingPaths.add(selected.rule.fullPath)
              }
            }
          }
        }
        this.logger.log(
          `Merged ${selectedRules.length} rule(s) from selectedContext.cursorRules ` +
            `(total after merge: ${contextRules.length})`
        )
      }
    }

    // 过滤自动注入的语言 rule；同时去掉客户端传来的 karpathy 副本，因为 bridge
    // 会无条件注入自己的内置版本（见下），避免同一份准则在 prompt 里重复出现。
    const filteredContextRules =
      contextRules.length > 0
        ? contextRules.filter((rule) => {
            const content = rule.content?.trim() || ""
            if (AUTO_LANG_RULE_PATTERN.test(content)) {
              this.logger.log(
                `Filtered auto-injected locale rule: "${content}"`
              )
              return false
            }
            if (isKarpathyRule(rule.content)) {
              this.logger.log(
                "Suppressed client-supplied karpathy ruleset; bridge injects its own built-in copy"
              )
              return false
            }
            return true
          })
        : []

    // 无条件 prepend bridge 内置的行为/工程准则，使其不再依赖客户端是否
    // 碰巧打开了 ship 这些 rule 的 workspace。合成 CursorRule 复用现有
    // `Cursor Rules:` 渲染管道，因此所有 backend 自动生效，无需逐后端改动。
    //   1. karpathy —— 行为元原则（思考、简单、外科手术式改动、目标驱动）
    //   2. engineering & UI discipline —— 编码与 UI 的具体禁令
    const cursorRules: CursorRule[] = [
      buildBuiltInKarpathyRule(),
      buildBuiltInDisciplineRule(),
      ...filteredContextRules,
    ]
    const skillOptions = mergeSkillOptions(
      req.skillOptions,
      requestContext?.skillOptions
    )
    if (skillOptions?.skillDescriptors.length) {
      this.logger.debug(
        `[DEBUG] SkillOptions.skill_descriptors: ${skillOptions.skillDescriptors.length} item(s)`
      )
    }

    // 提取 Cursor Commands (/ 命令)
    const cursorCommands: Array<{ name: string; content: string }> = []
    if (effectiveUserAction) {
      const userMsg = effectiveUserAction.userMessage
      const cmds = userMsg?.selectedContext?.cursorCommands
      if (cmds && cmds.length > 0) {
        for (const cmd of cmds) {
          if (cmd.name && cmd.content) {
            cursorCommands.push({ name: cmd.name, content: cmd.content })
          }
        }
      }
    }

    // 提取 custom system prompt
    const customSystemPrompt = req.customSystemPrompt || ""

    // 提取协议里的 token 参数（优先使用 Cursor 传值）
    const explicitRequestedModelParameters =
      this.extractRequestedModelParameters(req.requestedModel?.parameters || [])
    const variantRequestedModelParameters = this.mergeRequestedModelParameters(
      modelDetailsVariantSelection?.parameterValues,
      requestedVariantSelection?.parameterValues
    )
    const requestedModelParameters = this.mergeRequestedModelParameters(
      variantRequestedModelParameters,
      explicitRequestedModelParameters
    )
    const modelMaxMode = req.modelDetails?.maxMode === true
    const requestedMaxMode = req.requestedModel?.maxMode === true
    const requestedVariantMaxMode = requestedVariantSelection?.maxMode === true
    const modelDetailsVariantMaxMode =
      modelDetailsVariantSelection?.maxMode === true
    const requestedMaxOutputTokens = this.extractRequestedMaxOutputTokens(
      req.requestedModel?.parameters || []
    )
    const requestedContextTokenLimit = this.extractRequestedContextTokenLimit(
      req.requestedModel?.parameters || []
    )
    const tokenDetails = req.conversationState?.tokenDetails
    const usedContextTokens = tokenDetails
      ? this.requireCursorUint32(
          tokenDetails.usedTokens,
          "conversationState.tokenDetails.usedTokens"
        )
      : undefined
    const rawContextTokenLimit = tokenDetails
      ? this.requireCursorUint32(
          tokenDetails.maxTokens,
          "conversationState.tokenDetails.maxTokens"
        )
      : undefined
    const rawContextTokenLimitFromState =
      rawContextTokenLimit !== undefined && rawContextTokenLimit > 0
        ? rawContextTokenLimit
        : undefined
    const explicitMaxContextMode =
      modelMaxMode ||
      requestedMaxMode ||
      requestedVariantMaxMode ||
      modelDetailsVariantMaxMode
    const contextTokenLimitFromState = requestedContextTokenLimit
      ? undefined
      : rawContextTokenLimitFromState
    const contextTokenLimit =
      requestedContextTokenLimit ||
      (explicitMaxContextMode ? undefined : contextTokenLimitFromState)
    const contextTokenLimitSource: ContextTokenLimitSource | undefined =
      requestedContextTokenLimit
        ? "requested"
        : contextTokenLimitFromState && !explicitMaxContextMode
          ? "conversation_state"
          : undefined

    if (
      contextTokenLimit ||
      requestedMaxOutputTokens ||
      explicitMaxContextMode
    ) {
      this.logger.log(
        `Token budget from protocol: contextLimit=${contextTokenLimit || "(none)"}, ` +
          `usedContext=${usedContextTokens ?? "(none)"}, maxOutput=${requestedMaxOutputTokens || "(none)"}, ` +
          `maxMode=${explicitMaxContextMode}`
      )
    }

    if (req.requestedModel) {
      this.logger.debug(
        `RequestedModel: modelId=${req.requestedModel.modelId || "(empty)"}, ` +
          `isVariant=${req.requestedModel.isVariantStringRepresentation}, ` +
          `parameterCount=${req.requestedModel.parameters.length}, ` +
          `baseModel=${requestedVariantSelection?.baseModel || requestedBaseModel || "(none)"}, ` +
          `derivedParameters=${requestedModelParameters ? safeJsonStringify(requestedModelParameters) : "(none)"}, ` +
          `requestedMaxMode=${req.requestedModel.maxMode}`
      )
    }

    if (modelDetailsModelId) {
      this.logger.debug(
        `ModelDetails: modelId=${modelDetailsModelId}, ` +
          `baseModel=${modelDetailsVariantSelection?.baseModel || modelDetailsBaseModel || "(none)"}, ` +
          `derivedParameters=${modelDetailsVariantSelection?.parameterValues ? safeJsonStringify(modelDetailsVariantSelection.parameterValues) : "(none)"}, ` +
          `modelMaxMode=${req.modelDetails?.maxMode === true}`
      )
    }

    // 提取支持的工具
    // RequestContext.tools / mcp_tools 只承载 MCP 定义；内置 Cursor 工具需要结合
    // capability flags 和 customSubagents[].tools 一起判断，避免把显式工具选择扩回默认全集。
    const builtInToolCapabilityOptions = {
      webSearchEnabled: requestContext?.webSearchEnabled,
      webFetchEnabled: requestContext?.webFetchEnabled,
      readLintsEnabled: requestContext?.readLintsEnabled,
      sendToUserEnabled: req.clientSupportsSendToUser === true,
    }
    const defaultBuiltInTools = getDefaultAgentToolNames(
      builtInToolCapabilityOptions
    )
    const defaultBuiltInToolSet = new Set(defaultBuiltInTools)
    const supportedToolsSet = new Set<string>()

    const appendSupportedToolName = (toolName?: string) => {
      if (!toolName) return
      if (!isCursorBuiltInToolAllowed(toolName, builtInToolCapabilityOptions)) {
        return
      }
      supportedToolsSet.add(toolName)
    }

    const appendDeclaredMcpToolName = (tool: {
      name?: string
      toolName?: string
    }) => {
      if (tool.name) {
        appendSupportedToolName(tool.name)
        return
      }
      if (tool.toolName) {
        appendSupportedToolName(tool.toolName)
      }
    }

    if (requestContext?.tools?.length) {
      for (const tool of requestContext.tools) {
        appendDeclaredMcpToolName(tool)
      }
    }

    // Some payload variants carry MCP declarations in top-level mcp_tools.
    if (req.mcpTools?.mcpTools?.length) {
      for (const tool of req.mcpTools.mcpTools) {
        appendDeclaredMcpToolName(tool)
      }
    }

    if (requestContext?.customSubagents?.length) {
      for (const subagent of requestContext.customSubagents) {
        if (!subagent.tools?.length) continue
        for (const toolName of subagent.tools) {
          appendSupportedToolName(toolName)
        }
      }
    }

    const hasBuiltInCursorTools = Array.from(supportedToolsSet).some((name) =>
      defaultBuiltInToolSet.has(name)
    )
    const hasExplicitCustomSubagentToolSelection =
      requestContext?.customSubagents?.some(
        (subagent) => !!subagent.tools?.length
      ) ?? false

    if (!hasBuiltInCursorTools && !hasExplicitCustomSubagentToolSelection) {
      for (const toolName of defaultBuiltInTools) {
        supportedToolsSet.add(toolName)
      }
    }

    if (requestContext?.searchConversationsEnabled === true) {
      supportedToolsSet.add("search_conversations")
    }

    const supportedTools = Array.from(supportedToolsSet)

    // 提取 MCP 工具完整定义（含 input_schema）
    const mcpToolDefsByName = new Map<string, McpToolDef>()
    const appendMcpToolDef = (tool: {
      name?: string
      toolName?: string
      providerIdentifier?: string
      description?: string
      inputSchema?: unknown
      inputSchemaJson?: string
    }) => {
      const name = tool.name || tool.toolName
      if (!name || mcpToolDefsByName.has(name)) return
      const def: McpToolDef = {
        name,
        toolName: tool.toolName || name,
        providerIdentifier: tool.providerIdentifier || "",
        description: tool.description || "",
        ideRegistryKey: computeMcpIdeRegistryKey({
          name,
          toolName: tool.toolName || name,
          providerIdentifier: tool.providerIdentifier || "",
        }),
      }
      if (tool.inputSchema) {
        try {
          const parsed = this.protoValueToJs(tool.inputSchema)
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            def.inputSchema = parsed as Record<string, unknown>
          }
        } catch {
          // inputSchema 解析失败则跳过
        }
      }
      if (!def.inputSchema && tool.inputSchemaJson?.trim()) {
        try {
          const parsed = JSON.parse(tool.inputSchemaJson) as unknown
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            def.inputSchema = parsed as Record<string, unknown>
          }
        } catch {
          this.logger.warn(`Invalid MCP input_schema_json for ${name}`)
        }
      }
      mcpToolDefsByName.set(name, def)
    }

    // Primary source: RequestContext.tools (Cursor Agent turn payload)
    if (requestContext?.tools?.length) {
      for (const tool of requestContext.tools) {
        appendMcpToolDef(tool)
      }
    }
    // Fallback source: top-level mcp_tools (some protocol variants)
    if (req.mcpTools?.mcpTools?.length) {
      for (const tool of req.mcpTools.mcpTools) {
        appendMcpToolDef(tool)
      }
    }
    const mcpToolDefs = Array.from(mcpToolDefsByName.values())
    if (mcpToolDefs.length > 0) {
      this.logger.log(
        `Extracted ${mcpToolDefs.length} MCP tool definitions: ${mcpToolDefs.map((d) => d.name).join(", ")}`
      )
    }
    const useWeb =
      requestContext?.webSearchEnabled === true ||
      requestContext?.webFetchEnabled === true
    const requestContextEnv = this.parseRequestContextEnv(requestContext?.env)
    const hookConfiguredSteps = selectCursorAgentHookSteps(
      requestContext?.hooksConfig?.configuredSteps
    )
    const hooksAdditionalContext = requestContext?.hooksAdditionalContext
    const goalState = req.conversationState?.goalState
      ? fromProtoGoalState(req.conversationState.goalState)
      : undefined
    const isRootProjectConversation =
      req.conversationState?.isRootProjectConversation

    if (prompt) {
      this.logger.log(
        `AgentRunRequest: prompt="${prompt.substring(0, 100)}...", model=${model}, ` +
          `workspace=${workspaceContext.projectContext?.rootPath || "(none)"}, rules=${cursorRules?.length || 0}, ` +
          `customPrompt=${customSystemPrompt ? customSystemPrompt.length + " chars" : "none"}, ` +
          `tools=${supportedTools.length}, useWeb=${useWeb}`
      )
    }

    // 推导 thinkingLevel
    // - modelDetails.maxMode 或 requestedModel.maxMode → 最大 thinking (level 2)
    // - modelDetails.thinkingDetails 存在（presence）→ thinking 已启用 (level 1)
    // - registry 标记 isThinking 的模型 (e.g. claude-opus-4-7-thinking)
    //   → level 1（契约级，不是猜测：Cursor 暴露这个变体名给用户即承诺
    //   thinking 开启；registry.doesModelSupportThinking 反映这条契约）。
    //
    // 协议字段（thinkingDetails / maxMode / requestedThinkingLevel）始终
    // 优先于 registry 兜底——用户的显式偏好覆盖默认承诺。
    const hasThinkingDetails = !!req.modelDetails?.thinkingDetails
    const requestedThinkingLevel = this.resolveRequestedThinkingLevel(
      requestedModelParameters
    )
    const modelIdForCapability =
      req.modelDetails?.modelId || req.requestedModel?.modelId || ""
    const registryDeclaresThinking = modelIdForCapability
      ? doesModelSupportThinking(modelIdForCapability)
      : false
    let thinkingLevel: CursorThinkingLevel = 0
    if (
      modelMaxMode ||
      requestedMaxMode ||
      requestedVariantMaxMode ||
      modelDetailsVariantMaxMode
    ) {
      thinkingLevel = 2
    } else if (hasThinkingDetails) {
      thinkingLevel = 1
    } else if (requestedThinkingLevel !== undefined) {
      thinkingLevel = requestedThinkingLevel
    } else if (registryDeclaresThinking) {
      thinkingLevel = 1
    }

    // thinkingDetailsRequested 表示客户端希望看到详细的 thinking 内容（不仅是“启用 thinking”）。
    //
    // 之前只看 modelDetails.thinkingDetails，但 Cursor 通过 model variant
    // (例如 gpt-5.5-xhigh-fast → derivedParameters.thinking=extra-high) 显式请求
    // thinking 时不会带 thinkingDetails 字段，导致 thinkingDetails=false。
    //
    // 这里把 variant/参数推导出的 thinking 也视为“显式请求 thinking 详情”：
    // - modelDetails.thinkingDetails 存在
    // - requestedModel/modelDetails 进入 maxMode
    // - 通过 requestedModelParameters 解析出非零 thinking level
    // - registry 契约级别声明 isThinking（如 *-thinking 后缀模型）
    const thinkingDetailsRequested =
      hasThinkingDetails ||
      modelMaxMode ||
      requestedMaxMode ||
      requestedVariantMaxMode ||
      modelDetailsVariantMaxMode ||
      (requestedThinkingLevel !== undefined && requestedThinkingLevel > 0) ||
      registryDeclaresThinking

    if (thinkingLevel > 0) {
      this.logger.log(
        `Thinking enabled: level=${thinkingLevel} (thinkingDetails=${hasThinkingDetails}, ` +
          `thinkingDetailsRequested=${thinkingDetailsRequested}, ` +
          `modelMaxMode=${modelMaxMode}, requestedMaxMode=${requestedMaxMode}, requestedVariantMaxMode=${requestedVariantMaxMode}, modelDetailsVariantMaxMode=${modelDetailsVariantMaxMode}, ` +
          `requestedThinkingLevel=${requestedThinkingLevel ?? 0})`
      )
    }

    const hasUserInput =
      prompt.length > 0 ||
      attachedImages.length > 0 ||
      hasBlobReferencedUserInput

    if (!hasUserInput) {
      if (actionCase === "cancelAction") {
        const reason =
          action?.action.case === "cancelAction"
            ? (action.action.value.reason || "").trim()
            : ""
        this.logger.log(
          `AgentRunRequest cancelAction: conversationId=${conversationId || "(none)"}, reason=${reason || "(empty)"}`
        )
        return makeControlMessage("cancelAction", {
          conversationId,
          error: reason,
        })
      }

      if (actionCase === "resumeAction") {
        this.logger.log(
          `AgentRunRequest resumeAction: conversationId=${conversationId || "(none)"}, pendingToolCalls=${req.conversationState?.pendingToolCalls?.length || 0}`
        )
        return {
          sessionUpdateScope: "control",
          // Resume attaches to the existing graph and must not create a
          // model turn or replay inbound state.
          newMessage: "",
          model,
          thinkingLevel,
          thinkingDetailsRequested,
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools,
          useWeb,
          conversationId,
          ...workspaceContext,
          cursorRules,
          skillOptions,
          selectedCursorRulePaths:
            selectedCursorRulePaths.size > 0
              ? Array.from(selectedCursorRulePaths)
              : undefined,
          selectedCursorRuleNames:
            selectedCursorRuleNames.size > 0
              ? Array.from(selectedCursorRuleNames)
              : undefined,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          contextTokenLimitSource,
          contextMaxMode: explicitMaxContextMode,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          hookConfiguredSteps,
          hooksAdditionalContext,
          goalState,
          isRootProjectConversation,
          requestContextEnv,
          isResumeAction: true,
          resumeMode: "reattach",
          mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
          subagentModelOverrides,
          selectedSubagentModels,
        }
      }

      if (
        actionCase === "userMessageAction" &&
        action?.action.case === "userMessageAction" &&
        action.action.value.interruptedPendingToolCallResolutions
      ) {
        // The IDE can deliver official terminal records on a reconnect with
        // no user text. Do not start an empty model turn; the raw records are
        // retained by parseAgentClientMessage for the control loop.
        return makeControlMessage("other", {
          conversationId,
          model,
        })
      }

      if (action && actionCase && !effectiveUserAction) {
        const controlActionName: string = actionCase
        const control = (() => {
          switch (actionCase) {
            case "summarizeAction":
              this.logger.log(
                `AgentRunRequest summarizeAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("summarizeAction", {
                conversationId,
                model,
              })
            case "shellCommandAction": {
              const shellAction = action.action.value as {
                shellCommand?: { command?: string }
                execId?: string
              }
              const command = shellAction.shellCommand?.command || ""
              const execId = shellAction.execId || ""
              this.logger.log(
                `AgentRunRequest shellCommandAction: conversationId=${conversationId || "(none)"} command="${command.substring(0, 80)}" execId=${execId}`
              )
              return makeControlMessage("shellCommandAction", {
                conversationId,
                model,
                shellCommand: { command, execId },
              })
            }
            case "startPlanAction":
              this.logger.log(
                `AgentRunRequest startPlanAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("startPlanAction", {
                conversationId,
                model,
              })
            case "executePlanAction":
              this.logger.log(
                `AgentRunRequest executePlanAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("executePlanAction", {
                conversationId,
                model,
              })
            case "asyncAskQuestionCompletionAction": {
              const completion = normalizeAsyncAskQuestionCompletionAction(
                action.action.value
              )
              this.logger.log(
                `AgentRunRequest asyncAskQuestionCompletionAction: conversationId=${conversationId || "(none)"} toolCallId=${completion?.originalToolCallId || "(none)"} case=${completion?.resultCase || "unknown"} answers=${completion?.answers?.length ?? 0}`
              )
              return makeControlMessage("asyncAskQuestionCompletionAction", {
                conversationId,
                model,
                toolCallId: completion?.originalToolCallId || "",
                asyncAskCompletion: completion,
              })
            }
            case "cancelSubagentAction": {
              const cancelSub = action.action.value as {
                subagentId?: string
              }
              this.logger.log(
                `AgentRunRequest cancelSubagentAction: conversationId=${conversationId || "(none)"} subagentId=${cancelSub.subagentId || "(none)"}`
              )
              return makeControlMessage("cancelSubagentAction", {
                conversationId,
                model,
                subagentId: cancelSub.subagentId || "",
              })
            }
            case "backgroundTaskCompletionAction": {
              const bgTask = action.action.value as {
                completions?: unknown
              }
              const completions = normalizeBackgroundTaskCompletions(
                bgTask.completions
              )
              this.logger.log(
                `AgentRunRequest backgroundTaskCompletionAction: conversationId=${conversationId || "(none)"} completions=${completions.length}${completions.length ? ` ${summarizeBackgroundTaskCompletionsForLog(completions)}` : ""}`
              )
              return makeControlMessage("backgroundTaskCompletionAction", {
                conversationId,
                model,
                backgroundTaskCompletions: completions,
              })
            }
            case "backgroundShellAction": {
              const bgShell = action.action.value as {
                toolCallId?: string
              }
              this.logger.log(
                `AgentRunRequest backgroundShellAction: conversationId=${conversationId || "(none)"} toolCallId=${bgShell.toolCallId || "(none)"}`
              )
              return makeControlMessage("backgroundShellAction", {
                conversationId,
                model,
                toolCallId: bgShell.toolCallId || "",
              })
            }
            case "backgroundSubagentAction": {
              const bgSub = action.action.value as {
                toolCallId?: string
              }
              this.logger.log(
                `AgentRunRequest backgroundSubagentAction: conversationId=${conversationId || "(none)"} toolCallId=${bgSub.toolCallId || "(none)"}`
              )
              return makeControlMessage("backgroundSubagentAction", {
                conversationId,
                model,
                toolCallId: bgSub.toolCallId || "",
              })
            }
            case "goalContinuationAction":
              this.logger.log(
                `AgentRunRequest goalContinuationAction: conversationId=${conversationId || "(none)"}`
              )
              return makeControlMessage("goalContinuationAction", {
                conversationId,
                model,
                requestContextParts: normalizeRequestContextParts(
                  action.requestContextParts
                ),
              })
            case "injectContextAction": {
              const injection = normalizeInjectContextAction(
                action.action.value
              )
              this.logger.log(
                `AgentRunRequest injectContextAction: conversationId=${conversationId || "(none)"} injectionId=${injection.injectionId || "(none)"} kind=${injection.kind}`
              )
              return makeControlMessage("injectContextAction", {
                conversationId,
                model,
                contextInjection: injection,
                requestContextParts: normalizeRequestContextParts(
                  action.requestContextParts
                ),
              })
            }
            default:
              this.logger.log(
                `AgentRunRequest unknown control action: conversationId=${conversationId || "(none)"} action=${controlActionName || "(none)"}`
              )
              return makeControlMessage("unknownConversationAction", {
                conversationId,
                model,
                requestContextParts: normalizeRequestContextParts(
                  action.requestContextParts
                ),
              })
          }
        })()

        return {
          ...control,
          sessionUpdateScope: "control",
          model: control.model || model,
          thinkingLevel,
          thinkingDetailsRequested,
          supportedTools,
          useWeb,
          conversationId,
          ...workspaceContext,
          cursorRules,
          skillOptions,
          selectedCursorRulePaths:
            selectedCursorRulePaths.size > 0
              ? Array.from(selectedCursorRulePaths)
              : undefined,
          selectedCursorRuleNames:
            selectedCursorRuleNames.size > 0
              ? Array.from(selectedCursorRuleNames)
              : undefined,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          contextTokenLimitSource,
          contextMaxMode: explicitMaxContextMode,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          hookConfiguredSteps,
          hooksAdditionalContext,
          goalState,
          isRootProjectConversation,
          requestContextEnv,
          mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
          subagentModelOverrides,
          selectedSubagentModels,
        }
      }

      if (
        !actionCase &&
        (conversationId ||
          req.conversationState ||
          requestedModelId ||
          modelDetailsModelId)
      ) {
        this.logger.log(
          `AgentRunRequest attach-only: conversationId=${conversationId || "(none)"}, model=${model}, ` +
            `tools=${supportedTools.length}`
        )
        return {
          sessionUpdateScope: "control",
          newMessage: "",
          model,
          thinkingLevel,
          thinkingDetailsRequested,
          unifiedMode: "AGENT",
          isAgentic: true,
          supportedTools,
          useWeb,
          conversationId,
          ...workspaceContext,
          cursorRules,
          skillOptions,
          selectedCursorRulePaths:
            selectedCursorRulePaths.size > 0
              ? Array.from(selectedCursorRulePaths)
              : undefined,
          selectedCursorRuleNames:
            selectedCursorRuleNames.size > 0
              ? Array.from(selectedCursorRuleNames)
              : undefined,
          cursorCommands:
            cursorCommands.length > 0 ? cursorCommands : undefined,
          customSystemPrompt: customSystemPrompt || undefined,
          contextTokenLimit,
          contextTokenLimitSource,
          contextMaxMode: explicitMaxContextMode,
          usedContextTokens,
          requestedMaxOutputTokens,
          requestedModelParameters,
          hookConfiguredSteps,
          hooksAdditionalContext,
          goalState,
          isRootProjectConversation,
          requestContextEnv,
          isAgentControlMessage: true,
          agentControlType: "attachOnly",
          mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
          subagentModelOverrides,
          selectedSubagentModels,
        }
      }

      this.logger.debug("AgentRunRequest 中无有效 prompt")
      return null
    }

    return {
      chatTurnExecutionIntent: "new_top_level",
      sessionUpdateScope: "full",
      newMessage: prompt,
      model,
      thinkingLevel,
      thinkingDetailsRequested,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools,
      useWeb,
      conversationId,
      ...workspaceContext,
      cursorRules,
      skillOptions,
      selectedCursorRulePaths:
        selectedCursorRulePaths.size > 0
          ? Array.from(selectedCursorRulePaths)
          : undefined,
      selectedCursorRuleNames:
        selectedCursorRuleNames.size > 0
          ? Array.from(selectedCursorRuleNames)
          : undefined,
      cursorCommands: cursorCommands.length > 0 ? cursorCommands : undefined,
      customSystemPrompt: customSystemPrompt || undefined,
      contextTokenLimit,
      contextTokenLimitSource,
      contextMaxMode: explicitMaxContextMode,
      usedContextTokens,
      requestedMaxOutputTokens,
      requestedModelParameters,
      hookConfiguredSteps,
      hooksAdditionalContext,
      goalState,
      isRootProjectConversation,
      bestOfNGroupId: userMessage?.bestOfNGroupId,
      tryUseBestOfNPromotion: userMessage?.tryUseBestOfNPromotion,
      requestContextEnv,
      mcpToolDefs: mcpToolDefs.length > 0 ? mcpToolDefs : undefined,
      attachedImages: attachedImages.length > 0 ? attachedImages : undefined,
      hasBlobReferencedUserInput,
      subagentModelOverrides,
      selectedSubagentModels,
    }
  }

  /**
   * 解析 ExecClientMessage → 提取 tool 结果
   * 使用生成的类型直接访问 oneof 字段
   */
  private parseExecClientMessage(
    msg: ExecClientMessage
  ): ParsedCursorRequest | null {
    const execId = msg.execId || ""
    const numericId = msg.id // ExecServerMessage.id ↔ ExecClientMessage.id 配对
    const messageCase = msg.message.case

    if (!messageCase) {
      this.logger.debug("ExecClientMessage.message 未设置")
      return null
    }

    // 将 oneof case 映射为下划线格式的 resultCase
    const resultCase = EXEC_RESULT_CASE_MAP[messageCase] || messageCase

    this.logger.log(
      `ExecClientMessage: id=${numericId}, exec_id=${execId}, case=${resultCase}`
    )

    // This is a canonical convenience encoding only. parseAgentClientMessage
    // replaces it with exact nested frame bytes when this came through the
    // AgentClientMessage transport envelope.
    const resultData = Buffer.from(
      toBinary(ExecClientMessageSchema, msg, { writeUnknownFields: true })
    )
    const execIdentity = createCursorExecResultRecord({
      numericId,
      execId,
      resultCase,
    })
    const hookAdditionalContexts = parseCursorHookAdditionalContextReceipts(
      msg.hookAdditionalContexts
    )

    return {
      sessionUpdateScope: "control",
      newMessage: "",
      model: "",
      thinkingLevel: 0,
      unifiedMode: "AGENT",
      isAgentic: true,
      supportedTools: [],
      useWeb: false,
      toolResults: [
        {
          toolType: numericId, // 存储 numeric id 用于配对
          resultCase,
          resultData,
          execIdentity,
          ...(hookAdditionalContexts.length > 0
            ? { hookAdditionalContexts }
            : {}),
        },
      ],
    }
  }
}

// 单例
export const cursorRequestParser = new CursorRequestParser()
