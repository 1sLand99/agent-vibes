import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import {
  WorkspaceScope,
  WorkspaceScopeError,
  type FrozenWorkspaceScopeSnapshot,
} from "./workspace-scope"
import {
  SESSION_TODO_STATUSES,
  type SessionTodoStatus,
} from "./session-persistence.service"

/**
 * The durable request boundary for a child agent. A run already owns its
 * lifecycle, graph branch, model, task description, task prompt and native
 * provider lineage in `session_subagent_runs`; this value owns every other
 * input that changes what a child model can see or do.
 *
 * It deliberately contains no live-session references. A restart must replay
 * this immutable request exactly, never rebuild it from the current parent
 * session, agent definition, tool registry, workspace configuration, or
 * provider-specific tool projection.
 */

export type SubagentSpawnJsonPrimitive = string | number | boolean | null

export type SubagentSpawnJsonValue =
  | SubagentSpawnJsonPrimitive
  | SubagentSpawnJsonObject
  | readonly SubagentSpawnJsonValue[]

export interface SubagentSpawnJsonObject {
  readonly [key: string]: SubagentSpawnJsonValue
}

export interface SubagentModelRequestPolicy {
  /** Cursor protocol enum: off, enabled, or max. */
  readonly thinkingLevel: 0 | 1 | 2
  readonly thinkingDetailsRequested: boolean
  readonly contextTokenLimit: number | null
  readonly contextTokenLimitSource: "requested" | "conversation_state" | null
  readonly contextMaxMode: boolean
  readonly usedContextTokens: number | null
  readonly requestedMaxOutputTokens: number | null
  readonly requestedModelParameters: Readonly<Record<string, string>>
}

/**
 * The model-facing portion of `PromptContext`, excluding `newMessage` (the
 * durable run already owns the task prompt) and MCP definitions (the durable
 * tool contract below owns their canonical execution identity and schema).
 */
export interface SubagentPromptContextSnapshot {
  readonly projectContext: {
    readonly rootPath: string
    readonly directories: readonly string[]
    readonly files: readonly string[]
    readonly workspaceFolders: readonly {
      readonly uri: string
      readonly path: string
      readonly name: string
    }[]
  }
  readonly codeChunks: readonly {
    readonly path: string
    readonly content: string
    readonly startLine: number | null
    readonly endLine: number | null
  }[]
  /** Canonical JSON form of the Cursor rule records actually rendered. */
  readonly cursorRules: readonly SubagentSpawnJsonObject[]
  /** Canonical JSON form of the skill options actually rendered. */
  readonly skillOptions: SubagentSpawnJsonObject | null
  readonly selectedCursorRulePaths: readonly string[]
  readonly selectedCursorRuleNames: readonly string[]
  readonly activeCursorSkillNames: readonly string[]
  readonly cursorCommands: readonly {
    readonly name: string
    readonly content: string
  }[]
  readonly customSystemPrompt: string | null
  readonly hooksAdditionalContext: string | null
  readonly explicitContext: string | null
}

/** The task-scoped attachments carried by the Cursor request. */
export interface SubagentTaskAttachmentSnapshot {
  readonly images: readonly {
    readonly data: string
    readonly mimeType: string
    readonly width: number | null
    readonly height: number | null
  }[]
}

/**
 * A complete, child-owned `ContextAttachmentSnapshot`. The live context type
 * has optional fields because top-level request construction can choose which
 * attachments to make. A child spawn request has no such ambiguity: every
 * collection is present, including deliberately empty ones.
 */
export interface SubagentChildContextAttachmentSnapshot {
  readonly readPaths: readonly string[]
  readonly fileStates: readonly {
    readonly path: string
    readonly beforeContent: string
    readonly afterContent: string
  }[]
  readonly todos: readonly {
    readonly id: string
    readonly content: string
    readonly status: SessionTodoStatus
    readonly dependencies: readonly string[]
  }[]
  readonly sessionMemory: readonly {
    readonly kind:
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
    readonly text: string
    readonly createdAt: number | null
    readonly weight: number | null
    readonly sourceToolUseId: string
    readonly sourceRecordUuid: string
    readonly sourceKind: "tool_result" | "control_notification"
  }[]
  readonly activeSubAgents: readonly {
    readonly subagentId: string
    readonly model: string
    readonly turnCount: number
    readonly toolCallCount: number
    readonly modifiedFiles: readonly string[]
    readonly pendingToolCallIds: readonly string[]
  }[]
}

/**
 * Bridge-owned deferred operations that may be frozen into a child
 * capability. This durable enum belongs to the request contract: the
 * spawn-time compiler imports it, while recovery validates it without
 * loading or consulting that compiler's current catalog.
 */
export const SUBAGENT_BRIDGE_DEFERRED_FAMILIES = [
  "semantic_search",
  "deep_search",
  "read_semsearch_files",
  "file_search",
  "web_search",
  "web_fetch",
  "fetch",
  "exa_search",
  "exa_fetch",
  "fetch_rules",
  "read_lints",
  "read_project",
  "read_todos",
  "update_todos",
  "get_mcp_tools",
  "knowledge_base",
  "fetch_pull_request",
  "reflect",
  "search_symbols",
  "go_to_definition",
] as const

export type SubagentBridgeDeferredFamily =
  (typeof SUBAGENT_BRIDGE_DEFERRED_FAMILIES)[number]

/**
 * The one exact ExecServerMessage request/ExecClientMessage terminal pair a
 * frozen child capability is allowed to exchange.  This is persisted with
 * the owner; terminal routing must consume this value directly rather than
 * infer a response family from a tool name or the current bridge catalog.
 *
 * There is deliberately no streamed arm.  A future streamed capability must
 * add its complete request/transport/result pair here before it can enter a
 * frozen child contract.
 */
export type SubagentExecProtocol =
  | {
      readonly requestCase: "writeArgs"
      readonly terminal: {
        readonly transport: "single"
        readonly resultCase: "writeResult"
      }
    }
  | {
      readonly requestCase: "deleteArgs"
      readonly terminal: {
        readonly transport: "single"
        readonly resultCase: "deleteResult"
      }
    }
  | {
      readonly requestCase: "mcpArgs"
      readonly terminal: {
        readonly transport: "single"
        readonly resultCase: "mcpResult"
      }
    }

/**
 * The durable runtime owner for a model-visible child tool. This is a
 * dispatch contract, not a provider `ToolDefinition`: recovery must use this
 * exact owner rather than classify the tool name against the current bridge
 * registry.
 */
export type SubagentToolExecutionOwner =
  | {
      readonly kind: "bridge-inline"
      /** Fixed bridge operation; recovery must not classify a tool name. */
      readonly operation: SubagentBridgeInlineOperation
    }
  | {
      readonly kind: "bridge-deferred"
      readonly family: SubagentBridgeDeferredFamily
    }
  | {
      /** Cursor ExecClientMessage round-trip owner. */
      readonly kind: "cursor-client"
      /** Exact Cursor definition key passed to the protocol encoder. */
      readonly cursorDefinitionKey: string
      readonly protocolToolName: string
      /** Exact request/terminal oneof pair persisted at spawn time. */
      readonly execProtocol: SubagentExecProtocol
    }
  | {
      /**
       * One exact Cursor InteractionQuery/InteractionResponse exchange.
       * This is deliberately not a generic interaction-query family: a
       * durable child capability names the sole protocol oneof pair it may
       * issue and accept.
       */
      readonly kind: "cursor-interaction-query"
      readonly cursorDefinitionKey: string
      readonly protocolToolName: string
      readonly queryCase: "createPlanRequestQuery"
      readonly responseCase: "createPlanRequestResponse"
    }
  | {
      /** A concrete MCP tool dispatched through the Cursor client. */
      readonly kind: "mcp-client"
      readonly providerIdentifier: string
      readonly toolName: string
      readonly ideRegistryKey: string
      /** Exact frozen MCP definition name, before provider rendering. */
      readonly definitionName: string
      /** Exact function name emitted into the model request. */
      readonly modelToolName: string
      /** Exact request/terminal oneof pair persisted at spawn time. */
      readonly execProtocol: SubagentExecProtocol
    }

