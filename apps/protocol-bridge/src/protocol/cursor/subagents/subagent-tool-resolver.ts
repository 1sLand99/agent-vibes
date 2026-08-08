/**
 * Spawn-time compiler for the immutable child tool contract.
 *
 * Agent frontmatter is policy, not execution authority.  This module may
 * inspect that policy exactly once while a child is spawned, then writes a
 * complete capability contract.  Foreground recovery and detached workers
 * must consume that contract directly; they must not call this module to
 * rediscover tools by name.
 */

import {
  assertFrozenSubagentExecProtocolOwnerBinding,
  computeSubagentToolCapabilityId,
  computeSubagentToolContractFingerprint,
  computeSubagentToolInputSchemaSha256,
  type SubagentBridgeDeferredFamily,
  type SubagentExecProtocol,
  type SubagentToolCapabilityIdentityInput,
  type SubagentToolExecutionOwners,
  type SubagentBridgeInlineOperation,
  type SubagentMcpRegistryServerScope,
  type SubagentMcpRegistryTool,
  type SubagentSpawnJsonObject,
  type SubagentSpawnJsonValue,
  type SubagentToolContract,
  type SubagentToolContractEntry,
  type SubagentToolContractFingerprintInput,
  type SubagentToolExecutionOwner,
} from "../session/subagent-spawn-request"
import type { McpToolDef } from "../tools/cursor-request-parser"
import {
  getFrozenCursorToolDefinition,
  type ToolDefinition,
} from "../tools/cursor-tool-mapper"
import type { SubagentDefinition } from "./types"

/**
 * The only frontmatter policy names understood by this bridge.  These names
 * never become a run-time dispatch key: each one is compiled to an exact
 * Cursor definition and persisted execution owner below.
 */
export const SUB_AGENT_SAFE_TOOL_NAMES = [
  "semantic_search",
  "deep_search",
  "read_semsearch_files",
  "file_search",
  "glob_search",
  "search_symbols",
  "go_to_definition",
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
  "create_plan",
  "get_mcp_tools",
  "mcp_tool",
  "list_mcp_resources",
  "read_mcp_resource",
  "knowledge_base",
  "fetch_pull_request",
  "reflect",
  "run_terminal_command",
  "read_file",
  "list_directory",
  "grep_search",
  "edit_file_v2",
  "delete_file",
] as const

export type SubagentSafeToolName = (typeof SUB_AGENT_SAFE_TOOL_NAMES)[number]

type BuiltInSubagentSafeToolName = Exclude<SubagentSafeToolName, "mcp_tool">

const SUB_AGENT_SAFE_SET: ReadonlySet<string> = new Set(
  SUB_AGENT_SAFE_TOOL_NAMES
)

type StaticExecutionOwner =
  | {
      readonly kind: "bridge-inline"
      readonly operation: SubagentBridgeInlineOperation
    }
  | {
      readonly kind: "bridge-deferred"
      readonly family: SubagentBridgeDeferredFamily
    }
  | {
      readonly kind: "cursor-client"
      readonly execProtocol: SubagentExecProtocol
    }
  | {
      readonly kind: "cursor-interaction-query"
      readonly queryCase: "createPlanRequestQuery"
      readonly responseCase: "createPlanRequestResponse"
    }

type StaticBackgroundExecutionOwner = Exclude<
  StaticExecutionOwner,
  | { readonly kind: "cursor-client" }
  | { readonly kind: "cursor-interaction-query" }
>

interface StaticExecutionOwnerTemplate {
  readonly foreground: StaticExecutionOwner
  readonly background: StaticBackgroundExecutionOwner | null
}

const FROZEN_WRITE_EXEC_PROTOCOL = {
  requestCase: "writeArgs",
  terminal: { transport: "single", resultCase: "writeResult" },
} as const satisfies SubagentExecProtocol

const FROZEN_DELETE_EXEC_PROTOCOL = {
  requestCase: "deleteArgs",
  terminal: { transport: "single", resultCase: "deleteResult" },
} as const satisfies SubagentExecProtocol

const FROZEN_MCP_EXEC_PROTOCOL = {
  requestCase: "mcpArgs",
  terminal: { transport: "single", resultCase: "mcpResult" },
} as const satisfies SubagentExecProtocol

function bridgeDeferred(
  family: SubagentBridgeDeferredFamily
): StaticExecutionOwnerTemplate {
  return {
    foreground: { kind: "bridge-deferred", family },
    background: { kind: "bridge-deferred", family },
  }
}

function foregroundBridgeDeferred(
  family: SubagentBridgeDeferredFamily
): StaticExecutionOwnerTemplate {
  return {
    foreground: { kind: "bridge-deferred", family },
    background: null,
  }
}

function bridgeInline(
  operation: SubagentBridgeInlineOperation
): StaticExecutionOwnerTemplate {
  return {
    foreground: { kind: "bridge-inline", operation },
    background: { kind: "bridge-inline", operation },
  }
}

