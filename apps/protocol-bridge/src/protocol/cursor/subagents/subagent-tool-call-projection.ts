/**
 * Immutable child-capability to Cursor ToolCall projection.
 *
 * This module is intentionally pure: it does not inspect a live session,
 * model-emitted tool name, MCP registry, or dispatch handler.  Both the gRPC
 * encoder and the durable graph reducer use this one mapping so a persisted
 * ToolCall cannot claim a different Cursor oneof case after recovery.
 */

import {
  assertFrozenSubagentExecProtocolOwnerBinding,
  type SubagentToolContractEntry,
  type SubagentToolExecutionOwner,
} from "../session/subagent-spawn-request"
import { getFrozenCursorToolDefinition } from "../tools/cursor-tool-mapper"
import type { ToolCall } from "../../../gen/agent/v1_pb"

export type FrozenSubagentCursorToolFamily =
  | "get_mcp_tools"
  | "read_mcp_resource"
  | "list_mcp_resources"
  | "read_lints"
  | "read_todos"
  | "update_todos"
  | "web_search"
  | "web_fetch"
  | "exa_search"
  | "exa_fetch"
  | "create_plan"
  | "sem_search"
  | "reflect"
  | "read"
  | "edit"
  | "ls"
  | "delete"
  | "grep"
  | "glob"
  | "fetch"
  | "mcp"
  | "shell"

export type FrozenSubagentCursorToolCallCase =
  | "getMcpToolsToolCall"
  | "readMcpResourceToolCall"
  | "listMcpResourcesToolCall"
  | "readLintsToolCall"
  | "readTodosToolCall"
  | "updateTodosToolCall"
  | "webSearchToolCall"
  | "webFetchToolCall"
  | "createPlanToolCall"
  | "semSearchToolCall"
  | "reflectToolCall"
  | "readToolCall"
  | "editToolCall"
  | "lsToolCall"
  | "deleteToolCall"
  | "grepToolCall"
  | "globToolCall"
  | "fetchToolCall"
  | "mcpToolCall"
  | "shellToolCall"

type OfficialCursorToolCallCase = Extract<ToolCall["tool"]["case"], string>

type FrozenToolCallCasesMustBeOfficial =
  Exclude<
    FrozenSubagentCursorToolCallCase,
    OfficialCursorToolCallCase
  > extends never
    ? true
    : never

const FROZEN_TOOL_CALL_CASES_MUST_BE_OFFICIAL: FrozenToolCallCasesMustBeOfficial = true

void FROZEN_TOOL_CALL_CASES_MUST_BE_OFFICIAL

export interface FrozenSubagentToolCallProjection {
  readonly family: FrozenSubagentCursorToolFamily
  readonly toolCallCase: FrozenSubagentCursorToolCallCase
}

interface StaticProjection extends FrozenSubagentToolCallProjection {
  readonly definitionKeys: readonly string[]
}

const INLINE_PROJECTIONS: Readonly<
  Record<
    Extract<
      SubagentToolExecutionOwner,
      { readonly kind: "bridge-inline" }
    >["operation"],
    StaticProjection
  >
> = {
  grep_search: {
    family: "grep",
    toolCallCase: "grepToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH"],
  },
  read_file: {
    family: "read",
    toolCallCase: "readToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_READ_FILE_V2"],
  },
  list_directory: {
    family: "ls",
    toolCallCase: "lsToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_LIST_DIR_V2"],
  },
  list_mcp_resources: {
    family: "list_mcp_resources",
    toolCallCase: "listMcpResourcesToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES"],
  },
  read_mcp_resource: {
    family: "read_mcp_resource",
    toolCallCase: "readMcpResourceToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE"],
  },
  run_terminal_command: {
    family: "shell",
    toolCallCase: "shellToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2"],
  },
}

const DEFERRED_PROJECTIONS: Readonly<
  Record<
    Extract<
      SubagentToolExecutionOwner,
      { readonly kind: "bridge-deferred" }
    >["family"],
    StaticProjection
  >