/**
 * Verify that a persisted client owner still carries the one official Exec
 * pair for its immutable capability.  This is an assertion, not a resolver:
 * callers retain the persisted pair for dispatch and terminal projection.
 */
export function assertFrozenSubagentExecProtocolOwnerBinding(
  owner: Extract<
    SubagentToolExecutionOwner,
    { readonly kind: "cursor-client" | "mcp-client" }
  >
): void {
  const protocol = owner.execProtocol
  const isPair = (
    requestCase: SubagentExecProtocol["requestCase"],
    resultCase: SubagentExecProtocol["terminal"]["resultCase"]
  ) =>
    protocol.requestCase === requestCase &&
    protocol.terminal.transport === "single" &&
    protocol.terminal.resultCase === resultCase

  if (owner.kind === "mcp-client") {
    if (isPair("mcpArgs", "mcpResult")) return
    throw new Error(
      "Frozen MCP child owner does not carry the mcpArgs/mcpResult exec protocol pair."
    )
  }

  switch (owner.cursorDefinitionKey) {
    case "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2":
      if (isPair("writeArgs", "writeResult")) return
      throw new Error(
        "Frozen edit child owner does not carry the writeArgs/writeResult exec protocol pair."
      )
    case "CLIENT_SIDE_TOOL_V2_DELETE_FILE":
      if (isPair("deleteArgs", "deleteResult")) return
      throw new Error(
        "Frozen delete child owner does not carry the deleteArgs/deleteResult exec protocol pair."
      )
    default:
      throw new Error(
        `Frozen cursor child owner ${owner.cursorDefinitionKey} has no exact Exec protocol pair.`
      )
  }
}

/**
 * Bridge-owned operations permitted in a child tool contract. The operation
 * is explicit so recovery never reclassifies `entry.name` against a current
 * handler table.
 */
export const SUBAGENT_BRIDGE_INLINE_OPERATIONS = [
  "grep_search",
  "read_file",
  "list_directory",
  "list_mcp_resources",
  "read_mcp_resource",
  "run_terminal_command",
] as const

export type SubagentBridgeInlineOperation =
  (typeof SUBAGENT_BRIDGE_INLINE_OPERATIONS)[number]

/**
 * Frozen execution authority for both child execution modes. Null means the
 * compiled child request does not expose that capability in the mode; it is
 * never a signal to discover another owner after recovery.
 */
export interface SubagentToolExecutionOwners {
  readonly foreground: SubagentToolExecutionOwner | null
  readonly background: SubagentToolExecutionOwner | null
}

/**
 * One visible MCP tool in the child-owned registry. The same metadata is
 * used for `get_mcp_tools` output and to validate each concrete
 * `mcp-client` execution owner; it must never be reconstructed from a live
 * session registry during recovery.
 */
export interface SubagentMcpRegistryTool {
  /** Exact durable capability this MCP registry record binds. */
  readonly capabilityId: string
  readonly definitionName: string
  readonly modelToolName: string
  readonly toolName: string
  readonly description: string
  readonly schemaSha256: string
  readonly inputSchema: SubagentSpawnJsonObject
}

/** A child-visible MCP server scope, including deliberately empty servers. */
export interface SubagentMcpRegistryServerScope {
  readonly providerIdentifier: string
  readonly ideRegistryKey: string
  readonly tools: readonly SubagentMcpRegistryTool[]
}

export interface SubagentToolContractEntry {
  /** SHA-256 of this exact capability identity, excluding this field itself. */
  readonly capabilityId: string
  /** Explicit provider-neutral tool kind; child tools currently use functions. */
  readonly kind: "function"
  /** Provider-neutral model-visible function name. */
  readonly name: string
  readonly description: string
  /** The only accepted schema language for a function tool. */
  readonly schemaDialect: "json-schema"
  /** Frozen model schema behavior; encoders must not infer this later. */
  readonly strict: boolean
  /** Canonical JSON Schema; no adapter-specific ToolDefinition is persisted. */
  readonly inputSchema: SubagentSpawnJsonObject
  /** SHA-256 of canonical inputSchema; verified independently of entry id. */
  readonly schemaSha256: string
  /** Complete compiled authority for each child execution mode. */
  readonly executionOwners: SubagentToolExecutionOwners
}

/** Canonical entry payload used to derive `capabilityId`. */
export interface SubagentToolCapabilityIdentityInput {
  readonly kind: "function"
  readonly name: string
  readonly description: string
  readonly schemaDialect: "json-schema"
  readonly strict: boolean
  readonly inputSchema: SubagentSpawnJsonObject
  readonly schemaSha256: string
  readonly executionOwners: SubagentToolExecutionOwners
}

export interface SubagentToolContract {
  readonly version: 2
  /** SHA-256 of the canonical ordered tool contract. */
  readonly fingerprint: string
  readonly tools: readonly SubagentToolContractEntry[]
  /** Complete MCP server/tool scope visible to this child request. */
  readonly mcpRegistry: readonly SubagentMcpRegistryServerScope[]
}

/** The fingerprint payload, excluding the digest that protects it. */
export interface SubagentToolContractFingerprintInput {
  readonly version: 2
  readonly tools: readonly SubagentToolContractEntry[]
  readonly mcpRegistry: readonly SubagentMcpRegistryServerScope[]
}

export interface SubagentSpawnRequest {
  readonly version: 3
  /** Final system prompt after agent and workspace prompt composition. */
  readonly systemPrompt: string
  /** SHA-256 of the exact resolved agent definition used at spawn time. */
  readonly agentDefinitionFingerprint: string
  /** Null preserves Claude Code's unbounded child query semantics. */
  readonly maxTurns: number | null
  readonly modelRequestPolicy: SubagentModelRequestPolicy
  readonly promptContext: SubagentPromptContextSnapshot
  readonly taskAttachments: SubagentTaskAttachmentSnapshot
  readonly childContextAttachmentSnapshot: SubagentChildContextAttachmentSnapshot
  /** Complete immutable child filesystem authority, including root sources. */
  readonly workspace: FrozenWorkspaceScopeSnapshot
  readonly requestEnvironment: {
    readonly terminalsFolder: string | null
    readonly projectFolder: string | null
    readonly shell: string | null
    readonly timeZone: string | null
    readonly agentTranscriptsFolder: string | null
    readonly artifactsFolder: string | null
  }
  readonly toolContract: SubagentToolContract
}

const SHA256_FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const MEMORY_KINDS = new Set<
  SubagentChildContextAttachmentSnapshot["sessionMemory"][number]["kind"]
>([
  "objective",
  "decision",
  "progress",
  "file",
  "constraint",
  "verification",
  "risk",
  "command",
  "sub_agent",
  "open_item",
])
const CONTEXT_TOKEN_LIMIT_SOURCES = new Set(["requested", "conversation_state"])
const SESSION_TODO_STATUS_SET = new Set<string>(SESSION_TODO_STATUSES)
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 100_000

/**
 * One complete normalized child boundary. The durable request and restored
 * workspace authority are produced together so a caller never validates a
 * snapshot and then reconstructs it again at a later runtime boundary.
 */
export interface NormalizedSubagentSpawnRequestBoundary {
  readonly request: SubagentSpawnRequest
  readonly workspaceScope: WorkspaceScope
}

/**
 * Normalize, clone, and deeply freeze the only accepted spawn request version
 * together with its sole restored WorkspaceScope. Unsupported fields and
 * non-JSON values fail before a run can become durable or child execution can
 * begin.
 */
