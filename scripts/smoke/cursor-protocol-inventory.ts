import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ConversationActionSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecServerControlMessageSchema,
  ExecServerMessageSchema,
  ExecuteHookRequestSchema,
  ExecuteHookResponseSchema,
  InteractionQuerySchema,
  InteractionResponseSchema,
  InteractionUpdateSchema,
  ToolCallSchema,
} from "../../apps/protocol-bridge/src/gen/agent/v1_pb"
import {
  CURSOR_TOOL_CALL_CAPABILITIES,
  type CursorToolCallFamily,
} from "../../apps/protocol-bridge/src/protocol/cursor/tools/cursor-protocol-capability-manifest"
import { pathToFileURL } from "node:url"

interface OneofField {
  readonly localName: string
  readonly oneof?: { readonly name: string }
}

interface MessageSchemaLike {
  readonly fields: readonly OneofField[]
}

const toolCallFamilies = Object.freeze(
  CURSOR_TOOL_CALL_CAPABILITIES.reduce<Record<CursorToolCallFamily, string[]>>(
    (families, entry) => {
      families[entry.family].push(entry.caseId)
      return families
    },
    {
      filesystem_read: [],
      filesystem_write: [],
      shell: [],
      search: [],
      diagnostics: [],
      planning_todos: [],
      network: [],
      mcp: [],
      subagent: [],
      ide_interaction: [],
      scm_pr_cloud: [],
      reporting: [],
      grind: [],
      pi: [],
      conversation: [],
      protocol_guard: [],
    }
  )
)

const interactionPairs = [
  ["webSearchRequestQuery", "webSearchRequestResponse"],
  ["askQuestionInteractionQuery", "askQuestionInteractionResponse"],
  ["switchModeRequestQuery", "switchModeRequestResponse"],
  ["createPlanRequestQuery", "createPlanRequestResponse"],
  ["setupVmEnvironmentArgs", "setupVmEnvironmentResult"],
  ["webFetchRequestQuery", "webFetchRequestResponse"],
  ["prManagementRequestQuery", "prManagementResult"],
  ["mcpAuthRequestQuery", "mcpAuthRequestResponse"],
  ["generateImageRequestQuery", "generateImageRequestResponse"],
  ["replaceEnvArgs", "replaceEnvResult"],
  ["connectScmRequestQuery", "connectScmRequestResponse"],
] as const

const agentClientMessages = [
  "runRequest",
  "execClientMessage",
  "kvClientMessage",
  "conversationAction",
  "execClientControlMessage",
  "interactionResponse",
  "clientHeartbeat",
  "prewarmRequest",
] as const

const agentServerMessages = [
  "interactionUpdate",
  "execServerMessage",
  "conversationCheckpointUpdate",
  "kvServerMessage",
  "execServerControlMessage",
  "interactionQuery",
] as const

const interactionUpdates = [
  "textDelta",
  "toolCallStarted",
  "toolCallCompleted",
  "thinkingDelta",
  "thinkingCompleted",
  "userMessageAppended",
  "partialToolCall",
  "tokenDelta",
  "summary",
  "summaryStarted",
  "summaryCompleted",
  "shellOutputDelta",
  "heartbeat",
  "turnEnded",
  "toolCallDelta",
  "stepStarted",
  "stepCompleted",
  "promptSuggestion",
  "postRequestPrompt",
  "activeBranchChange",
  "feedbackRequest",
  "responseComparison",
  "contextInjectionState",
  "routedModel",
] as const

const conversationActions = [
  "userMessageAction",
  "resumeAction",
  "cancelAction",
  "summarizeAction",
  "shellCommandAction",
  "startPlanAction",
  "executePlanAction",
  "asyncAskQuestionCompletionAction",
  "cancelSubagentAction",
  "backgroundTaskCompletionAction",
  "backgroundShellAction",
  "backgroundSubagentAction",
  "subscriptionNotificationAction",
  "goalContinuationAction",
  "injectContextAction",
] as const

