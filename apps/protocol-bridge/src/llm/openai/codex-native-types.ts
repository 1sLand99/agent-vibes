import { type LooseMessageContent } from "../../context"
import type { ThinkingIntent } from "../shared/thinking-types"

export interface CodexConversationMessage {
  role: "user" | "assistant" | "developer"
  content: LooseMessageContent
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

export interface CodexExecutionRequest {
  model: string
  system?: string | CodexSystemTextBlock[]
  contextMessages?: CodexConversationMessage[]
  messages: CodexConversationMessage[]
  tools?: CodexConversationTool[]
  conversationId?: string
  pendingToolUseIds?: string[]
  inputToolIntegrity?: "sanitize" | "preserve"
  thinkingIntent?: ThinkingIntent | null
  includeThinkingSummary?: boolean
  serviceTier?: string
  parallelToolCalls?: boolean
  cacheUserId?: string
  /**
   * True when the request originates from the Claude Code frontend (set from
   * `dto._clientIsClaudeCode` by the Claude→Codex translator). Suppresses the
   * forced language directive in the built instructions — CC manages its own
   * response/thinking language.
   */
  clientIsClaudeCode?: boolean
  /**
   * @deprecated previous_response_id 现在由 CodexService.streamViaWebSocket() 在 transport 层自动注入，
   * 由 strict incremental delta 校验保护。不再从外部传入。该字段不参与请求构建。
   * 保留字段声明以避免现有调用方的编译错误。
   */
  previousResponseId?: string
  clientMetadata?: Record<string, string>
  textVerbosity?: string
}

export interface CodexInputMessage {
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

export interface CodexFunctionCallOutput {
  type: "function_call_output"
  call_id: string
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

export interface CodexAdditionalTools {
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

export type CodexInputItem =
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
  reasoning?: { effort: string; summary?: string; context?: "all_turns" }
  include?: string[]
  previous_response_id?: string
  client_metadata?: Record<string, string>
  text?: { verbosity: string }
  service_tier?: string
  prompt_cache_key?: string
  generate?: boolean
  [key: string]: unknown
}