function foregroundBridgeInline(
  operation: SubagentBridgeInlineOperation
): StaticExecutionOwnerTemplate {
  return {
    foreground: { kind: "bridge-inline", operation },
    background: null,
  }
}

function cursorClient(
  execProtocol: SubagentExecProtocol
): StaticExecutionOwnerTemplate {
  return {
    foreground: { kind: "cursor-client", execProtocol },
    background: null,
  }
}

/**
 * Create-plan is an official InteractionQuery exchange, not an Exec client
 * call.  Keep the complete oneof pair in the compiled authority so neither
 * foreground recovery nor a future capability can route it by tool name.
 */
function cursorInteractionQuery(
  queryCase: "createPlanRequestQuery",
  responseCase: "createPlanRequestResponse"
): StaticExecutionOwnerTemplate {
  return {
    foreground: {
      kind: "cursor-interaction-query",
      queryCase,
      responseCase,
    },
    background: null,
  }
}

interface StaticBuiltInCapabilityDescriptor {
  readonly policyName: BuiltInSubagentSafeToolName
  readonly cursorDefinitionKey: string
  readonly ownerTemplate: StaticExecutionOwnerTemplate
}

/**
 * The spawn-time semantic catalog.  There is intentionally no descriptor for
 * `mcp_tool`: that policy expands to concrete frozen MCP functions rather
 * than advertising a generic tool whose identity would be chosen later.
 */
const STATIC_BUILT_IN_CAPABILITY_CATALOG = [
  {
    policyName: "semantic_search",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
    ownerTemplate: bridgeDeferred("semantic_search"),
  },
  {
    policyName: "deep_search",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
    ownerTemplate: bridgeDeferred("deep_search"),
  },
  {
    policyName: "read_semsearch_files",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
    ownerTemplate: bridgeDeferred("read_semsearch_files"),
  },
  {
    policyName: "file_search",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
    ownerTemplate: bridgeDeferred("file_search"),
  },
  {
    policyName: "glob_search",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
    ownerTemplate: bridgeDeferred("file_search"),
  },
  {
    policyName: "search_symbols",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
    ownerTemplate: bridgeDeferred("search_symbols"),
  },
  {
    policyName: "go_to_definition",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
    ownerTemplate: bridgeDeferred("go_to_definition"),
  },
  {
    policyName: "web_search",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
    ownerTemplate: bridgeDeferred("web_search"),
  },
  {
    policyName: "web_fetch",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
    ownerTemplate: bridgeDeferred("web_fetch"),
  },
  {
    policyName: "fetch",
    cursorDefinitionKey: "AGENT_V1_FETCH",
    ownerTemplate: bridgeDeferred("fetch"),
  },
  {
    policyName: "exa_search",
    cursorDefinitionKey: "BRIDGE_EXA_SEARCH",
    ownerTemplate: bridgeDeferred("exa_search"),
  },
  {
    policyName: "exa_fetch",
    cursorDefinitionKey: "BRIDGE_EXA_FETCH",
    ownerTemplate: bridgeDeferred("exa_fetch"),
  },
  {
    policyName: "fetch_rules",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
    ownerTemplate: bridgeDeferred("fetch_rules"),
  },
  {
    policyName: "read_lints",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
    ownerTemplate: bridgeDeferred("read_lints"),
  },
  {
    policyName: "read_project",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
    ownerTemplate: bridgeDeferred("read_project"),
  },
  {
    policyName: "read_todos",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_TODO_READ",
    ownerTemplate: bridgeDeferred("read_todos"),
  },
  {
    policyName: "update_todos",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
    ownerTemplate: bridgeDeferred("update_todos"),
  },
  {
    policyName: "create_plan",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
    ownerTemplate: cursorInteractionQuery(
      "createPlanRequestQuery",
      "createPlanRequestResponse"
    ),
  },
  {
    policyName: "get_mcp_tools",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
    ownerTemplate: foregroundBridgeDeferred("get_mcp_tools"),
  },
  {
    policyName: "list_mcp_resources",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
    ownerTemplate: foregroundBridgeInline("list_mcp_resources"),
  },
  {
    policyName: "read_mcp_resource",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
    ownerTemplate: foregroundBridgeInline("read_mcp_resource"),
  },
  {
    policyName: "knowledge_base",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
    ownerTemplate: bridgeDeferred("knowledge_base"),
  },
  {
    policyName: "fetch_pull_request",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
    ownerTemplate: bridgeDeferred("fetch_pull_request"),
  },
  {
    policyName: "reflect",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_REFLECT",
    ownerTemplate: bridgeDeferred("reflect"),
  },
  {
    policyName: "run_terminal_command",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
    ownerTemplate: bridgeInline("run_terminal_command"),
  },
  {
    policyName: "read_file",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
    ownerTemplate: bridgeInline("read_file"),
  },
  {
    policyName: "list_directory",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
    ownerTemplate: bridgeInline("list_directory"),
  },
  {
    policyName: "grep_search",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
    ownerTemplate: bridgeInline("grep_search"),
  },
  {
    policyName: "edit_file_v2",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
    ownerTemplate: cursorClient(FROZEN_WRITE_EXEC_PROTOCOL),
  },
  {
    policyName: "delete_file",
    cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
    ownerTemplate: cursorClient(FROZEN_DELETE_EXEC_PROTOCOL),
  },
] as const satisfies readonly StaticBuiltInCapabilityDescriptor[]