> = {
  semantic_search: {
    family: "sem_search",
    toolCallCase: "semSearchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL"],
  },
  deep_search: {
    family: "sem_search",
    toolCallCase: "semSearchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_DEEP_SEARCH"],
  },
  read_semsearch_files: {
    family: "read",
    toolCallCase: "readToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES"],
  },
  file_search: {
    family: "glob",
    toolCallCase: "globToolCall",
    definitionKeys: [
      "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
      "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
    ],
  },
  web_search: {
    family: "web_search",
    toolCallCase: "webSearchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_WEB_SEARCH"],
  },
  web_fetch: {
    family: "web_fetch",
    toolCallCase: "webFetchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_WEB_FETCH"],
  },
  fetch: {
    family: "fetch",
    toolCallCase: "fetchToolCall",
    definitionKeys: ["AGENT_V1_FETCH"],
  },
  exa_search: {
    family: "exa_search",
    toolCallCase: "webSearchToolCall",
    definitionKeys: ["BRIDGE_EXA_SEARCH"],
  },
  exa_fetch: {
    family: "exa_fetch",
    toolCallCase: "webFetchToolCall",
    definitionKeys: ["BRIDGE_EXA_FETCH"],
  },
  fetch_rules: {
    family: "read",
    toolCallCase: "readToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_FETCH_RULES"],
  },
  read_lints: {
    family: "read_lints",
    toolCallCase: "readLintsToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_READ_LINTS"],
  },
  read_project: {
    family: "ls",
    toolCallCase: "lsToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_READ_PROJECT"],
  },
  read_todos: {
    family: "read_todos",
    toolCallCase: "readTodosToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_TODO_READ"],
  },
  update_todos: {
    family: "update_todos",
    toolCallCase: "updateTodosToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_TODO_WRITE"],
  },
  get_mcp_tools: {
    family: "get_mcp_tools",
    toolCallCase: "getMcpToolsToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS"],
  },
  knowledge_base: {
    family: "web_search",
    toolCallCase: "webSearchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE"],
  },
  fetch_pull_request: {
    family: "web_fetch",
    toolCallCase: "webFetchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST"],
  },
  reflect: {
    family: "reflect",
    toolCallCase: "reflectToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_REFLECT"],
  },
  search_symbols: {
    family: "sem_search",
    toolCallCase: "semSearchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS"],
  },
  go_to_definition: {
    family: "sem_search",
    toolCallCase: "semSearchToolCall",
    definitionKeys: ["CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION"],
  },
}

/**
 * The canonical owner-to-oneof mapping.  This function is deliberately total
 * for the durable owner union and has no name-based fallback.
 */
export function resolveFrozenSubagentToolCallProjection(
  owner: SubagentToolExecutionOwner
): FrozenSubagentToolCallProjection {
  switch (owner.kind) {
    case "bridge-inline":
      return projectionWithoutDefinition(
        requireStaticProjection(
          INLINE_PROJECTIONS,
          "bridge-inline",
          owner.operation
        )
      )
    case "bridge-deferred":
      return projectionWithoutDefinition(
        requireStaticProjection(
          DEFERRED_PROJECTIONS,
          "bridge-deferred",
          owner.family
        )
      )
    case "cursor-client": {
      assertExactCursorDefinitionOwner(owner)
      assertFrozenSubagentExecProtocolOwnerBinding(owner)
      switch (owner.cursorDefinitionKey) {
        case "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2":
          return { family: "edit", toolCallCase: "editToolCall" }
        case "CLIENT_SIDE_TOOL_V2_DELETE_FILE":
          return { family: "delete", toolCallCase: "deleteToolCall" }
        default:
          throw new Error(
            `Frozen cursor-client definition ${owner.cursorDefinitionKey} has no ToolCall projection.`
          )
      }
    }
    case "cursor-interaction-query":
      assertExactCursorDefinitionOwner(owner)
      if (
        owner.cursorDefinitionKey !== "CLIENT_SIDE_TOOL_V2_CREATE_PLAN" ||
        owner.protocolToolName !== "create_plan" ||
        owner.queryCase !== "createPlanRequestQuery" ||
        owner.responseCase !== "createPlanRequestResponse"
      ) {
        throw new Error(
          "Frozen interaction owner is not the create-plan protocol pair."
        )
      }
      return { family: "create_plan", toolCallCase: "createPlanToolCall" }
    case "mcp-client":
      assertExactMcpClientOwner(owner)
      assertFrozenSubagentExecProtocolOwnerBinding(owner)
      return { family: "mcp", toolCallCase: "mcpToolCall" }
    default:
      throw new Error("Unsupported frozen subagent ToolCall owner.")
  }
}

/**
 * Bind a specific durable contract entry to its execution owner without
 * normalizing or rediscovering its name.  This is a separate assertion from
 * the projection map so callers can verify both identity and oneof case.
 */
