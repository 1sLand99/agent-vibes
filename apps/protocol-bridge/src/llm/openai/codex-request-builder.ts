import { projectCodexNativeRequest } from "./codex-native-projector"
import type {
  CodexInputItem,
  CodexProviderExecutionRequest,
  CodexRequest,
  CodexTool,
} from "./codex-native-types"
import {
  resolveCodexRequestCapabilities,
  type CodexRequestCapabilities,
} from "../shared/model-registry"

const CODEX_UNKNOWN_MODEL_CAPABILITIES: CodexRequestCapabilities = {
  supportsVerbosity: false,
  supportsParallelToolCalls: false,
  useResponsesLite: false,
  supportsReasoningSummaries: false,
  supportsOriginalImageDetail: false,
  supportsImages: true,
  supportedServiceTiers: [],
}

export type {
  CodexCompactionInputItem,
  CodexContextCompactionInputItem,
  CodexConversationMessage,
  CodexConversationTool,
  CodexAdditionalTools,
  CodexAgentMessageInputItem,
  CodexCustomToolCall,
  CodexCustomToolCallOutput,
  CodexExecutionRequest,
  CodexFunctionCall,
  CodexFunctionCallOutput,
  CodexImageGenerationCallInputItem,
  CodexInputItem,
  CodexInputMessage,
  CodexLocalShellCallInputItem,
  CodexNativeInputExecutionRequest,
  CodexProviderExecutionRequest,
  CodexRequest,
  CodexReasoningInputItem,
  CodexSystemTextBlock,
  CodexToolSearchCallInputItem,
  CodexToolSearchOutputInputItem,
  CodexTool,
  CodexWebSearchCallInputItem,
} from "./codex-native-types"

export function buildCodexRequest(
  request: CodexProviderExecutionRequest,
  modelName: string = request.model,
  capabilities: CodexRequestCapabilities | null = resolveCodexRequestCapabilities(
    modelName
  )
): CodexRequest {
  const effectiveCapabilities = capabilities ?? CODEX_UNKNOWN_MODEL_CAPABILITIES
  const projection = projectCodexNativeRequest(request, modelName, {
    supportsOriginalImageDetail:
      effectiveCapabilities.supportsOriginalImageDetail === true,
    supportsImages: effectiveCapabilities.supportsImages === true,
  })

  const reasoning = resolveReasoningForRequest(
    projection.reasoning,
    effectiveCapabilities
  )
  const responsesPayload = buildResponsesPayloadForRequest(
    projection.instructions,
    projection.input,
    projection.tools,
    effectiveCapabilities
  )
  const codexRequest: CodexRequest = {
    model: modelName,
    instructions: responsesPayload.instructions,
    input: responsesPayload.input,
    stream: true,
    store: false,
    include: reasoning ? ["reasoning.encrypted_content"] : [],
  }

  if (reasoning) {
    codexRequest.reasoning = reasoning
  }

  const text = resolveTextParamForRequest(
    request.textVerbosity,
    effectiveCapabilities
  )
  if (text) {
    codexRequest.text = text
  }

  const serviceTier = resolveServiceTierForRequest(
    projection.serviceTier,
    effectiveCapabilities
  )
  if (serviceTier) {
    codexRequest.service_tier = serviceTier
  }

  if (responsesPayload.tools && responsesPayload.tools.length > 0) {
    codexRequest.tools = responsesPayload.tools
    codexRequest.tool_choice = request.toolChoice ?? "auto"
    codexRequest.parallel_tool_calls = resolveParallelToolCallsForRequest(
      request.parallelToolCalls,
      effectiveCapabilities
    )
  }

  const clientMetadata = request.clientMetadata
  if (clientMetadata && Object.keys(clientMetadata).length > 0) {
    codexRequest.client_metadata = clientMetadata
  }

  // previous_response_id 现在由 CodexService.streamViaWebSocket() 在 transport 层自动注入，
  // 由 strict incremental delta 校验保护，不再从外部传入。
  // 采用 prepare_websocket_request() 设计。

  return codexRequest
}

function buildResponsesPayloadForRequest(
  instructions: string,
  input: CodexInputItem[],
  tools: CodexTool[] | undefined,
  capabilities: CodexRequestCapabilities | null
): { instructions: string; input: CodexInputItem[]; tools?: CodexTool[] } {
  if (capabilities?.useResponsesLite !== true) {
    return { instructions, input, tools }
  }

  const prefix: CodexInputItem[] = [
    {
      type: "additional_tools",
      role: "developer",
      tools: tools || [],
    },
  ]

  if (instructions.length > 0) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    })
  }

  return {
    instructions: "",
    input: [...prefix, ...stripImageDetailsForResponsesLite(input)],
  }
}