const STATIC_CAPABILITY_BY_POLICY_NAME: ReadonlyMap<
  BuiltInSubagentSafeToolName,
  StaticBuiltInCapabilityDescriptor
> = new Map(
  STATIC_BUILT_IN_CAPABILITY_CATALOG.map((descriptor) => [
    descriptor.policyName,
    descriptor,
  ])
)

assertStaticCapabilityCatalog()

function assertStaticCapabilityCatalog(): void {
  const expected = SUB_AGENT_SAFE_TOOL_NAMES.filter(
    (name): name is BuiltInSubagentSafeToolName => name !== "mcp_tool"
  )
  const actual = STATIC_BUILT_IN_CAPABILITY_CATALOG.map(
    (descriptor) => descriptor.policyName
  )
  const duplicate = actual.find((name, index) => actual.indexOf(name) !== index)
  if (duplicate) {
    throw new Error(
      `Subagent capability catalog contains duplicate policy name ${JSON.stringify(duplicate)}`
    )
  }
  const missing = expected.filter(
    (name) => !STATIC_CAPABILITY_BY_POLICY_NAME.has(name)
  )
  const unexpected = actual.filter((name) => !expected.includes(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      "Subagent capability catalog must cover every non-MCP safe policy exactly " +
        `(missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"})`
    )
  }
}

/** A parsed frontmatter policy before it becomes a durable capability set. */
export interface SubagentSpawnToolPolicy {
  readonly allowedToolNames: readonly SubagentSafeToolName[]
  readonly unknownAllowedToolNames: readonly string[]
  readonly unknownDisallowedToolNames: readonly string[]
  readonly hasWildcard: boolean
}

/**
 * Resolve agent frontmatter once at spawn.  Unknown entries are returned for
 * diagnostics, but {@link compileSubagentToolContractContent} rejects them;
 * there is no silent allowlist truncation on the durable path.
 */
export function resolveSubagentSpawnToolPolicy(
  agent: Pick<SubagentDefinition, "tools" | "disallowedTools">
): SubagentSpawnToolPolicy {
  const declaredTools = agent.tools
  const hasWildcard =
    !declaredTools ||
    declaredTools.length === 0 ||
    (declaredTools.length === 1 && declaredTools[0] === "*")

  const unknownAllowedToolNames: string[] = []
  const allowed = new Set<SubagentSafeToolName>()
  if (hasWildcard) {
    for (const name of SUB_AGENT_SAFE_TOOL_NAMES) allowed.add(name)
  } else {
    for (const declared of declaredTools) {
      const toolName = declared.trim()
      if (!toolName) continue
      if (toolName === "*") {
        for (const name of SUB_AGENT_SAFE_TOOL_NAMES) allowed.add(name)
        continue
      }
      if (SUB_AGENT_SAFE_SET.has(toolName)) {
        allowed.add(toolName as SubagentSafeToolName)
      } else {
        unknownAllowedToolNames.push(toolName)
      }
    }
  }

  const unknownDisallowedToolNames: string[] = []
  for (const declared of agent.disallowedTools || []) {
    const toolName = declared.trim()
    if (!toolName) continue
    if (!SUB_AGENT_SAFE_SET.has(toolName)) {
      unknownDisallowedToolNames.push(toolName)
      continue
    }
    allowed.delete(toolName as SubagentSafeToolName)
  }

  return {
    allowedToolNames: SUB_AGENT_SAFE_TOOL_NAMES.filter((name) =>
      allowed.has(name)
    ),
    unknownAllowedToolNames,
    unknownDisallowedToolNames,
    hasWildcard,
  }
}

export interface CompileSubagentToolContractOptions {
  /** Exact MCP descriptors captured from the parent request at spawn. */
  readonly mcpToolDefs?: readonly McpToolDef[]
}

/**
 * Compile the content whose SHA-256 is stored in a child request.  The
 * request boundary owns hashing and normalizing this return value through
 * `computeSubagentToolContractFingerprint`; keeping that responsibility out
 * of this module avoids a runtime cycle with the request normalizer.
 */
