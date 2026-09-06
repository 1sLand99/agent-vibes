import type { CodexModelProfile } from "./codex-model-catalog"
import type { ProviderMessageContent } from "../../shared/provider-content"
import type { ThinkingIntent } from "../shared/thinking-types"
import type { CodexProviderIdentity } from "./codex-provider-identity"
import type { CodexProjectionState } from "./codex-projection-state"

/**
 * Bridge-local ownership of the native Responses continuation chain.
 *
 * This is intentionally not a wire field. A physical provider attempt must
 * decide its input shape before dispatch, while the shared response baseline
 * is published only after that attempt crosses its acceptance boundary.
 */
export type CodexContinuationPolicy = "auto" | "full" | "isolated"

export interface CodexConversationMessage {
  role: "user" | "assistant" | "developer"
  content: ProviderMessageContent
  /**
   * Durable session-graph identity used by the bridge projection layer.
   * The Codex wire encoder deliberately ignores this field; history
   * projection must retain it until the native input item is bound.
   */
  sourceUuid?: string
  /**
   * Split-sibling assistant message id. Main Cursor streaming persists each
   * content block separately while sharing this id; Codex projection uses it
   * to suppress rendered shadow siblings when raw response items are present.
   */
  messageId?: string
}

export interface CodexConversationTool {
  type?:
    | "function"
    | "custom"
    | "tool_search"
    | "web_search"
    | "web_search_20250305"
    | "image_generation"
  name: string
  description: string
  input_schema?: Record<string, unknown>
  execution?: "client"
  format?: Record<string, unknown>
  external_web_access?: boolean
  search_context_size?: "low" | "medium" | "high"
  search_content_types?: string[]
  output_format?: string
}

export interface CodexSystemTextBlock {
  type?: string
  text?: string
}

/**
 * Fields shared by every request sent to the native Codex Responses
 * transport. These values are deliberately independent of how the prompt
 * itself is sourced.
 */
interface CodexExecutionRequestBase {
  modelProfile?: CodexModelProfile
  responseFormat?: "native"
  model: string
  system?: string | CodexSystemTextBlock[]
  tools?: CodexConversationTool[]
  /**
   * Formal Responses-native identity. This is deliberately distinct from the
   * local projection key below. Upstream cache/account policy may use the
   * native session id but must never derive it from that local key.
   */
  upstreamIdentity: CodexProviderIdentity
  /**
   * Bridge-only continuation/projection scope. It never crosses the native
   * identity boundary as a session id, thread id, or prompt-cache key.
   */
  localProjectionKey: string
  /**
   * `auto` derives a candidate-local incremental request from the last
   * accepted response. `full` always sends the complete native input and
   * replaces that baseline only after acceptance. `isolated` sends a complete
   * input without reading or publishing the shared response chain.
   */
  continuationPolicy?: CodexContinuationPolicy
  thinkingIntent?: ThinkingIntent | null
  includeThinkingSummary?: boolean
  serviceTier?: string
  /** Exact Responses tool-selection policy for this physical request. */
  toolChoice?: string | Record<string, unknown>
  parallelToolCalls?: boolean
  clientMetadata?: Record<string, string>
  textVerbosity?: string
}

/**
 * A normal bridge execution starts from durable conversation messages and is
 * projected to Responses input at the Codex boundary.
 */
export interface CodexExecutionRequest extends CodexExecutionRequestBase {
  contextMessages?: CodexConversationMessage[]
  messages: CodexConversationMessage[]
  nativeInput?: never
  /**
   * Provider-native active history. When supplied, `messages` and
   * `contextMessages` are the current-step reinjection tail; the projection
   * state owns prior Codex ResponseItems and compaction replacements.
   */
  projectionState?: CodexProjectionState
}

/**
 * A native rollout request bypasses conversation-message projection entirely.
 * It exists for paths such as Remote Compaction V2 whose input is already an
 * exact Responses rollout. `never` fields make mixed prompt sources a type
 * error for bridge callers; the projector retains a runtime boundary check
 * for untyped external input.
 */
export interface CodexNativeInputExecutionRequest extends CodexExecutionRequestBase {
  nativeInput: readonly CodexInputItem[]
  /** Full native ingress payload; never projected through Anthropic messages. */
  wireRequest?: CodexRequest
  messages?: never
  contextMessages?: never
  projectionState?: never
}

/**
 * The only two native Codex prompt sources. Transport receives this union so
 * a rollout-native request is never forced through an empty-message adapter.
 */
export type CodexProviderExecutionRequest =
  | CodexExecutionRequest
  | CodexNativeInputExecutionRequest