export function assertFrozenSubagentToolEntryOwnerBinding(
  entry: Pick<SubagentToolContractEntry, "name">,
  owner: SubagentToolExecutionOwner
): void {
  const entryName = entry.name
  if (!isExactFrozenIdentifier(entryName)) {
    throw new Error("Frozen subagent ToolCall requires an exact entry name.")
  }

  switch (owner.kind) {
    case "bridge-inline":
      assertEntryMatchesDefinitionKeys(
        entryName,
        requireStaticProjection(
          INLINE_PROJECTIONS,
          "bridge-inline",
          owner.operation
        ).definitionKeys
      )
      return
    case "bridge-deferred":
      assertEntryMatchesDefinitionKeys(
        entryName,
        requireStaticProjection(
          DEFERRED_PROJECTIONS,
          "bridge-deferred",
          owner.family
        ).definitionKeys
      )
      return
    case "cursor-client": {
      const definition = assertExactCursorDefinitionOwner(owner)
      assertFrozenSubagentExecProtocolOwnerBinding(owner)
      if (definition.name !== entryName) {
        throw new Error(
          "Frozen cursor-client ToolCall definition does not match its durable owner."
        )
      }
      resolveFrozenSubagentToolCallProjection(owner)
      return
    }
    case "cursor-interaction-query": {
      const definition = assertExactCursorDefinitionOwner(owner)
      if (entryName !== definition.name) {
        throw new Error(
          "Frozen interaction ToolCall definition does not match its durable owner."
        )
      }
      resolveFrozenSubagentToolCallProjection(owner)
      return
    }
    case "mcp-client":
      assertExactMcpClientOwner(owner)
      assertFrozenSubagentExecProtocolOwnerBinding(owner)
      if (entryName !== owner.modelToolName) {
        throw new Error(
          "Frozen MCP ToolCall owner does not match its durable capability."
        )
      }
      return
    default:
      throw new Error("Unsupported frozen subagent ToolCall owner.")
  }
}

function requireStaticProjection(
  catalog: object,
  ownerKind: "bridge-inline" | "bridge-deferred",
  ownerValue: string
): StaticProjection {
  if (!Object.prototype.hasOwnProperty.call(catalog, ownerValue)) {
    throw new Error(
      `Unsupported frozen ${ownerKind} owner: ${JSON.stringify(ownerValue)}.`
    )
  }
  const projection = (catalog as Record<string, StaticProjection>)[ownerValue]
  if (!projection) {
    throw new Error(
      `Unsupported frozen ${ownerKind} owner: ${JSON.stringify(ownerValue)}.`
    )
  }
  return projection
}

function assertExactCursorDefinitionOwner(
  owner: Extract<
    SubagentToolExecutionOwner,
    { readonly kind: "cursor-client" | "cursor-interaction-query" }
  >
): ReturnType<typeof getFrozenCursorToolDefinition> {
  if (
    !isExactFrozenIdentifier(owner.cursorDefinitionKey) ||
    !isExactFrozenIdentifier(owner.protocolToolName)
  ) {
    throw new Error(
      "Frozen Cursor ToolCall owner requires exact definition and protocol identifiers."
    )
  }
  const definition = getFrozenCursorToolDefinition(owner.cursorDefinitionKey)
  if (definition.name !== owner.protocolToolName) {
    throw new Error(
      "Frozen Cursor ToolCall definition does not match its durable protocol name."
    )
  }
  return definition
}

function assertExactMcpClientOwner(
  owner: Extract<SubagentToolExecutionOwner, { readonly kind: "mcp-client" }>
): void {
  if (
    !isExactFrozenIdentifier(owner.providerIdentifier) ||
    !isExactFrozenIdentifier(owner.toolName) ||
    !isExactFrozenIdentifier(owner.ideRegistryKey) ||
    !isExactFrozenIdentifier(owner.definitionName) ||
    !isExactFrozenIdentifier(owner.modelToolName)
  ) {
    throw new Error(
      "Frozen MCP ToolCall owner requires exact durable capability identifiers."
    )
  }
}

function projectionWithoutDefinition(
  projection: StaticProjection
): FrozenSubagentToolCallProjection {
  return {
    family: projection.family,
    toolCallCase: projection.toolCallCase,
  }
}

function assertEntryMatchesDefinitionKeys(
  entryName: string,
  definitionKeys: readonly string[]
): void {
  const matches = definitionKeys.some(
    (definitionKey) =>
      getFrozenCursorToolDefinition(definitionKey).name === entryName
  )
  if (!matches) {
    throw new Error(
      `Frozen subagent entry ${entryName} does not match its execution owner.`
    )
  }
}

function isExactFrozenIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    value === value.trim() &&
    !value.includes("\u0000")
  )
}