export function compileSubagentToolContractContent(
  agent: Pick<
    SubagentDefinition,
    "tools" | "disallowedTools" | "inheritedMcpServers"
  >,
  options: CompileSubagentToolContractOptions = {}
): SubagentToolContractFingerprintInput {
  const policy = resolveSubagentSpawnToolPolicy(agent)
  assertCompilableSpawnPolicy(policy)

  const mcpPolicyEnabled = policy.allowedToolNames.includes("mcp_tool")
  const mcpResourcePolicyEnabled =
    policy.allowedToolNames.includes("list_mcp_resources") ||
    policy.allowedToolNames.includes("read_mcp_resource")
  const compiledMcp = compileMcpCapabilities(
    options.mcpToolDefs || [],
    mcpPolicyEnabled,
    mcpResourcePolicyEnabled,
    agent.inheritedMcpServers
  )

  const tools: SubagentToolContractEntry[] = []
  for (const policyName of policy.allowedToolNames) {
    if (policyName === "mcp_tool") {
      tools.push(...compiledMcp.tools)
      continue
    }
    const descriptor = STATIC_CAPABILITY_BY_POLICY_NAME.get(policyName)
    if (!descriptor) {
      throw new Error(
        `Subagent capability catalog is missing ${JSON.stringify(policyName)}`
      )
    }
    tools.push(compileBuiltInCapability(descriptor))
  }

  assertUniqueToolNames(tools)
  return {
    version: 2,
    tools,
    mcpRegistry: compiledMcp.mcpRegistry,
  }
}

/**
 * Compile the complete immutable contract that is stored with a child run.
 * This is the only spawn path that derives a tool fingerprint; callers must
 * persist its return value unchanged instead of assembling a name list and
 * rebuilding it on recovery.
 */
export function compileFrozenSubagentToolContract(
  agent: Pick<
    SubagentDefinition,
    "tools" | "disallowedTools" | "inheritedMcpServers"
  >,
  options: CompileSubagentToolContractOptions = {}
): SubagentToolContract {
  const content = compileSubagentToolContractContent(agent, options)
  return {
    ...content,
    fingerprint: computeSubagentToolContractFingerprint(content),
  }
}

function assertCompilableSpawnPolicy(policy: SubagentSpawnToolPolicy): void {
  if (policy.unknownAllowedToolNames.length > 0) {
    throw new Error(
      "Subagent tools allowlist contains unsupported entries: " +
        policy.unknownAllowedToolNames.join(", ")
    )
  }
  if (policy.unknownDisallowedToolNames.length > 0) {
    throw new Error(
      "Subagent disallowedTools contains unsupported entries: " +
        policy.unknownDisallowedToolNames.join(", ")
    )
  }
}

function compileBuiltInCapability(
  descriptor: StaticBuiltInCapabilityDescriptor
): SubagentToolContractEntry {
  const frozenDefinition = getFrozenCursorToolDefinition(
    descriptor.cursorDefinitionKey
  )
  const executionOwners = materializeExecutionOwners(
    descriptor.ownerTemplate,
    descriptor.cursorDefinitionKey,
    frozenDefinition.name
  )
  return createFrozenToolContractEntry({
    kind: "function",
    name: requireFrozenIdentifier(
      frozenDefinition.name,
      `${descriptor.policyName}.modelToolName`
    ),
    description: requireFrozenDescription(
      frozenDefinition.description,
      `${descriptor.policyName}.description`
    ),
    schemaDialect: "json-schema",
    strict: false,
    inputSchema: cloneFrozenJsonObject(
      frozenDefinition.inputSchema,
      `${descriptor.policyName}.inputSchema`
    ),
    executionOwners,
  })
}

function materializeExecutionOwners(
  template: StaticExecutionOwnerTemplate,
  cursorDefinitionKey: string,
  protocolToolName: string
): SubagentToolExecutionOwners {
  const materialize = (
    owner: StaticExecutionOwner
  ): SubagentToolExecutionOwner => {
    switch (owner.kind) {
      case "bridge-inline":
        return { kind: owner.kind, operation: owner.operation }
      case "bridge-deferred":
        return { kind: owner.kind, family: owner.family }
      case "cursor-client":
        return {
          kind: owner.kind,
          cursorDefinitionKey,
          protocolToolName,
          execProtocol: owner.execProtocol,
        }
      case "cursor-interaction-query":
        return {
          kind: owner.kind,
          cursorDefinitionKey,
          protocolToolName,
          queryCase: owner.queryCase,
          responseCase: owner.responseCase,
        }
    }
  }
  return {
    foreground: materialize(template.foreground),
    background:
      template.background === null ? null : materialize(template.background),
  }
}

function createFrozenToolContractEntry(
  input: Omit<SubagentToolCapabilityIdentityInput, "schemaSha256">
): SubagentToolContractEntry {
  const schemaSha256 = computeSubagentToolInputSchemaSha256(input.inputSchema)
  const identity: SubagentToolCapabilityIdentityInput = {
    ...input,
    schemaSha256,
  }
  return {
    capabilityId: computeSubagentToolCapabilityId(identity),
    ...identity,
  }
}