export function normalizeSubagentSpawnRequestBoundary(
  value: unknown
): NormalizedSubagentSpawnRequestBoundary {
  const record = requireExactObject(value, "spawnRequest", [
    "version",
    "systemPrompt",
    "agentDefinitionFingerprint",
    "maxTurns",
    "modelRequestPolicy",
    "promptContext",
    "taskAttachments",
    "childContextAttachmentSnapshot",
    "workspace",
    "requestEnvironment",
    "toolContract",
  ])
  if (record.version !== 3) {
    fail("spawnRequest.version", "must equal 3")
  }

  const workspaceScope = normalizeWorkspaceScope(record.workspace)
  const workspace = workspaceScope.toFrozenSnapshot()
  const promptContext = normalizePromptContext(record.promptContext)
  assertPromptContextMatchesWorkspace(promptContext, workspaceScope)

  const request: SubagentSpawnRequest = {
    version: 3,
    systemPrompt: requireText(record.systemPrompt, "spawnRequest.systemPrompt"),
    agentDefinitionFingerprint: requireFingerprint(
      record.agentDefinitionFingerprint,
      "spawnRequest.agentDefinitionFingerprint"
    ),
    maxTurns: requireNullablePositiveSafeInteger(
      record.maxTurns,
      "spawnRequest.maxTurns"
    ),
    modelRequestPolicy: normalizeModelRequestPolicy(record.modelRequestPolicy),
    promptContext,
    taskAttachments: normalizeTaskAttachments(record.taskAttachments),
    childContextAttachmentSnapshot: normalizeChildContextAttachmentSnapshot(
      record.childContextAttachmentSnapshot
    ),
    workspace,
    requestEnvironment: normalizeRequestEnvironment(record.requestEnvironment),
    toolContract: normalizeToolContract(record.toolContract),
  }
  return Object.freeze({
    request: freezeDeep(request),
    workspaceScope,
  })
}

function normalizeModelRequestPolicy(
  value: unknown
): SubagentModelRequestPolicy {
  const record = requireExactObject(value, "spawnRequest.modelRequestPolicy", [
    "thinkingLevel",
    "thinkingDetailsRequested",
    "contextTokenLimit",
    "contextTokenLimitSource",
    "contextMaxMode",
    "usedContextTokens",
    "requestedMaxOutputTokens",
    "requestedModelParameters",
  ])
  const contextTokenLimit = requireNullablePositiveSafeInteger(
    record.contextTokenLimit,
    "spawnRequest.modelRequestPolicy.contextTokenLimit"
  )
  const contextTokenLimitSource = requireNullableEnum(
    record.contextTokenLimitSource,
    CONTEXT_TOKEN_LIMIT_SOURCES,
    "spawnRequest.modelRequestPolicy.contextTokenLimitSource"
  ) as SubagentModelRequestPolicy["contextTokenLimitSource"]
  if (
    (contextTokenLimit === null && contextTokenLimitSource !== null) ||
    (contextTokenLimit !== null && contextTokenLimitSource === null)
  ) {
    fail(
      "spawnRequest.modelRequestPolicy",
      "contextTokenLimit and contextTokenLimitSource must either both be set or both be null"
    )
  }
  const requestedModelParameters = requireExactStringRecord(
    record.requestedModelParameters,
    "spawnRequest.modelRequestPolicy.requestedModelParameters"
  )
  return {
    thinkingLevel: requireThinkingLevel(
      record.thinkingLevel,
      "spawnRequest.modelRequestPolicy.thinkingLevel"
    ),
    thinkingDetailsRequested: requireBoolean(
      record.thinkingDetailsRequested,
      "spawnRequest.modelRequestPolicy.thinkingDetailsRequested"
    ),
    contextTokenLimit,
    contextTokenLimitSource,
    contextMaxMode: requireBoolean(
      record.contextMaxMode,
      "spawnRequest.modelRequestPolicy.contextMaxMode"
    ),
    usedContextTokens: requireNullableNonNegativeSafeInteger(
      record.usedContextTokens,
      "spawnRequest.modelRequestPolicy.usedContextTokens"
    ),
    requestedMaxOutputTokens: requireNullablePositiveSafeInteger(
      record.requestedMaxOutputTokens,
      "spawnRequest.modelRequestPolicy.requestedMaxOutputTokens"
    ),
    requestedModelParameters,
  }
}

function normalizePromptContext(value: unknown): SubagentPromptContextSnapshot {
  const record = requireExactObject(value, "spawnRequest.promptContext", [
    "projectContext",
    "codeChunks",
    "cursorRules",
    "skillOptions",
    "selectedCursorRulePaths",
    "selectedCursorRuleNames",
    "activeCursorSkillNames",
    "cursorCommands",
    "customSystemPrompt",
    "hooksAdditionalContext",
    "explicitContext",
  ])
  return {
    projectContext: normalizeProjectContext(record.projectContext),
    codeChunks: normalizeCodeChunks(record.codeChunks),
    cursorRules: normalizeJsonObjectArray(
      record.cursorRules,
      "spawnRequest.promptContext.cursorRules"
    ),
    skillOptions: normalizeNullableJsonObject(
      record.skillOptions,
      "spawnRequest.promptContext.skillOptions"
    ),
    selectedCursorRulePaths: normalizeUniqueText(
      record.selectedCursorRulePaths,
      "spawnRequest.promptContext.selectedCursorRulePaths"
    ),
    selectedCursorRuleNames: normalizeUniqueText(
      record.selectedCursorRuleNames,
      "spawnRequest.promptContext.selectedCursorRuleNames"
    ),
    activeCursorSkillNames: normalizeUniqueText(
      record.activeCursorSkillNames,
      "spawnRequest.promptContext.activeCursorSkillNames"
    ),
    cursorCommands: normalizeCursorCommands(record.cursorCommands),
    customSystemPrompt: requireNullableText(
      record.customSystemPrompt,
      "spawnRequest.promptContext.customSystemPrompt"
    ),
    hooksAdditionalContext: requireNullableText(
      record.hooksAdditionalContext,
      "spawnRequest.promptContext.hooksAdditionalContext"
    ),
    explicitContext: requireNullableText(
      record.explicitContext,
      "spawnRequest.promptContext.explicitContext"
    ),
  }
}

function normalizeProjectContext(
  value: unknown
): SubagentPromptContextSnapshot["projectContext"] {
  const record = requireExactObject(
    value,
    "spawnRequest.promptContext.projectContext",
    ["rootPath", "directories", "files", "workspaceFolders"]
  )
  return {
    rootPath: requireText(
      record.rootPath,
      "spawnRequest.promptContext.projectContext.rootPath"
    ),
    directories: normalizeTextArray(
      record.directories,
      "spawnRequest.promptContext.projectContext.directories"
    ),
    files: normalizeTextArray(
      record.files,
      "spawnRequest.promptContext.projectContext.files"
    ),
    workspaceFolders: requireArray(
      record.workspaceFolders,
      "spawnRequest.promptContext.projectContext.workspaceFolders"
    ).map((entry, index) => {
      const folder = requireExactObject(
        entry,
        `spawnRequest.promptContext.projectContext.workspaceFolders[${index}]`,
        ["uri", "path", "name"]
      )
      return {
        uri: requireText(
          folder.uri,
          `spawnRequest.promptContext.projectContext.workspaceFolders[${index}].uri`
        ),
        path: requireText(
          folder.path,
          `spawnRequest.promptContext.projectContext.workspaceFolders[${index}].path`
        ),
        name: requireText(
          folder.name,
          `spawnRequest.promptContext.projectContext.workspaceFolders[${index}].name`
        ),
      }
    }),
  }
}

function normalizeCodeChunks(
  value: unknown
): SubagentPromptContextSnapshot["codeChunks"] {
  return requireArray(value, "spawnRequest.promptContext.codeChunks").map(
    (entry, index) => {
      const record = requireExactObject(
        entry,
        `spawnRequest.promptContext.codeChunks[${index}]`,
        ["path", "content", "startLine", "endLine"]
      )
      return {
        path: requireText(
          record.path,
          `spawnRequest.promptContext.codeChunks[${index}].path`
        ),
        content: requireText(
          record.content,
          `spawnRequest.promptContext.codeChunks[${index}].content`,
          { allowEmpty: true }
        ),
        startLine: requireNullableFiniteNumber(
          record.startLine,
          `spawnRequest.promptContext.codeChunks[${index}].startLine`
        ),
        endLine: requireNullableFiniteNumber(
          record.endLine,
          `spawnRequest.promptContext.codeChunks[${index}].endLine`
        ),
      }
    }
  )
}