/**
 * Remote Compaction V2 receives the exact native prompt history before the
 * trailing `compaction_trigger` is appended. Keeping this separate from a
 * normal execution request makes it impossible for callers to accidentally
 * rebuild the history through UnifiedMessage projection.
 */
export type CodexRemoteCompactionV2Request = Omit<
  CodexNativeInputExecutionRequest,
  "nativeInput"
> & {
  /** Full provider-native prompt input before the new trigger item. */
  nativeInput: readonly CodexInputItem[]
  /** The owning turn cancels this request when it is superseded. */
  signal: AbortSignal
}

export interface CodexInputMessage extends Record<string, unknown> {
  id?: string
  type: "message"
  role: string
  content: Array<Record<string, unknown>>
}

export interface CodexFunctionCall {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface CodexCustomToolCall {
  type: "custom_tool_call"
  call_id: string
  name: string
  input: string
}

export interface CodexFunctionCallOutput extends Record<string, unknown> {
  type: "function_call_output"
  call_id?: string
  name?: string
  namespace?: string
  output: string | Array<Record<string, unknown>>
}

export interface CodexCustomToolCallOutput {
  type: "custom_tool_call_output"
  call_id: string
  output: string | Array<Record<string, unknown>>
}

export interface CodexCompactionInputItem {
  type: "compaction"
  encrypted_content: string
}

export interface CodexContextCompactionInputItem extends Record<
  string,
  unknown
> {
  type: "context_compaction"
  encrypted_content?: string
}

export interface CodexCompactionTriggerInputItem {
  type: "compaction_trigger"
}

export interface CodexAdditionalTools extends Record<string, unknown> {
  id?: string
  type: "additional_tools"
  role: string
  tools: CodexTool[]
}

export interface CodexAgentMessageInputItem extends Record<string, unknown> {
  type: "agent_message"
  author: string
  recipient: string
  content: Array<Record<string, unknown>>
}

export interface CodexReasoningInputItem extends Record<string, unknown> {
  type: "reasoning"
  summary?: Array<Record<string, unknown>>
  content?: Array<Record<string, unknown>>
  encrypted_content?: string | null
}

export interface CodexLocalShellCallInputItem extends Record<string, unknown> {
  type: "local_shell_call"
  call_id?: string
  status?: string
  action?: Record<string, unknown>
}

export interface CodexToolSearchCallInputItem extends Record<string, unknown> {
  type: "tool_search_call"
  call_id?: string
  status?: string
  execution: string
  arguments: unknown
}

export interface CodexToolSearchOutputInputItem extends Record<
  string,
  unknown
> {
  type: "tool_search_output"
  call_id?: string
  status: string
  execution: string
  tools: unknown[]
}

export interface CodexWebSearchCallInputItem extends Record<string, unknown> {
  type: "web_search_call"
  status?: string
  action?: Record<string, unknown>
}

export interface CodexImageGenerationCallInputItem extends Record<
  string,
  unknown
> {
  type: "image_generation_call"
  status: string
  revised_prompt?: string
  result: string
}

export interface CodexConfigurationUpdate extends Record<string, unknown> {
  type: "configuration_update"
  reasoning: { effort: string }
}

export type CodexInputItem =
  | CodexConfigurationUpdate
  | CodexInputMessage
  | CodexFunctionCall
  | CodexCustomToolCall
  | CodexFunctionCallOutput
  | CodexCustomToolCallOutput
  | CodexCompactionInputItem
  | CodexCompactionTriggerInputItem
  | CodexAdditionalTools
  | CodexContextCompactionInputItem
  | CodexAgentMessageInputItem
  | CodexReasoningInputItem
  | CodexLocalShellCallInputItem
  | CodexToolSearchCallInputItem
  | CodexToolSearchOutputInputItem
  | CodexWebSearchCallInputItem
  | CodexImageGenerationCallInputItem

export interface CodexTool {
  type:
    | "function"
    | "custom"
    | "tool_search"
    | "web_search"
    | "image_generation"
    | "namespace"
  tools?: CodexTool[]
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  execution?: "client"
  strict?: boolean
  format?: Record<string, unknown>
  external_web_access?: boolean
  search_context_size?: "low" | "medium" | "high"
  search_content_types?: string[]
  output_format?: string
}

export interface CodexRequest {
  model: string
  instructions: string
  input: CodexInputItem[]
  tools?: CodexTool[]
  tool_choice?: string | Record<string, unknown>
  stream: boolean
  store?: boolean
  parallel_tool_calls?: boolean
  reasoning?: { effort?: string; summary?: string; context?: "all_turns" }
  include?: string[]
  previous_response_id?: string
  client_metadata?: Record<string, string>
  text?: { verbosity: string }
  service_tier?: string
  prompt_cache_key?: string
  generate?: boolean
  [key: string]: unknown
}