interface FrozenMcpIdentity {
  readonly definitionName: string
  readonly modelToolName: string
  readonly providerIdentifier: string
  readonly toolName: string
  readonly ideRegistryKey: string
  readonly description: string | undefined
  readonly inputSchema: unknown
}

interface CompiledMcpCapabilities {
  readonly tools: readonly SubagentToolContractEntry[]
  readonly mcpRegistry: readonly SubagentMcpRegistryServerScope[]
}

function compileMcpCapabilities(
  mcpToolDefs: readonly McpToolDef[],
  includeDirectTools: boolean,
  includeResourceScopes: boolean,
  inheritedMcpServers: readonly string[] | undefined
): CompiledMcpCapabilities {
  if (!includeDirectTools && !includeResourceScopes) {
    return { tools: [], mcpRegistry: [] }
  }

  const selectedMcpToolDefs = selectInheritedMcpToolDefinitions(
    mcpToolDefs,
    inheritedMcpServers
  )
  const identities = selectedMcpToolDefs
    .map((definition, index) => normalizeFrozenMcpIdentity(definition, index))
    .sort(compareFrozenMcpIdentity)
  assertUniqueMcpIdentities(identities)

  const serverBuilders = new Map<
    string,
    {
      providerIdentifier: string
      ideRegistryKey: string
      tools: SubagentMcpRegistryTool[]
    }
  >()
  const providerToRegistryKey = new Map<string, string>()
  const registryKeyToProvider = new Map<string, string>()
  const tools: SubagentToolContractEntry[] = []

  for (const identity of identities) {
    let knownRegistryKey = providerToRegistryKey.get(
      identity.providerIdentifier
    )
    if (knownRegistryKey === undefined) {
      providerToRegistryKey.set(
        identity.providerIdentifier,
        identity.ideRegistryKey
      )
      knownRegistryKey = identity.ideRegistryKey
    }
    if (knownRegistryKey !== identity.ideRegistryKey) {
      throw new Error(
        `MCP provider ${JSON.stringify(identity.providerIdentifier)} maps to more than one frozen IDE registry key`
      )
    }

    let knownProvider = registryKeyToProvider.get(identity.ideRegistryKey)
    if (knownProvider === undefined) {
      registryKeyToProvider.set(
        identity.ideRegistryKey,
        identity.providerIdentifier
      )
      knownProvider = identity.providerIdentifier
    }
    if (knownProvider !== identity.providerIdentifier) {
      throw new Error(
        `MCP IDE registry key ${JSON.stringify(identity.ideRegistryKey)} maps to more than one provider`
      )
    }

    const serverKey = `${identity.providerIdentifier}\u0000${identity.ideRegistryKey}`
    let server = serverBuilders.get(serverKey)
    if (!server) {
      server = {
        providerIdentifier: identity.providerIdentifier,
        ideRegistryKey: identity.ideRegistryKey,
        tools: [],
      }
      serverBuilders.set(serverKey, server)
    }

    if (!includeDirectTools) continue

    const description = requireFrozenDescription(
      identity.description,
      `MCP ${identity.definitionName}.description`
    )
    const inputSchema = cloneFrozenJsonObject(
      identity.inputSchema,
      `MCP ${identity.definitionName}.inputSchema`
    )
    const toolEntry = createFrozenToolContractEntry({
      kind: "function",
      name: identity.modelToolName,
      description,
      schemaDialect: "json-schema",
      strict: false,
      inputSchema,
      executionOwners: {
        foreground: {
          kind: "mcp-client",
          providerIdentifier: identity.providerIdentifier,
          toolName: identity.toolName,
          ideRegistryKey: identity.ideRegistryKey,
          definitionName: identity.definitionName,
          modelToolName: identity.modelToolName,
          execProtocol: FROZEN_MCP_EXEC_PROTOCOL,
        },
        background: null,
      },
    })
    const registryTool: SubagentMcpRegistryTool = {
      capabilityId: toolEntry.capabilityId,
      definitionName: identity.definitionName,
      modelToolName: identity.modelToolName,
      toolName: identity.toolName,
      description,
      schemaSha256: toolEntry.schemaSha256,
      inputSchema: cloneFrozenJsonObject(
        inputSchema,
        `MCP ${identity.definitionName}.registrySchema`
      ),
    }
    server.tools.push(registryTool)
    tools.push(toolEntry)
  }

  if (!includeDirectTools && !includeResourceScopes) {
    return { tools: [], mcpRegistry: [] }
  }

  const mcpRegistry = Array.from(serverBuilders.values())
    .map((server) => ({
      providerIdentifier: server.providerIdentifier,
      ideRegistryKey: server.ideRegistryKey,
      tools: [...server.tools].sort(compareMcpRegistryTool),
    }))
    .sort(compareMcpRegistryServer)

  return {
    tools: [...tools].sort(compareMcpToolContractEntry),
    mcpRegistry,
  }
}