function normalizeCursorCommands(
  value: unknown
): SubagentPromptContextSnapshot["cursorCommands"] {
  const commands = requireArray(
    value,
    "spawnRequest.promptContext.cursorCommands"
  ).map((entry, index) => {
    const record = requireExactObject(
      entry,
      `spawnRequest.promptContext.cursorCommands[${index}]`,
      ["name", "content"]
    )
    return {
      name: requireText(
        record.name,
        `spawnRequest.promptContext.cursorCommands[${index}].name`
      ),
      content: requireText(
        record.content,
        `spawnRequest.promptContext.cursorCommands[${index}].content`,
        { allowEmpty: true }
      ),
    }
  })
  assertUnique(
    commands.map((command) => command.name),
    "cursor command names"
  )
  return commands
}

function normalizeTaskAttachments(
  value: unknown
): SubagentTaskAttachmentSnapshot {
  const record = requireExactObject(value, "spawnRequest.taskAttachments", [
    "images",
  ])
  return {
    images: requireArray(
      record.images,
      "spawnRequest.taskAttachments.images"
    ).map((entry, index) => {
      const image = requireExactObject(
        entry,
        `spawnRequest.taskAttachments.images[${index}]`,
        ["data", "mimeType", "width", "height"]
      )
      return {
        data: requireText(
          image.data,
          `spawnRequest.taskAttachments.images[${index}].data`
        ),
        mimeType: requireCanonicalIdentifier(
          image.mimeType,
          `spawnRequest.taskAttachments.images[${index}].mimeType`
        ),
        width: requireNullablePositiveSafeInteger(
          image.width,
          `spawnRequest.taskAttachments.images[${index}].width`
        ),
        height: requireNullablePositiveSafeInteger(
          image.height,
          `spawnRequest.taskAttachments.images[${index}].height`
        ),
      }
    }),
  }
}

function normalizeChildContextAttachmentSnapshot(
  value: unknown
): SubagentChildContextAttachmentSnapshot {
  const record = requireExactObject(
    value,
    "spawnRequest.childContextAttachmentSnapshot",
    ["readPaths", "fileStates", "todos", "sessionMemory", "activeSubAgents"]
  )
  const fileStates = requireArray(
    record.fileStates,
    "spawnRequest.childContextAttachmentSnapshot.fileStates"
  ).map((entry, index) => {
    const fileState = requireExactObject(
      entry,
      `spawnRequest.childContextAttachmentSnapshot.fileStates[${index}]`,
      ["path", "beforeContent", "afterContent"]
    )
    return {
      path: requireText(
        fileState.path,
        `spawnRequest.childContextAttachmentSnapshot.fileStates[${index}].path`
      ),
      beforeContent: requireText(
        fileState.beforeContent,
        `spawnRequest.childContextAttachmentSnapshot.fileStates[${index}].beforeContent`,
        { allowEmpty: true }
      ),
      afterContent: requireText(
        fileState.afterContent,
        `spawnRequest.childContextAttachmentSnapshot.fileStates[${index}].afterContent`,
        { allowEmpty: true }
      ),
    }
  })
  assertUnique(
    fileStates.map((fileState) => fileState.path),
    "child context file-state paths"
  )

  const todos = requireArray(
    record.todos,
    "spawnRequest.childContextAttachmentSnapshot.todos"
  ).map((entry, index) => {
    const todo = requireExactObject(
      entry,
      `spawnRequest.childContextAttachmentSnapshot.todos[${index}]`,
      ["id", "content", "status", "dependencies"]
    )
    return {
      id: requireCanonicalIdentifier(
        todo.id,
        `spawnRequest.childContextAttachmentSnapshot.todos[${index}].id`
      ),
      content: requireText(
        todo.content,
        `spawnRequest.childContextAttachmentSnapshot.todos[${index}].content`
      ),
      status: requireEnum(
        todo.status,
        SESSION_TODO_STATUS_SET,
        `spawnRequest.childContextAttachmentSnapshot.todos[${index}].status`
      ) as SessionTodoStatus,
      dependencies: normalizeUniqueCanonicalIdentifiers(
        todo.dependencies,
        `spawnRequest.childContextAttachmentSnapshot.todos[${index}].dependencies`
      ),
    }
  })
  assertUnique(
    todos.map((todo) => todo.id),
    "child context todo ids"
  )

  const sessionMemory = requireArray(
    record.sessionMemory,
    "spawnRequest.childContextAttachmentSnapshot.sessionMemory"
  ).map((entry, index) => {
    const memory = requireExactObject(
      entry,
      `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}]`,
      [
        "kind",
        "text",
        "createdAt",
        "weight",
        "sourceToolUseId",
        "sourceRecordUuid",
        "sourceKind",
      ]
    )
    const kind = requireEnum(
      memory.kind,
      MEMORY_KINDS,
      `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].kind`
    ) as SubagentChildContextAttachmentSnapshot["sessionMemory"][number]["kind"]
    const sourceKind = requireEnum(
      memory.sourceKind,
      new Set(["tool_result", "control_notification"]),
      `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].sourceKind`
    ) as "tool_result" | "control_notification"
    return {
      kind,
      text: requireText(
        memory.text,
        `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].text`
      ),
      createdAt: requireNullableNonNegativeSafeInteger(
        memory.createdAt,
        `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].createdAt`
      ),
      weight: requireNullableFiniteNumber(
        memory.weight,
        `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].weight`
      ),
      sourceToolUseId: requireCanonicalIdentifier(
        memory.sourceToolUseId,
        `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].sourceToolUseId`
      ),
      sourceRecordUuid: requireCanonicalIdentifier(
        memory.sourceRecordUuid,
        `spawnRequest.childContextAttachmentSnapshot.sessionMemory[${index}].sourceRecordUuid`
      ),
      sourceKind,
    }
  })

  const activeSubAgents = requireArray(
    record.activeSubAgents,
    "spawnRequest.childContextAttachmentSnapshot.activeSubAgents"
  ).map((entry, index) => {
    const agent = requireExactObject(
      entry,
      `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}]`,
      [
        "subagentId",
        "model",
        "turnCount",
        "toolCallCount",
        "modifiedFiles",
        "pendingToolCallIds",
      ]
    )
    return {
      subagentId: requireCanonicalIdentifier(
        agent.subagentId,
        `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}].subagentId`
      ),
      model: requireCanonicalIdentifier(
        agent.model,
        `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}].model`
      ),
      turnCount: requireNonNegativeSafeInteger(
        agent.turnCount,
        `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}].turnCount`
      ),
      toolCallCount: requireNonNegativeSafeInteger(
        agent.toolCallCount,
        `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}].toolCallCount`
      ),
      modifiedFiles: normalizeUniqueText(
        agent.modifiedFiles,
        `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}].modifiedFiles`
      ),
      pendingToolCallIds: normalizeUniqueCanonicalIdentifiers(
        agent.pendingToolCallIds,
        `spawnRequest.childContextAttachmentSnapshot.activeSubAgents[${index}].pendingToolCallIds`
      ),
    }
  })
  assertUnique(
    activeSubAgents.map((agent) => agent.subagentId),
    "child context active subagent ids"
  )

  return {
    readPaths: normalizeUniqueText(
      record.readPaths,
      "spawnRequest.childContextAttachmentSnapshot.readPaths"
    ),
    fileStates,
    todos,
    sessionMemory,
    activeSubAgents,
  }
}

function normalizeWorkspaceScope(value: unknown): WorkspaceScope {
  try {
    return WorkspaceScope.fromFrozenSnapshot(value)
  } catch (error) {
    if (error instanceof WorkspaceScopeError) {
      throw new Error(`SubagentSpawnRequest: ${error.message}`)
    }
    throw error
  }
}

/**
 * The child prompt may display IDE folders, but it cannot define filesystem
 * authority. Bind that display payload exactly to the frozen scope so a
 * session/config grant can never masquerade as an IDE project folder.
 */