function stripImageDetailsForResponsesLite(
  input: CodexInputItem[]
): CodexInputItem[] {
  return input.map((item) => {
    if (item.type === "message") {
      return {
        ...item,
        content: stripImageDetailsFromContent(item.content),
      }
    }

    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
    ) {
      return Array.isArray(item.output)
        ? {
            ...item,
            output: stripImageDetailsFromContent(item.output),
          }
        : { ...item }
    }

    return { ...item }
  })
}

function stripImageDetailsFromContent(
  content: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return content.map((part) => {
    if (part.type !== "input_image") {
      return { ...part }
    }

    const { detail: _detail, ...rest } = part
    return rest
  })
}

function resolveParallelToolCallsForRequest(
  requested: boolean | undefined,
  capabilities: CodexRequestCapabilities | null
): boolean {
  return (
    requested !== false &&
    capabilities?.supportsParallelToolCalls !== false &&
    capabilities?.useResponsesLite !== true
  )
}

function resolveTextParamForRequest(
  textVerbosity: string | undefined,
  capabilities: CodexRequestCapabilities | null
): CodexRequest["text"] | undefined {
  if (capabilities?.supportsVerbosity === false) {
    return undefined
  }

  const verbosity =
    textVerbosity?.trim() || capabilities?.defaultVerbosity?.trim() || "low"
  return verbosity ? { verbosity } : undefined
}

function resolveReasoningForRequest(
  reasoning: CodexRequest["reasoning"],
  capabilities: CodexRequestCapabilities | null
): CodexRequest["reasoning"] {
  if (capabilities?.supportsReasoningSummaries === false) {
    return undefined
  }
  if (!reasoning) {
    return undefined
  }
  if (capabilities?.useResponsesLite === true) {
    return { ...reasoning, context: "all_turns" }
  }
  return reasoning
}

function resolveServiceTierForRequest(
  serviceTier: string | undefined,
  capabilities: CodexRequestCapabilities | null
): string | undefined {
  if (!serviceTier || serviceTier === "default") {
    return undefined
  }

  const supportedServiceTiers = capabilities?.supportedServiceTiers
  if (supportedServiceTiers) {
    return supportedServiceTiers.includes(serviceTier) ? serviceTier : undefined
  }

  return serviceTier
}

/**
 * 从完整的 CodexRequest 中提取 warmup-only payload。
 * 普通 Responses 请求保留顶层静态配置并清空 input；Responses Lite 请求的
 * tools/instructions 已经位于 input 前缀，因此只保留该静态前缀。
 *
 * 对齐官方 Codex CLI（session_startup_prewarm.rs）：
 *   build_prompt(Vec::new(), ...) 后仍通过同一套 Responses request builder。
 */
export function extractWarmupPayload(
  codexRequest: CodexRequest
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: codexRequest.model,
    instructions: codexRequest.instructions,
    input: extractWarmupInputItems(codexRequest.input),
    stream: true,
    store: codexRequest.store,
    parallel_tool_calls: codexRequest.parallel_tool_calls,
    reasoning: codexRequest.reasoning,
    include: codexRequest.include,
    tool_choice: codexRequest.tool_choice,
  }

  if (codexRequest.text) {
    payload.text = codexRequest.text
  }
  if (codexRequest.tools && codexRequest.tools.length > 0) {
    payload.tools = codexRequest.tools
  }
  if (codexRequest.service_tier) {
    payload.service_tier = codexRequest.service_tier
  }
  if (codexRequest.client_metadata) {
    payload.client_metadata = codexRequest.client_metadata
  }

  return payload
}

function extractWarmupInputItems(input: CodexInputItem[]): CodexInputItem[] {
  if (input[0]?.type !== "additional_tools") {
    return []
  }

  const additionalTools = input[0]
  const prefix: CodexInputItem[] = [
    {
      ...additionalTools,
      tools: additionalTools.tools.map((tool) => ({ ...tool })),
    },
  ]
  const developerMessage = input[1]
  if (
    developerMessage?.type === "message" &&
    developerMessage.role === "developer"
  ) {
    prefix.push({
      ...developerMessage,
      content: developerMessage.content.map((part) => ({ ...part })),
    })
  }

  return prefix
}