/**
 * Resolve the child-visible portion of the parent's mounted MCP registry.
 * Claude Code normally inherits the complete parent MCP tool pool; an omitted
 * allowlist preserves that behavior. Cursor protocol built-ins may instead
 * name an exact server boundary. Both wire identities are accepted because
 * Cursor carries the provider identifier and IDE registry key separately.
 */
function selectInheritedMcpToolDefinitions(
  mcpToolDefs: readonly McpToolDef[],
  inheritedMcpServers: readonly string[] | undefined
): readonly McpToolDef[] {
  if (inheritedMcpServers === undefined) return mcpToolDefs

  const requested = new Set<string>()
  for (const rawName of inheritedMcpServers) {
    const name = rawName.trim()
    if (!name || name !== rawName || name.includes("\u0000")) {
      throw new Error(
        "Subagent inheritedMcpServers entries must be canonical non-empty server names"
      )
    }
    if (requested.has(name)) {
      throw new Error(
        `Subagent inheritedMcpServers contains duplicate server ${JSON.stringify(name)}`
      )
    }
    requested.add(name)
  }

  const matched = new Set<string>()
  const selected = mcpToolDefs.filter((definition) => {
    let include = false
    for (const name of requested) {
      if (
        definition.providerIdentifier === name ||
        definition.ideRegistryKey === name
      ) {
        matched.add(name)
        include = true
      }
    }
    return include
  })

  const missing = [...requested].filter((name) => !matched.has(name))
  if (missing.length > 0) {
    throw new Error(
      "Subagent inheritedMcpServers are not mounted in the parent request: " +
        missing.join(", ")
    )
  }
  return selected
}

function normalizeFrozenMcpIdentity(
  value: McpToolDef,
  index: number
): FrozenMcpIdentity {
  const label = `MCP definition[${index}]`
  const definitionName = requireFrozenIdentifier(value?.name, `${label}.name`)
  const toolName = requireFrozenIdentifier(value?.toolName, `${label}.toolName`)
  const providerIdentifier = requireFrozenIdentifier(
    value?.providerIdentifier,
    `${label}.providerIdentifier`
  )
  const ideRegistryKey = requireFrozenIdentifier(
    value?.ideRegistryKey,
    `${label}.ideRegistryKey`
  )
  const suffix = `-${toolName}`
  if (
    !definitionName.endsWith(suffix) ||
    definitionName.length <= suffix.length
  ) {
    throw new Error(
      `${label}.name must be an exact composed MCP definition name ending in ${JSON.stringify(suffix)}`
    )
  }
  const derivedRegistryKey = definitionName.slice(
    0,
    definitionName.length - suffix.length
  )
  if (derivedRegistryKey !== ideRegistryKey) {
    throw new Error(
      `${label}.ideRegistryKey must exactly equal the registry key encoded by its definition name`
    )
  }
  return {
    definitionName,
    modelToolName: definitionName,
    providerIdentifier,
    toolName,
    ideRegistryKey,
    description: value.description,
    inputSchema: value.inputSchema,
  }
}

function assertUniqueMcpIdentities(
  identities: readonly FrozenMcpIdentity[]
): void {
  const definitionNames = new Set<string>()
  const serverToolNames = new Set<string>()
  for (const identity of identities) {
    if (definitionNames.has(identity.definitionName)) {
      throw new Error(
        `MCP definitions contain a duplicate exact definition name ${JSON.stringify(identity.definitionName)}`
      )
    }
    definitionNames.add(identity.definitionName)

    const serverToolKey = JSON.stringify([
      identity.providerIdentifier,
      identity.ideRegistryKey,
      identity.toolName,
    ])
    if (serverToolNames.has(serverToolKey)) {
      throw new Error(
        `MCP definitions contain a duplicate exact server/tool identity ${serverToolKey}`
      )
    }
    serverToolNames.add(serverToolKey)
  }
}

function compareFrozenMcpIdentity(
  left: FrozenMcpIdentity,
  right: FrozenMcpIdentity
): number {
  return compareStrings(
    `${left.providerIdentifier}\u0000${left.ideRegistryKey}\u0000${left.definitionName}\u0000${left.toolName}`,
    `${right.providerIdentifier}\u0000${right.ideRegistryKey}\u0000${right.definitionName}\u0000${right.toolName}`
  )
}

function compareMcpRegistryServer(
  left: SubagentMcpRegistryServerScope,
  right: SubagentMcpRegistryServerScope
): number {
  return compareStrings(
    `${left.providerIdentifier}\u0000${left.ideRegistryKey}`,
    `${right.providerIdentifier}\u0000${right.ideRegistryKey}`
  )
}

function compareMcpRegistryTool(
  left: SubagentMcpRegistryTool,
  right: SubagentMcpRegistryTool
): number {
  return compareStrings(
    `${left.definitionName}\u0000${left.modelToolName}\u0000${left.toolName}`,
    `${right.definitionName}\u0000${right.modelToolName}\u0000${right.toolName}`
  )
}