function assertPromptContextMatchesWorkspace(
  promptContext: SubagentPromptContextSnapshot,
  scope: WorkspaceScope
): void {
  const projectContext = promptContext.projectContext
  const expectedIdeRoots = scope.primaryFirstIdeRoots

  if (projectContext.rootPath !== scope.primaryRoot) {
    fail(
      "spawnRequest.promptContext.projectContext.rootPath",
      "must equal spawnRequest.workspace.primaryRoot"
    )
  }
  assertExactOrderedPaths(
    projectContext.directories,
    expectedIdeRoots,
    "spawnRequest.promptContext.projectContext.directories"
  )
  if (projectContext.files.length !== 0) {
    fail(
      "spawnRequest.promptContext.projectContext.files",
      "must be empty because child project presentation is derived only from the frozen workspace"
    )
  }
  if (projectContext.workspaceFolders.length !== expectedIdeRoots.length) {
    fail(
      "spawnRequest.promptContext.projectContext.workspaceFolders",
      "must exactly represent frozen IDE roots"
    )
  }

  for (let index = 0; index < expectedIdeRoots.length; index += 1) {
    const expectedRoot = expectedIdeRoots[index]!
    const folder = projectContext.workspaceFolders[index]
    if (!folder || folder.path !== expectedRoot) {
      fail(
        `spawnRequest.promptContext.projectContext.workspaceFolders[${index}].path`,
        "must equal the corresponding frozen IDE root"
      )
    }
    if (!scope.contains(folder.path)) {
      fail(
        `spawnRequest.promptContext.projectContext.workspaceFolders[${index}].path`,
        "must be inside the frozen workspace authority"
      )
    }
    if (folder.uri !== pathToFileURL(expectedRoot).toString()) {
      fail(
        `spawnRequest.promptContext.projectContext.workspaceFolders[${index}].uri`,
        "must equal the canonical file URI for its frozen IDE root"
      )
    }
  }
}

function assertExactOrderedPaths(
  actual: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    fail(
      label,
      "must exactly represent frozen IDE roots in primary-first order"
    )
  }
}

function normalizeRequestEnvironment(
  value: unknown
): SubagentSpawnRequest["requestEnvironment"] {
  const record = requireExactObject(value, "spawnRequest.requestEnvironment", [
    "terminalsFolder",
    "projectFolder",
    "shell",
    "timeZone",
    "agentTranscriptsFolder",
    "artifactsFolder",
  ])
  return {
    terminalsFolder: requireNullableNonEmptyText(
      record.terminalsFolder,
      "spawnRequest.requestEnvironment.terminalsFolder"
    ),
    projectFolder: requireNullableNonEmptyText(
      record.projectFolder,
      "spawnRequest.requestEnvironment.projectFolder"
    ),
    shell: requireNullableNonEmptyText(
      record.shell,
      "spawnRequest.requestEnvironment.shell"
    ),
    timeZone: requireNullableNonEmptyText(
      record.timeZone,
      "spawnRequest.requestEnvironment.timeZone"
    ),
    agentTranscriptsFolder: requireNullableNonEmptyText(
      record.agentTranscriptsFolder,
      "spawnRequest.requestEnvironment.agentTranscriptsFolder"
    ),
    artifactsFolder: requireNullableNonEmptyText(
      record.artifactsFolder,
      "spawnRequest.requestEnvironment.artifactsFolder"
    ),
  }
}

function normalizeToolContract(value: unknown): SubagentToolContract {
  const record = requireExactObject(value, "spawnRequest.toolContract", [
    "version",
    "fingerprint",
    "tools",
    "mcpRegistry",
  ])
  const content = normalizeToolContractContent(
    {
      version: record.version,
      tools: record.tools,
      mcpRegistry: record.mcpRegistry,
    },
    "spawnRequest.toolContract"
  )
  const fingerprint = requireFingerprint(
    record.fingerprint,
    "spawnRequest.toolContract.fingerprint"
  )
  const expectedFingerprint = fingerprintToolContractContent(content)
  if (fingerprint !== expectedFingerprint) {
    fail(
      "spawnRequest.toolContract.fingerprint",
      "does not match the canonical tool contract"
    )
  }
  return {
    ...content,
    fingerprint,
  }
}

/**
 * Return the digest production spawn construction must place in
 * `toolContract.fingerprint`. It normalizes the same complete payload that
 * store reads and writes validate, so callers cannot hash a partial adapter
 * projection by accident.
 */
export function computeSubagentToolContractFingerprint(
  value: SubagentToolContractFingerprintInput
): string {
  return fingerprintToolContractContent(
    normalizeToolContractContent(value, "toolContract")
  )
}

function normalizeToolContractContent(
  value: unknown,
  label: string
): SubagentToolContractFingerprintInput {
  const record = requireExactObject(value, label, [
    "version",
    "tools",
    "mcpRegistry",
  ])
  if (record.version !== 2) {
    fail(`${label}.version`, "must equal 2")
  }
  const tools = requireArray(record.tools, `${label}.tools`).map(
    (entry, index) => normalizeToolContractEntry(entry, index, `${label}.tools`)
  )
  assertUnique(
    tools.map((tool) => tool.name),
    `${label} tool names`
  )
  assertUnique(
    tools.map((tool) => tool.capabilityId),
    `${label} tool capability ids`
  )
  const mcpRegistry = normalizeMcpRegistry(
    record.mcpRegistry,
    `${label}.mcpRegistry`
  )
  assertMcpToolContractBindings(tools, mcpRegistry, label)
  return {
    version: 2,
    tools,
    mcpRegistry,
  }
}

function normalizeToolContractEntry(
  value: unknown,
  index: number,
  collectionLabel: string
): SubagentToolContractEntry {
  const label = `${collectionLabel}[${index}]`
  const record = requireExactObject(value, label, [
    "capabilityId",
    "kind",
    "name",
    "description",
    "schemaDialect",
    "strict",
    "inputSchema",
    "schemaSha256",
    "executionOwners",
  ])
  const identity = normalizeToolCapabilityIdentity(
    {
      kind: record.kind,
      name: record.name,
      description: record.description,
      schemaDialect: record.schemaDialect,
      strict: record.strict,
      inputSchema: record.inputSchema,
      schemaSha256: record.schemaSha256,
      executionOwners: record.executionOwners,
    },
    label
  )
  const capabilityId = requireFingerprint(
    record.capabilityId,
    `${label}.capabilityId`
  )
  const expectedCapabilityId = computeSubagentToolCapabilityId(identity)
  if (capabilityId !== expectedCapabilityId) {
    fail(
      `${label}.capabilityId`,
      "does not match the canonical tool capability identity"
    )
  }
  return {
    capabilityId,
    ...identity,
  }
}

/**
 * Return the schema digest production spawn construction must freeze beside
 * every tool. The digest is calculated over canonical JSON rather than a
 * provider renderer so recovery cannot silently accept a schema drift.
 */
export function computeSubagentToolInputSchemaSha256(
  value: SubagentSpawnJsonObject
): string {
  return sha256CanonicalJson(requireJsonObject(value, "toolInputSchema"))
}

/**
 * Return the stable, content-addressed identity for one compiled child
 * capability. `capabilityId` itself is intentionally absent from this input.
 */
export function computeSubagentToolCapabilityId(
  value: SubagentToolCapabilityIdentityInput
): string {
  const identity = normalizeToolCapabilityIdentity(value, "toolCapability")
  return sha256CanonicalJson(toolCapabilityIdentityJson(identity))
}

function normalizeToolCapabilityIdentity(
  value: unknown,
  label: string
): SubagentToolCapabilityIdentityInput {
  const record = requireExactObject(value, label, [
    "kind",
    "name",
    "description",
    "schemaDialect",
    "strict",
    "inputSchema",
    "schemaSha256",
    "executionOwners",
  ])
  if (record.kind !== "function") {
    fail(`${label}.kind`, "must equal function")
  }
  if (record.schemaDialect !== "json-schema") {
    fail(`${label}.schemaDialect`, "must equal json-schema")
  }
  const inputSchema = requireJsonObject(
    record.inputSchema,
    `${label}.inputSchema`
  )
  const schemaSha256 = requireFingerprint(
    record.schemaSha256,
    `${label}.schemaSha256`
  )
  const expectedSchemaSha256 = computeSubagentToolInputSchemaSha256(inputSchema)
  if (schemaSha256 !== expectedSchemaSha256) {
    fail(`${label}.schemaSha256`, "does not match the canonical input schema")
  }
  return {
    kind: "function",
    name: requireCanonicalIdentifier(record.name, `${label}.name`),
    description: requireText(record.description, `${label}.description`),
    schemaDialect: "json-schema",
    strict: requireBoolean(record.strict, `${label}.strict`),
    inputSchema,
    schemaSha256,
    executionOwners: normalizeToolExecutionOwners(
      record.executionOwners,
      `${label}.executionOwners`
    ),
  }
}