const execPairs = [
  ["shellArgs", "shellResult"],
  ["writeArgs", "writeResult"],
  ["deleteArgs", "deleteResult"],
  ["grepArgs", "grepResult"],
  ["readArgs", "readResult"],
  ["lsArgs", "lsResult"],
  ["diagnosticsArgs", "diagnosticsResult"],
  ["requestContextArgs", "requestContextResult"],
  ["mcpArgs", "mcpResult"],
  ["shellStreamArgs", "shellStream"],
  ["backgroundShellSpawnArgs", "backgroundShellSpawnResult"],
  ["listMcpResourcesExecArgs", "listMcpResourcesExecResult"],
  ["readMcpResourceExecArgs", "readMcpResourceExecResult"],
  ["fetchArgs", "fetchResult"],
  ["recordScreenArgs", "recordScreenResult"],
  ["computerUseArgs", "computerUseResult"],
  ["writeShellStdinArgs", "writeShellStdinResult"],
  ["executeHookArgs", "executeHookResult"],
  ["subagentArgs", "subagentResult"],
  ["redactedReadArgs", "redactedReadResult"],
  ["forceBackgroundShellArgs", "forceBackgroundShellResult"],
  ["forceBackgroundSubagentArgs", "forceBackgroundSubagentResult"],
  ["mcpStateExecArgs", "mcpStateExecResult"],
  ["subagentAwaitArgs", "subagentAwaitResult"],
  ["smartModeClassifierArgs", "smartModeClassifierResult"],
  ["canvasDiagnosticsArgs", "canvasDiagnosticsResult"],
  ["shellAllowlistPrecheckArgs", "shellAllowlistPrecheckResult"],
  ["mcpAllowlistPrecheckArgs", "mcpAllowlistPrecheckResult"],
  ["webFetchAllowlistPrecheckArgs", "webFetchAllowlistPrecheckResult"],
  ["gitDiffRequest", "gitDiffResponse"],
  ["piReadArgs", "piReadResult"],
  ["piBashArgs", "piBashResult"],
  ["piEditArgs", "piEditResult"],
  ["piWriteArgs", "piWriteResult"],
  ["piGrepArgs", "piGrepResult"],
  ["piFindArgs", "piFindResult"],
  ["piLsArgs", "piLsResult"],
  ["conversationSearchArgs", "conversationSearchResult"],
  ["miniSweAgentBashArgs", "miniSweAgentBashResult"],
  ["agentStoreConflictArgs", "agentStoreConflictResult"],
  ["adoptArgs", "adoptResult"],
] as const

const execControl = {
  server: ["abort"],
  client: ["streamClose", "throw", "heartbeat"],
} as const

const hookPairs = [
  "preCompact",
  "subagentStart",
  "subagentStop",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "afterAgentThought",
  "stop",
] as const

function oneofCases(
  schema: MessageSchemaLike,
  oneofName: string
): readonly string[] {
  return schema.fields
    .filter((field) => field.oneof?.name === oneofName)
    .map((field) => field.localName)
}

function assertExactMembers(
  label: string,
  actual: readonly string[],
  classified: readonly string[]
): void {
  const actualSet = new Set(actual)
  const classifiedSet = new Set(classified)
  const duplicateClassifications = classified.filter(
    (value, index) => classified.indexOf(value) !== index
  )
  const missing = actual.filter((value) => !classifiedSet.has(value))
  const removed = classified.filter((value) => !actualSet.has(value))
  if (
    duplicateClassifications.length > 0 ||
    missing.length > 0 ||
    removed.length > 0
  ) {
    throw new Error(
      `${label} inventory drift: missing=[${missing.join(", ")}], ` +
        `removed=[${removed.join(", ")}], ` +
        `duplicates=[${[...new Set(duplicateClassifications)].join(", ")}]`
    )
  }
}

function buildExecPairs(
  serverCases: readonly string[],
  clientCases: readonly string[]
): readonly { readonly request: string; readonly result: string }[] {
  assertExactMembers(
    "ExecServerMessage.message",
    serverCases,
    execPairs.map(([request]) => request)
  )
  assertExactMembers(
    "ExecClientMessage.message",
    clientCases,
    execPairs.map(([, result]) => result)
  )
  return execPairs.map(([request, result]) =>
    Object.freeze({ request, result })
  )
}