function compareMcpToolContractEntry(
  left: SubagentToolContractEntry,
  right: SubagentToolContractEntry
): number {
  return compareStrings(left.name, right.name)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertUniqueToolNames(
  tools: readonly SubagentToolContractEntry[]
): void {
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(
        `Subagent capability contract contains duplicate model tool name ${JSON.stringify(tool.name)}`
      )
    }
    names.add(tool.name)
  }
}

/** The only executable phases a child request can encode. */
export type FrozenSubagentToolPhase = "foreground" | "background"

/**
 * Encode a frozen contract for a provider request.  The standard and Codex
 * encoders deliberately share the same complete input fields: backend
 * adaptation may change wire representation, never names, schemas, source
 * identity, or the selected capability set.
 */
export function encodeFrozenSubagentTools(
  contract: Pick<SubagentToolContract, "tools" | "mcpRegistry">,
  backend: string,
  phase: FrozenSubagentToolPhase
): ToolDefinition[] {
  if (backend === "codex") {
    return encodeFrozenSubagentCodexTools(contract, phase)
  }
  return encodeFrozenSubagentStandardTools(contract, phase)
}

export function encodeFrozenSubagentStandardTools(
  contract: Pick<SubagentToolContract, "tools" | "mcpRegistry">,
  phase: FrozenSubagentToolPhase
): ToolDefinition[] {
  return encodeFrozenSubagentToolContract(contract, phase)
}

export function encodeFrozenSubagentCodexTools(
  contract: Pick<SubagentToolContract, "tools" | "mcpRegistry">,
  phase: FrozenSubagentToolPhase
): ToolDefinition[] {
  return encodeFrozenSubagentToolContract(contract, phase)
}

function encodeFrozenSubagentToolContract(
  contract: Pick<SubagentToolContract, "tools" | "mcpRegistry">,
  phase: FrozenSubagentToolPhase
): ToolDefinition[] {
  const seenNames = new Set<string>()
  const encoded: ToolDefinition[] = []
  for (const entry of contract.tools) {
    const owner = entry.executionOwners[phase]
    if (owner === null) continue
    assertFrozenEntryBinding(entry, owner, contract.mcpRegistry)
    if (seenNames.has(entry.name)) {
      throw new Error(
        `Frozen subagent contract contains duplicate model tool name ${JSON.stringify(entry.name)}`
      )
    }
    seenNames.add(entry.name)
    encoded.push({
      type: "function",
      name: entry.name,
      description: entry.description,
      input_schema: cloneFrozenJsonObject(
        entry.inputSchema,
        `frozen tool ${entry.name}.inputSchema`
      ),
      strict: entry.strict,
    })
  }
  return encoded
}