function normalizeToolExecutionOwners(
  value: unknown,
  label: string
): SubagentToolExecutionOwners {
  const record = requireExactObject(value, label, ["foreground", "background"])
  const foreground =
    record.foreground === null
      ? null
      : normalizeToolExecutionOwner(record.foreground, `${label}.foreground`)
  const background =
    record.background === null
      ? null
      : normalizeToolExecutionOwner(record.background, `${label}.background`)
  if (foreground === null && background === null) {
    fail(label, "must define a foreground or background execution owner")
  }
  if (
    background?.kind === "cursor-client" ||
    background?.kind === "mcp-client" ||
    background?.kind === "cursor-interaction-query"
  ) {
    fail(
      `${label}.background.kind`,
      "must not be cursor-client, cursor-interaction-query, or mcp-client"
    )
  }
  return { foreground, background }
}

function normalizeToolExecutionOwner(
  value: unknown,
  label: string
): SubagentToolExecutionOwner {
  const record = requirePlainObject(value, label)
  const kind = record.kind
  if (kind === "bridge-inline") {
    const inline = requireExactObject(value, label, ["kind", "operation"])
    const operation = requireEnum(
      inline.operation,
      new Set(SUBAGENT_BRIDGE_INLINE_OPERATIONS),
      `${label}.operation`
    ) as SubagentBridgeInlineOperation
    return {
      kind: "bridge-inline",
      operation,
    }
  }
  if (kind === "bridge-deferred") {
    const deferred = requireExactObject(value, label, ["kind", "family"])
    const family = requireEnum(
      deferred.family,
      new Set(SUBAGENT_BRIDGE_DEFERRED_FAMILIES),
      `${label}.family`
    ) as SubagentBridgeDeferredFamily
    return { kind: "bridge-deferred", family }
  }
  if (kind === "cursor-client") {
    const cursor = requireExactObject(value, label, [
      "kind",
      "cursorDefinitionKey",
      "protocolToolName",
      "execProtocol",
    ])
    const owner: Extract<
      SubagentToolExecutionOwner,
      { readonly kind: "cursor-client" }
    > = {
      kind: "cursor-client",
      cursorDefinitionKey: requireCanonicalIdentifier(
        cursor.cursorDefinitionKey,
        `${label}.cursorDefinitionKey`
      ),
      protocolToolName: requireCanonicalIdentifier(
        cursor.protocolToolName,
        `${label}.protocolToolName`
      ),
      execProtocol: normalizeSubagentExecProtocol(
        cursor.execProtocol,
        `${label}.execProtocol`
      ),
    }
    try {
      assertFrozenSubagentExecProtocolOwnerBinding(owner)
    } catch (error) {
      fail(
        `${label}.execProtocol`,
        error instanceof Error ? error.message : String(error)
      )
    }
    return owner
  }
  if (kind === "cursor-interaction-query") {
    const interactionQuery = requireExactObject(value, label, [
      "kind",
      "cursorDefinitionKey",
      "protocolToolName",
      "queryCase",
      "responseCase",
    ])
    const cursorDefinitionKey = requireCanonicalIdentifier(
      interactionQuery.cursorDefinitionKey,
      `${label}.cursorDefinitionKey`
    )
    const protocolToolName = requireCanonicalIdentifier(
      interactionQuery.protocolToolName,
      `${label}.protocolToolName`
    )
    const queryCase = interactionQuery.queryCase
    const responseCase = interactionQuery.responseCase
    if (queryCase !== "createPlanRequestQuery") {
      fail(`${label}.queryCase`, "must equal createPlanRequestQuery")
    }
    if (responseCase !== "createPlanRequestResponse") {
      fail(`${label}.responseCase`, "must equal createPlanRequestResponse")
    }
    return {
      kind: "cursor-interaction-query",
      cursorDefinitionKey,
      protocolToolName,
      queryCase,
      responseCase,
    }
  }
  if (kind === "mcp-client") {
    const mcp = requireExactObject(value, label, [
      "kind",
      "providerIdentifier",
      "toolName",
      "ideRegistryKey",
      "definitionName",
      "modelToolName",
      "execProtocol",
    ])
    const owner: Extract<
      SubagentToolExecutionOwner,
      { readonly kind: "mcp-client" }
    > = {
      kind: "mcp-client",
      providerIdentifier: requireCanonicalIdentifier(
        mcp.providerIdentifier,
        `${label}.providerIdentifier`
      ),
      toolName: requireCanonicalIdentifier(mcp.toolName, `${label}.toolName`),
      ideRegistryKey: requireCanonicalIdentifier(
        mcp.ideRegistryKey,
        `${label}.ideRegistryKey`
      ),
      definitionName: requireCanonicalIdentifier(
        mcp.definitionName,
        `${label}.definitionName`
      ),
      modelToolName: requireCanonicalIdentifier(
        mcp.modelToolName,
        `${label}.modelToolName`
      ),
      execProtocol: normalizeSubagentExecProtocol(
        mcp.execProtocol,
        `${label}.execProtocol`
      ),
    }
    try {
      assertFrozenSubagentExecProtocolOwnerBinding(owner)
    } catch (error) {
      fail(
        `${label}.execProtocol`,
        error instanceof Error ? error.message : String(error)
      )
    }
    return owner
  }
  fail(
    `${label}.kind`,
    "must be bridge-inline, bridge-deferred, cursor-client, cursor-interaction-query, or mcp-client"
  )
}

function normalizeSubagentExecProtocol(
  value: unknown,
  label: string
): SubagentExecProtocol {
  const record = requireExactObject(value, label, ["requestCase", "terminal"])
  const terminal = requireExactObject(record.terminal, `${label}.terminal`, [
    "transport",
    "resultCase",
  ])
  if (terminal.transport !== "single") {
    fail(`${label}.terminal.transport`, "must equal single")
  }

  switch (record.requestCase) {
    case "writeArgs":
      if (terminal.resultCase !== "writeResult") {
        fail(
          `${label}.terminal.resultCase`,
          "must equal writeResult for writeArgs"
        )
      }
      return {
        requestCase: "writeArgs",
        terminal: { transport: "single", resultCase: "writeResult" },
      }
    case "deleteArgs":
      if (terminal.resultCase !== "deleteResult") {
        fail(
          `${label}.terminal.resultCase`,
          "must equal deleteResult for deleteArgs"
        )
      }
      return {
        requestCase: "deleteArgs",
        terminal: { transport: "single", resultCase: "deleteResult" },
      }
    case "mcpArgs":
      if (terminal.resultCase !== "mcpResult") {
        fail(`${label}.terminal.resultCase`, "must equal mcpResult for mcpArgs")
      }
      return {
        requestCase: "mcpArgs",
        terminal: { transport: "single", resultCase: "mcpResult" },
      }
    default:
      fail(
        `${label}.requestCase`,
        "must equal writeArgs, deleteArgs, or mcpArgs"
      )
  }
}

function normalizeMcpRegistry(
  value: unknown,
  label: string
): readonly SubagentMcpRegistryServerScope[] {
  const servers = requireArray(value, label).map((entry, index) => {
    const serverLabel = `${label}[${index}]`
    const record = requireExactObject(entry, serverLabel, [
      "providerIdentifier",
      "ideRegistryKey",
      "tools",
    ])
    const tools = requireArray(record.tools, `${serverLabel}.tools`).map(
      (tool, toolIndex) =>
        normalizeMcpRegistryTool(tool, `${serverLabel}.tools[${toolIndex}]`)
    )
    assertUnique(
      tools.map((tool) => tool.definitionName),
      `${serverLabel} MCP definition names`
    )
    assertUnique(
      tools.map((tool) => tool.modelToolName),
      `${serverLabel} model MCP tool names`
    )
    assertUnique(
      tools.map((tool) => tool.toolName),
      `${serverLabel} MCP tool names`
    )
    return {
      providerIdentifier: requireCanonicalIdentifier(
        record.providerIdentifier,
        `${serverLabel}.providerIdentifier`
      ),
      ideRegistryKey: requireCanonicalIdentifier(
        record.ideRegistryKey,
        `${serverLabel}.ideRegistryKey`
      ),
      tools,
    }
  })
  assertUnique(
    servers.map((server) => server.providerIdentifier),
    `${label} provider identifiers`
  )
  assertUnique(
    servers.map((server) => server.ideRegistryKey),
    `${label} IDE registry keys`
  )
  assertUnique(
    servers.flatMap((server) => server.tools.map((tool) => tool.modelToolName)),
    `${label} model MCP tool names`
  )
  assertUnique(
    servers.flatMap((server) => server.tools.map((tool) => tool.capabilityId)),
    `${label} MCP capability ids`
  )
  return servers
}