export function buildCursorProtocolInventory() {
  const actualAgentClientMessages = oneofCases(
    AgentClientMessageSchema,
    "message"
  )
  const actualAgentServerMessages = oneofCases(
    AgentServerMessageSchema,
    "message"
  )
  const actualInteractionUpdates = oneofCases(
    InteractionUpdateSchema,
    "message"
  )
  const actualConversationActions = oneofCases(
    ConversationActionSchema,
    "action"
  )
  const actualExecServerControl = oneofCases(
    ExecServerControlMessageSchema,
    "message"
  )
  const actualExecClientControl = oneofCases(
    ExecClientControlMessageSchema,
    "message"
  )
  assertExactMembers(
    "AgentClientMessage.message",
    actualAgentClientMessages,
    agentClientMessages
  )
  assertExactMembers(
    "AgentServerMessage.message",
    actualAgentServerMessages,
    agentServerMessages
  )
  assertExactMembers(
    "InteractionUpdate.message",
    actualInteractionUpdates,
    interactionUpdates
  )
  assertExactMembers(
    "ConversationAction.action",
    actualConversationActions,
    conversationActions
  )
  assertExactMembers(
    "ExecServerControlMessage.message",
    actualExecServerControl,
    execControl.server
  )
  assertExactMembers(
    "ExecClientControlMessage.message",
    actualExecClientControl,
    execControl.client
  )

  const toolCallCases = oneofCases(ToolCallSchema, "tool")
  assertExactMembers(
    "ToolCall.tool",
    toolCallCases,
    Object.values(toolCallFamilies).flat()
  )

  const queryCases = oneofCases(InteractionQuerySchema, "query")
  const responseCases = oneofCases(InteractionResponseSchema, "result")
  assertExactMembers(
    "InteractionQuery.query",
    queryCases,
    interactionPairs.map(([query]) => query)
  )
  assertExactMembers(
    "InteractionResponse.result",
    responseCases,
    interactionPairs.map(([, response]) => response)
  )

  const execServerCases = oneofCases(ExecServerMessageSchema, "message")
  const execClientCases = oneofCases(ExecClientMessageSchema, "message")
  const execPairs = buildExecPairs(execServerCases, execClientCases)

  const hookRequestCases = oneofCases(ExecuteHookRequestSchema, "request")
  const hookResponseCases = oneofCases(ExecuteHookResponseSchema, "response")
  assertExactMembers("ExecuteHookRequest.request", hookRequestCases, hookPairs)
  assertExactMembers(
    "ExecuteHookResponse.response",
    hookResponseCases,
    hookPairs
  )

  return Object.freeze({
    schema: "agent.v1",
    counts: Object.freeze({
      agentClientMessages: actualAgentClientMessages.length,
      agentServerMessages: actualAgentServerMessages.length,
      interactionUpdates: actualInteractionUpdates.length,
      interactionPairs: interactionPairs.length,
      toolCalls: toolCallCases.length,
      conversationActions: actualConversationActions.length,
      execPairs: execPairs.length,
      hookPairs: hookRequestCases.length,
    }),
    agentClientMessages: actualAgentClientMessages,
    agentServerMessages: actualAgentServerMessages,
    interactionUpdates: actualInteractionUpdates,
    interactionPairs: interactionPairs.map(([query, response]) => ({
      query,
      response,
    })),
    toolCallFamilies,
    toolCallCapabilities: CURSOR_TOOL_CALL_CAPABILITIES,
    conversationActions: actualConversationActions,
    execPairs,
    execControl: Object.freeze({
      server: actualExecServerControl,
      client: actualExecClientControl,
    }),
    hookPairs: hookRequestCases,
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const inventory = buildCursorProtocolInventory()
  if (process.argv.includes("--check")) {
    console.log(
      `Cursor protocol inventory check passed: ` +
        `ToolCall=${inventory.counts.toolCalls}, ` +
        `Interaction=${inventory.counts.interactionPairs}, ` +
        `Update=${inventory.counts.interactionUpdates}, ` +
        `Exec=${inventory.counts.execPairs}, Hook=${inventory.counts.hookPairs}`
    )
  } else {
    console.log(JSON.stringify(inventory, null, 2))
  }
}
