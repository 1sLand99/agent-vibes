import {
  computeSubagentToolCapabilityId,
  computeSubagentToolContractFingerprint,
  computeSubagentToolInputSchemaSha256,
  type SubagentSpawnRequest,
  type SubagentToolCapabilityIdentityInput,
  type SubagentToolContractEntry,
  type SubagentToolContractFingerprintInput,
} from "../src/protocol/cursor/session/subagent-spawn-request"
import { WorkspaceScope } from "../src/protocol/cursor/session/workspace-scope"

const TEST_AGENT_FINGERPRINT = `sha256:${"a".repeat(64)}`
const TEST_WORKSPACE = WorkspaceScope.create({
  primaryRoot: "/workspace",
  ideRoots: ["/workspace"],
}).toFrozenSnapshot()

function createToolEntry(
  input: Omit<SubagentToolCapabilityIdentityInput, "schemaSha256">
): SubagentToolContractEntry {
  const identity: SubagentToolCapabilityIdentityInput = {
    ...input,
    schemaSha256: computeSubagentToolInputSchemaSha256(input.inputSchema),
  }
  return {
    capabilityId: computeSubagentToolCapabilityId(identity),
    ...identity,
  }
}

/** Explicit, complete child request used only by storage-focused tests. */
export function createTestSubagentSpawnRequest(): SubagentSpawnRequest {
  const toolContract = {
    version: 2,
    tools: [
      createToolEntry({
        kind: "function",
        name: "read_file",
        description: "Read a workspace file.",
        schemaDialect: "json-schema",
        strict: false,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        executionOwners: {
          foreground: {
            kind: "bridge-inline",
            operation: "read_file",
          },
          background: {
            kind: "bridge-inline",
            operation: "read_file",
          },
        },
      }),
      createToolEntry({
        kind: "function",
        name: "semantic_search",
        description: "Search the workspace semantically.",
        schemaDialect: "json-schema",
        strict: false,
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        executionOwners: {
          foreground: {
            kind: "bridge-deferred",
            family: "semantic_search",
          },
          background: {
            kind: "bridge-deferred",
            family: "semantic_search",
          },
        },
      }),
      createToolEntry({
        kind: "function",
        name: "edit_file_v2",
        description: "Apply an exact file edit through the Cursor client.",
        schemaDialect: "json-schema",
        strict: false,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            search: { type: "string" },
            replace: { type: "string" },
          },
          required: ["path", "search", "replace"],
          additionalProperties: false,
        },
        executionOwners: {
          foreground: {
            kind: "cursor-client",
            cursorDefinitionKey: "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
            protocolToolName: "edit_file_v2",
            execProtocol: {
              requestCase: "writeArgs",
              terminal: { transport: "single", resultCase: "writeResult" },
            },
          },
          background: null,
        },
      }),
    ],
    mcpRegistry: [],
  } satisfies SubagentToolContractFingerprintInput
  return {
    version: 3,
    systemPrompt: "You are a durable test sub-agent.",
    agentDefinitionFingerprint: TEST_AGENT_FINGERPRINT,
    maxTurns: null,
    modelRequestPolicy: {
      thinkingLevel: 1,
      thinkingDetailsRequested: false,
      contextTokenLimit: 128_000,
      contextTokenLimitSource: "requested",
      contextMaxMode: false,
      usedContextTokens: null,
      requestedMaxOutputTokens: 8192,
      requestedModelParameters: {},
    },
    promptContext: {
      projectContext: {
        rootPath: "/workspace",
        directories: ["/workspace"],
        files: [],
        workspaceFolders: [
          {
            uri: "file:///workspace",
            path: "/workspace",
            name: "workspace",
          },
        ],
      },
      codeChunks: [],
      cursorRules: [],
      skillOptions: null,
      selectedCursorRulePaths: [],
      selectedCursorRuleNames: [],
      activeCursorSkillNames: [],
      cursorCommands: [],
      customSystemPrompt: null,
      hooksAdditionalContext: null,
      explicitContext: null,
    },
    taskAttachments: { images: [] },
    childContextAttachmentSnapshot: {
      readPaths: [],
      fileStates: [],
      todos: [],
      sessionMemory: [],
      activeSubAgents: [],
    },
    workspace: TEST_WORKSPACE,
    requestEnvironment: {
      terminalsFolder: null,
      projectFolder: "/workspace",
      shell: null,
      timeZone: null,
      agentTranscriptsFolder: null,
      artifactsFolder: null,
    },
    toolContract: {
      ...toolContract,
      fingerprint: computeSubagentToolContractFingerprint(toolContract),
    },
  }
}

/** Explicit MCP scope used to prove child recovery never reads live MCP defs. */
export function createTestMcpSubagentSpawnRequest(): SubagentSpawnRequest {
  const request = createTestSubagentSpawnRequest()
  const mcpEntry = createToolEntry({
    kind: "function",
    name: "user-context7-resolve-library-id",
    description: "Resolve a library identifier from Context7.",
    schemaDialect: "json-schema",
    strict: false,
    inputSchema: {
      type: "object",
      properties: { libraryName: { type: "string" } },
      required: ["libraryName"],
      additionalProperties: false,
    },
    executionOwners: {
      foreground: {
        kind: "mcp-client",
        providerIdentifier: "context7",
        ideRegistryKey: "user-context7",
        toolName: "resolve-library-id",
        definitionName: "user-context7-resolve-library-id",
        modelToolName: "user-context7-resolve-library-id",
        execProtocol: {
          requestCase: "mcpArgs",
          terminal: { transport: "single", resultCase: "mcpResult" },
        },
      },
      background: null,
    },
  })
  const toolContract = {
    version: 2,
    tools: [mcpEntry],
    mcpRegistry: [
      {
        providerIdentifier: "context7",
        ideRegistryKey: "user-context7",
        tools: [
          {
            capabilityId: mcpEntry.capabilityId,
            definitionName: "user-context7-resolve-library-id",
            modelToolName: "user-context7-resolve-library-id",
            toolName: "resolve-library-id",
            description: mcpEntry.description,
            schemaSha256: mcpEntry.schemaSha256,
            inputSchema: mcpEntry.inputSchema,
          },
        ],
      },
    ],
  } satisfies SubagentToolContractFingerprintInput
  return {
    ...request,
    toolContract: {
      ...toolContract,
      fingerprint: computeSubagentToolContractFingerprint(toolContract),
    },
  }
}