function normalizeMcpRegistryTool(
  value: unknown,
  label: string
): SubagentMcpRegistryTool {
  const record = requireExactObject(value, label, [
    "capabilityId",
    "definitionName",
    "modelToolName",
    "toolName",
    "description",
    "schemaSha256",
    "inputSchema",
  ])
  const inputSchema = requireJsonObject(
    record.inputSchema,
    `${label}.inputSchema`
  )
  const schemaSha256 = requireFingerprint(
    record.schemaSha256,
    `${label}.schemaSha256`
  )
  const expectedSchemaSha256 = computeSubagentToolInputSchemaSha256(inputSchema)
  if (schemaSha256 !== expectedSchemaSha256) {
    fail(`${label}.schemaSha256`, "does not match the canonical input schema")
  }
  return {
    capabilityId: requireFingerprint(
      record.capabilityId,
      `${label}.capabilityId`
    ),
    definitionName: requireCanonicalIdentifier(
      record.definitionName,
      `${label}.definitionName`
    ),
    modelToolName: requireCanonicalIdentifier(
      record.modelToolName,
      `${label}.modelToolName`
    ),
    toolName: requireCanonicalIdentifier(record.toolName, `${label}.toolName`),
    description: requireText(record.description, `${label}.description`),
    schemaSha256,
    inputSchema,
  }
}

function assertMcpToolContractBindings(
  tools: readonly SubagentToolContractEntry[],
  mcpRegistry: readonly SubagentMcpRegistryServerScope[],
  label: string
): void {
  const registryTools = new Map<string, SubagentMcpRegistryTool>()
  for (const server of mcpRegistry) {
    for (const tool of server.tools) {
      registryTools.set(
        mcpRegistryToolKey({
          capabilityId: tool.capabilityId,
          providerIdentifier: server.providerIdentifier,
          ideRegistryKey: server.ideRegistryKey,
          toolName: tool.toolName,
          definitionName: tool.definitionName,
          modelToolName: tool.modelToolName,
        }),
        tool
      )
    }
  }

  const boundRegistryKeys: string[] = []
  for (const tool of tools) {
    const owner = tool.executionOwners.foreground
    if (owner?.kind !== "mcp-client") continue
    if (owner.modelToolName !== tool.name) {
      fail(
        `${label}.tools.${tool.name}.executionOwners.foreground.modelToolName`,
        "must equal the tool contract name"
      )
    }
    const key = mcpRegistryToolKey({
      capabilityId: tool.capabilityId,
      ...owner,
    })
    const registered = registryTools.get(key)
    if (!registered) {
      fail(
        `${label}.tools.${tool.name}.executionOwners.foreground`,
        "does not resolve to a frozen MCP registry tool"
      )
    }
    if (
      registered.capabilityId !== tool.capabilityId ||
      registered.description !== tool.description ||
      registered.schemaSha256 !== tool.schemaSha256 ||
      canonicalJsonStringify(registered.inputSchema) !==
        canonicalJsonStringify(tool.inputSchema)
    ) {
      fail(
        `${label}.tools.${tool.name}.executionOwners.foreground`,
        "does not match its frozen MCP registry definition"
      )
    }
    boundRegistryKeys.push(key)
  }

  if (
    boundRegistryKeys.length !== registryTools.size ||
    new Set(boundRegistryKeys).size !== boundRegistryKeys.length
  ) {
    fail(
      `${label}.mcpRegistry`,
      "must have one concrete mcp-client tool contract entry for every visible MCP tool"
    )
  }
}

function mcpRegistryToolKey(
  value: Pick<
    Extract<SubagentToolExecutionOwner, { kind: "mcp-client" }>,
    | "providerIdentifier"
    | "ideRegistryKey"
    | "toolName"
    | "definitionName"
    | "modelToolName"
  > & { readonly capabilityId: string }
): string {
  return JSON.stringify([
    value.capabilityId,
    value.providerIdentifier,
    value.ideRegistryKey,
    value.toolName,
    value.definitionName,
    value.modelToolName,
  ])
}

function fingerprintToolContractContent(
  content: SubagentToolContractFingerprintInput
): string {
  const payload: SubagentSpawnJsonObject = {
    version: content.version,
    tools: content.tools.map((tool) => ({
      capabilityId: tool.capabilityId,
      kind: tool.kind,
      name: tool.name,
      description: tool.description,
      schemaDialect: tool.schemaDialect,
      strict: tool.strict,
      inputSchema: tool.inputSchema,
      schemaSha256: tool.schemaSha256,
      executionOwners: toolExecutionOwnersJson(tool.executionOwners),
    })),
    mcpRegistry: content.mcpRegistry.map((server) => ({
      providerIdentifier: server.providerIdentifier,
      ideRegistryKey: server.ideRegistryKey,
      tools: server.tools.map((tool) => ({
        capabilityId: tool.capabilityId,
        definitionName: tool.definitionName,
        modelToolName: tool.modelToolName,
        toolName: tool.toolName,
        description: tool.description,
        schemaSha256: tool.schemaSha256,
        inputSchema: tool.inputSchema,
      })),
    })),
  }
  return sha256CanonicalJson(payload)
}

function toolExecutionOwnersJson(
  value: SubagentToolExecutionOwners
): SubagentSpawnJsonObject {
  return {
    foreground:
      value.foreground === null
        ? null
        : toolExecutionOwnerJson(value.foreground),
    background:
      value.background === null
        ? null
        : toolExecutionOwnerJson(value.background),
  }
}

function toolExecutionOwnerJson(
  value: SubagentToolExecutionOwner
): SubagentSpawnJsonObject {
  switch (value.kind) {
    case "bridge-inline":
      return { kind: value.kind, operation: value.operation }
    case "bridge-deferred":
      return { kind: value.kind, family: value.family }
    case "cursor-client":
      return {
        kind: value.kind,
        cursorDefinitionKey: value.cursorDefinitionKey,
        protocolToolName: value.protocolToolName,
        execProtocol: {
          requestCase: value.execProtocol.requestCase,
          terminal: {
            transport: value.execProtocol.terminal.transport,
            resultCase: value.execProtocol.terminal.resultCase,
          },
        },
      }
    case "cursor-interaction-query":
      return {
        kind: value.kind,
        cursorDefinitionKey: value.cursorDefinitionKey,
        protocolToolName: value.protocolToolName,
        queryCase: value.queryCase,
        responseCase: value.responseCase,
      }
    case "mcp-client":
      return {
        kind: value.kind,
        providerIdentifier: value.providerIdentifier,
        toolName: value.toolName,
        ideRegistryKey: value.ideRegistryKey,
        definitionName: value.definitionName,
        modelToolName: value.modelToolName,
        execProtocol: {
          requestCase: value.execProtocol.requestCase,
          terminal: {
            transport: value.execProtocol.terminal.transport,
            resultCase: value.execProtocol.terminal.resultCase,
          },
        },
      }
  }
}

function toolCapabilityIdentityJson(
  value: SubagentToolCapabilityIdentityInput
): SubagentSpawnJsonObject {
  return {
    kind: value.kind,
    name: value.name,
    description: value.description,
    schemaDialect: value.schemaDialect,
    strict: value.strict,
    inputSchema: value.inputSchema,
    schemaSha256: value.schemaSha256,
    executionOwners: toolExecutionOwnersJson(value.executionOwners),
  }
}