function assertFrozenEntryBinding(
  entry: SubagentToolContractEntry,
  owner: SubagentToolExecutionOwner,
  mcpRegistry: readonly SubagentMcpRegistryServerScope[]
): void {
  if (entry.kind !== "function" || entry.schemaDialect !== "json-schema") {
    throw new Error(
      `Frozen subagent tool ${JSON.stringify(entry.name)} is not a JSON-schema function capability`
    )
  }
  requireFrozenIdentifier(entry.name, "frozen tool name")
  requireFrozenDescription(
    entry.description,
    `frozen tool ${entry.name}.description`
  )
  const expectedSchemaSha256 = computeSubagentToolInputSchemaSha256(
    entry.inputSchema
  )
  if (entry.schemaSha256 !== expectedSchemaSha256) {
    throw new Error(
      `Frozen subagent tool ${JSON.stringify(entry.name)} has a schema digest mismatch`
    )
  }
  const expectedCapabilityId = computeSubagentToolCapabilityId({
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
    schemaDialect: entry.schemaDialect,
    strict: entry.strict,
    inputSchema: entry.inputSchema,
    schemaSha256: entry.schemaSha256,
    executionOwners: entry.executionOwners,
  })
  if (entry.capabilityId !== expectedCapabilityId) {
    throw new Error(
      `Frozen subagent tool ${JSON.stringify(entry.name)} has a capability identity mismatch`
    )
  }

  if (owner.kind === "cursor-client") {
    if (owner.protocolToolName !== entry.name) {
      throw new Error(
        `Frozen cursor-client capability ${JSON.stringify(entry.name)} has a protocol name mismatch`
      )
    }
    requireFrozenIdentifier(
      owner.cursorDefinitionKey,
      `frozen tool ${entry.name}.cursorDefinitionKey`
    )
    assertFrozenSubagentExecProtocolOwnerBinding(owner)
    return
  }

  if (owner.kind === "cursor-interaction-query") {
    if (owner.protocolToolName !== entry.name) {
      throw new Error(
        `Frozen cursor interaction capability ${JSON.stringify(entry.name)} has a protocol name mismatch`
      )
    }
    if (
      owner.queryCase !== "createPlanRequestQuery" ||
      owner.responseCase !== "createPlanRequestResponse"
    ) {
      throw new Error(
        `Frozen cursor interaction capability ${JSON.stringify(entry.name)} has an unsupported query/response pair`
      )
    }
    const definition = getFrozenCursorToolDefinition(owner.cursorDefinitionKey)
    if (
      definition.name !== owner.protocolToolName ||
      owner.cursorDefinitionKey !== "CLIENT_SIDE_TOOL_V2_CREATE_PLAN" ||
      owner.protocolToolName !== "create_plan"
    ) {
      throw new Error(
        `Frozen cursor interaction capability ${JSON.stringify(entry.name)} does not bind the create_plan protocol definition`
      )
    }
    return
  }

  if (owner.kind !== "mcp-client") return
  assertFrozenSubagentExecProtocolOwnerBinding(owner)
  if (owner.modelToolName !== entry.name) {
    throw new Error(
      `Frozen MCP capability ${JSON.stringify(entry.name)} has a model tool name mismatch`
    )
  }
  const server = mcpRegistry.find(
    (candidate) =>
      candidate.providerIdentifier === owner.providerIdentifier &&
      candidate.ideRegistryKey === owner.ideRegistryKey
  )
  const registryTool = server?.tools.find(
    (candidate) =>
      candidate.definitionName === owner.definitionName &&
      candidate.modelToolName === owner.modelToolName &&
      candidate.toolName === owner.toolName
  )
  if (!registryTool) {
    throw new Error(
      `Frozen MCP capability ${JSON.stringify(entry.name)} is absent from its frozen registry scope`
    )
  }
  if (
    registryTool.capabilityId !== entry.capabilityId ||
    registryTool.description !== entry.description ||
    registryTool.schemaSha256 !== entry.schemaSha256 ||
    canonicalJson(registryTool.inputSchema) !== canonicalJson(entry.inputSchema)
  ) {
    throw new Error(
      `Frozen MCP capability ${JSON.stringify(entry.name)} does not match its frozen registry descriptor`
    )
  }
}

function requireFrozenIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty exact identifier`)
  }
  if (value.includes("\u0000")) {
    throw new Error(`${label} must not contain a NUL byte`)
  }
  return value
}

function requireFrozenDescription(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) {
    throw new Error(`${label} must be non-empty text`)
  }
  return value
}

function cloneFrozenJsonObject(
  value: unknown,
  label: string
): SubagentSpawnJsonObject {
  const cloned = cloneFrozenJsonValue(value, label, {
    ancestors: new Set<object>(),
    nodes: 0,
  })
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    throw new Error(`${label} must be a JSON object`)
  }
  return cloned as SubagentSpawnJsonObject
}

function cloneFrozenJsonValue(
  value: unknown,
  label: string,
  state: { ancestors: Set<object>; nodes: number },
  depth: number = 0
): SubagentSpawnJsonValue {
  if (depth > 64) {
    throw new Error(`${label} exceeds JSON nesting depth 64`)
  }
  state.nodes += 1
  if (state.nodes > 100_000) {
    throw new Error(`${label} exceeds JSON node limit 100000`)
  }
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`)
    }
    return value
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`${label} must be a plain JSON array`)
    }
    assertJsonArrayProperties(value, label)
    if (state.ancestors.has(value)) {
      throw new Error(`${label} contains a cycle`)
    }
    state.ancestors.add(value)
    const cloned = value.map((item, index) =>
      cloneFrozenJsonValue(item, `${label}[${index}]`, state, depth + 1)
    )
    state.ancestors.delete(value)
    return cloned
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${label} contains a non-JSON value`)
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object`)
  }
  if (state.ancestors.has(value)) {
    throw new Error(`${label} contains a cycle`)
  }
  state.ancestors.add(value)
  const cloned: Record<string, SubagentSpawnJsonValue> = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error(`${label} contains a symbol property`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(
        `${label} contains a non-JSON property ${JSON.stringify(key)}`
      )
    }
    cloned[key] = cloneFrozenJsonValue(
      descriptor.value,
      `${label}.${key}`,
      state,
      depth + 1
    )
  }
  state.ancestors.delete(value)
  return cloned
}

function assertJsonArrayProperties(value: unknown[], label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
      throw new Error(`${label} contains a non-index array property`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(
        `${label} contains a non-JSON property ${JSON.stringify(key)}`
      )
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${label} contains an array hole at index ${index}`)
    }
  }
}

function canonicalJson(value: SubagentSpawnJsonValue): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) {
    const arrayValue = value as readonly SubagentSpawnJsonValue[]
    return `[${arrayValue.map((item) => canonicalJson(item)).join(",")}]`
  }
  const objectValue = value as SubagentSpawnJsonObject
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`)
    .join(",")}}`
}