function sha256CanonicalJson(value: SubagentSpawnJsonValue): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value))
    .digest("hex")}`
}

function canonicalJsonStringify(value: SubagentSpawnJsonValue): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "SubagentSpawnRequest: canonical JSON received non-finite number"
      )
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const arrayValue = value as readonly SubagentSpawnJsonValue[]
    return `[${arrayValue
      .map((entry) => canonicalJsonStringify(entry))
      .join(",")}]`
  }
  const objectValue = value as SubagentSpawnJsonObject
  return `{${Object.keys(objectValue)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonStringify(objectValue[key]!)}`
    )
    .join(",")}}`
}

function normalizeJsonObjectArray(
  value: unknown,
  label: string
): readonly SubagentSpawnJsonObject[] {
  return requireArray(value, label).map((entry, index) =>
    requireJsonObject(entry, `${label}[${index}]`)
  )
}

function normalizeNullableJsonObject(
  value: unknown,
  label: string
): SubagentSpawnJsonObject | null {
  return value === null ? null : requireJsonObject(value, label)
}

function requireJsonObject(
  value: unknown,
  label: string
): SubagentSpawnJsonObject {
  const cloned = cloneJsonValue(value, label, {
    nodes: 0,
    ancestors: new Set<object>(),
  })
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    fail(label, "must be a JSON object")
  }
  return cloned as SubagentSpawnJsonObject
}

function cloneJsonValue(
  value: unknown,
  label: string,
  state: { nodes: number; ancestors: Set<object> },
  depth: number = 0
): SubagentSpawnJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    fail(label, `exceeds JSON nesting depth ${MAX_JSON_DEPTH}`)
  }
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODES) {
    fail(label, `exceeds JSON node limit ${MAX_JSON_NODES}`)
  }
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(label, "contains a non-finite number")
    }
    return value
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(label, "must be a plain JSON array")
    }
    assertOnlyJsonArrayProperties(value, label)
    if (state.ancestors.has(value)) {
      fail(label, "contains a cycle")
    }
    state.ancestors.add(value)
    const copied = value.map((entry, index) =>
      cloneJsonValue(entry, `${label}[${index}]`, state, depth + 1)
    )
    state.ancestors.delete(value)
    return copied
  }
  if (!value || typeof value !== "object") {
    fail(label, "contains a non-JSON value")
  }
  const record = requirePlainObject(value, label)
  if (state.ancestors.has(record)) {
    fail(label, "contains a cycle")
  }
  state.ancestors.add(record)
  const copied: Record<string, SubagentSpawnJsonValue> = {}
  for (const key of assertOnlyJsonObjectProperties(record, label)) {
    Object.defineProperty(copied, key, {
      value: cloneJsonValue(record[key], `${label}.${key}`, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  state.ancestors.delete(record)
  return copied
}

function requireExactStringRecord(
  value: unknown,
  label: string
): Readonly<Record<string, string>> {
  const record = requirePlainObject(value, label)
  const result: Record<string, string> = {}
  for (const key of assertOnlyJsonObjectProperties(record, label)) {
    const canonicalKey = requireCanonicalIdentifier(key, `${label} key`)
    Object.defineProperty(result, canonicalKey, {
      value: requireText(record[key], `${label}.${canonicalKey}`, {
        allowEmpty: true,
      }),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return result
}

/**
 * Preserve user-visible text and paths exactly. A final space can be part of
 * a POSIX path or display name, so this helper validates without normalizing.
 */
function normalizeTextArray(value: unknown, label: string): readonly string[] {
  return requireArray(value, label).map((entry, index) =>
    requireText(entry, `${label}[${index}]`)
  )
}

function normalizeUniqueText(value: unknown, label: string): readonly string[] {
  const values = normalizeTextArray(value, label)
  assertUnique(values, label)
  return values
}

function normalizeCanonicalIdentifierArray(
  value: unknown,
  label: string
): readonly string[] {
  return requireArray(value, label).map((entry, index) =>
    requireCanonicalIdentifier(entry, `${label}[${index}]`)
  )
}

function normalizeUniqueCanonicalIdentifiers(
  value: unknown,
  label: string
): readonly string[] {
  const values = normalizeCanonicalIdentifierArray(value, label)
  assertUnique(values, label)
  return values
}

function requireArray(value: unknown, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(label, "must be a plain array")
  }
  assertOnlyJsonArrayProperties(value, label)
  return value
}

function requireExactObject(
  value: unknown,
  label: string,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  const record = requirePlainObject(value, label)
  const actualKeys = assertOnlyJsonObjectProperties(record, label)
  const expected = new Set(expectedKeys)
  const unsupported = actualKeys.filter((key) => !expected.has(key))
  const missing = expectedKeys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key)
  )
  if (unsupported.length > 0 || missing.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unsupported.length > 0
        ? [`unsupported ${unsupported.join(", ")}`]
        : []),
    ]
    fail(label, `has ${details.join("; ")} field(s)`)
  }
  return record
}

function requirePlainObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(label, "must be a plain object")
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail(label, "must be a plain object")
  }
  return value as Record<string, unknown>
}

function assertOnlyJsonObjectProperties(
  value: Record<string, unknown>,
  label: string
): string[] {
  const keys: string[] = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail(label, "contains a symbol property")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(label, `contains a non-JSON property ${JSON.stringify(key)}`)
    }
    keys.push(key)
  }
  return keys
}

function assertOnlyJsonArrayProperties(value: unknown[], label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
      fail(label, "contains a non-index array property")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(label, `contains a non-JSON array property ${JSON.stringify(key)}`)
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(label, `contains an array hole at index ${index}`)
    }
  }
}

/**
 * Canonical protocol/storage identities are exact opaque keys. Never trim
 * them: trimming an already-persisted value would silently repair corruption
 * and could change which durable object a caller addresses.
 */
function requireCanonicalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail(label, "must be a string")
  }
  if (!value || value.trim() !== value || value.includes("\u0000")) {
    fail(
      label,
      "must be a canonical non-empty string without surrounding whitespace"
    )
  }
  return value
}

function requireText(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string") {
    fail(label, "must be a string")
  }
  if (value.includes("\u0000") || (!options.allowEmpty && !value.trim())) {
    fail(label, "must be a non-empty string")
  }
  return value
}

function requireNullableText(value: unknown, label: string): string | null {
  return value === null ? null : requireText(value, label, { allowEmpty: true })
}

/** `null` is absence in the durable env snapshot; present values are exact. */
function requireNullableNonEmptyText(
  value: unknown,
  label: string
): string | null {
  return value === null ? null : requireText(value, label)
}

function requireFingerprint(value: unknown, label: string): string {
  const fingerprint = requireCanonicalIdentifier(value, label)
  if (!SHA256_FINGERPRINT.test(fingerprint)) {
    fail(label, "must be a sha256:<lowercase-hex> fingerprint")
  }
  return fingerprint
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    fail(label, "must be a boolean")
  }
  return value
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(label, "must be a positive safe integer")
  }
  return value as number
}

function requireNullablePositiveSafeInteger(
  value: unknown,
  label: string
): number | null {
  return value === null ? null : requirePositiveSafeInteger(value, label)
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(label, "must be a non-negative safe integer")
  }
  return value as number
}

function requireThinkingLevel(value: unknown, label: string): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value
  fail(label, "must equal 0, 1, or 2")
}

function requireNullableNonNegativeSafeInteger(
  value: unknown,
  label: string
): number | null {
  return value === null ? null : requireNonNegativeSafeInteger(value, label)
}

function requireNullableFiniteNumber(
  value: unknown,
  label: string
): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(label, "must be a finite number or null")
  }
  return value
}

function requireEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(label, `must be one of ${[...allowed].join(", ")}`)
  }
  return value
}

function requireNullableEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): string | null {
  return value === null ? null : requireEnum(value, allowed, label)
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail(label, "must not contain duplicates")
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeDeep(nested)
    }
    Object.freeze(value)
  }
  return value
}

function fail(label: string, message: string): never {
  throw new Error(`SubagentSpawnRequest: ${label} ${message}`)
}
