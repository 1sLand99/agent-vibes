import { createHash } from "node:crypto"
import { toJson } from "@bufbuild/protobuf"
import { CursorRuleSchema, SkillOptionsSchema } from "../../../gen/agent/v1_pb"
import {
  normalizeSubagentSpawnRequestBoundary,
  type SubagentChildContextAttachmentSnapshot,
  type SubagentModelRequestPolicy,
  type SubagentPromptContextSnapshot,
  type SubagentSpawnJsonObject,
  type SubagentSpawnJsonValue,
  type SubagentSpawnRequest,
  type SubagentTaskAttachmentSnapshot,
  type SubagentToolContract,
} from "../session/subagent-spawn-request"
import {
  getSubagentSystemPrompt,
  isCustomSubagent,
  type SubagentDefinition,
} from "./types"
import type { SessionRecord } from "../session/session-lifecycle.service"
import { assertContextTokenLimitProvenance } from "../session/context-window-transition"
import type { WorkspaceScope } from "../session/workspace-scope"

export interface SubagentSpawnEnvironmentSnapshot {
  readonly terminalsFolder: string | null
  readonly projectFolder: string | null
  readonly shell: string | null
  readonly timeZone: string | null
  readonly agentTranscriptsFolder: string | null
  readonly artifactsFolder: string | null
}

export interface CompileSubagentSpawnRequestInput {
  readonly agent: SubagentDefinition
  readonly finalSystemPrompt: string
  readonly maxTurns: number | null
  readonly modelRequestPolicy: SubagentModelRequestPolicy
  readonly promptContext: SubagentPromptContextSnapshot
  readonly taskAttachments: SubagentTaskAttachmentSnapshot
  readonly childContextAttachmentSnapshot: SubagentChildContextAttachmentSnapshot
  /** Live admission authority; compilation freezes it before persistence. */
  readonly workspaceScope: WorkspaceScope
  readonly requestEnvironment: SubagentSpawnEnvironmentSnapshot
  readonly toolContract: SubagentToolContract
}

export function snapshotSubagentModelRequestPolicy(
  session: Pick<
    SessionRecord,
    | "thinkingLevel"
    | "thinkingDetailsRequested"
    | "contextTokenLimit"
    | "contextTokenLimitSource"
    | "contextMaxMode"
    | "usedContextTokens"
    | "requestedMaxOutputTokens"
    | "requestedModelParameters"
  >
): SubagentModelRequestPolicy {
  assertContextTokenLimitProvenance(session)
  return {
    thinkingLevel: session.thinkingLevel,
    thinkingDetailsRequested: session.thinkingDetailsRequested,
    contextTokenLimit: session.contextTokenLimit ?? null,
    contextTokenLimitSource: session.contextTokenLimitSource ?? null,
    contextMaxMode: session.contextMaxMode === true,
    usedContextTokens: session.usedContextTokens ?? null,
    requestedMaxOutputTokens: session.requestedMaxOutputTokens ?? null,
    requestedModelParameters: {
      ...(session.requestedModelParameters ?? {}),
    },
  }
}

export function snapshotSubagentPromptContext(
  session: Pick<
    SessionRecord,
    | "workspace"
    | "codeChunks"
    | "cursorRules"
    | "skillOptions"
    | "selectedCursorRulePaths"
    | "selectedCursorRuleNames"
    | "activeCursorSkillNames"
    | "cursorCommands"
    | "customSystemPrompt"
    | "hooksAdditionalContext"
    | "explicitContext"
  >
): SubagentPromptContextSnapshot {
  const workspace = session.workspace
  if (!workspace) {
    throw new Error(
      "Subagent spawn requires a declared session workspace scope"
    )
  }
  const scope = workspace.scope
  const expectedIdeRoots = scope.primaryFirstIdeRoots
  if (workspace.presentation.folders.length !== expectedIdeRoots.length) {
    throw new Error(
      "Subagent spawn workspace presentation does not exactly represent frozen IDE roots"
    )
  }
  const workspaceFolders = expectedIdeRoots.map((rootPath, index) => {
    const folder = workspace.presentation.folders[index]
    if (!folder || folder.path !== rootPath) {
      throw new Error(
        "Subagent spawn workspace presentation has an IDE-root ordering mismatch"
      )
    }
    return {
      uri: folder.uri,
      path: rootPath,
      name: folder.name,
    }
  })

  return {
    // This is presentation only. Every path is derived from the immutable
    // session WorkspaceScope; projectContext is never reinterpreted as a
    // filesystem authority during child admission or recovery.
    projectContext: {
      rootPath: scope.primaryRoot,
      directories: [...expectedIdeRoots],
      files: [],
      workspaceFolders,
    },
    codeChunks: (session.codeChunks ?? []).map((chunk) => ({
      path: chunk.path,
      content: chunk.content,
      startLine: chunk.startLine ?? null,
      endLine: chunk.endLine ?? null,
    })),
    cursorRules: (session.cursorRules ?? []).map((rule, index) =>
      requireJsonObject(toJson(CursorRuleSchema, rule), `cursorRules[${index}]`)
    ),
    skillOptions: session.skillOptions
      ? requireJsonObject(
          toJson(SkillOptionsSchema, session.skillOptions),
          "skillOptions"
        )
      : null,
    selectedCursorRulePaths: [...(session.selectedCursorRulePaths ?? [])],
    selectedCursorRuleNames: [...(session.selectedCursorRuleNames ?? [])],
    activeCursorSkillNames: [...(session.activeCursorSkillNames ?? [])],
    cursorCommands: (session.cursorCommands ?? []).map((command) => ({
      name: command.name,
      content: command.content,
    })),
    customSystemPrompt: session.customSystemPrompt ?? null,
    hooksAdditionalContext: session.hooksAdditionalContext ?? null,
    explicitContext: session.explicitContext ?? null,
  }
}

export function snapshotSubagentRequestEnvironment(
  environment: SessionRecord["requestContextEnv"]
): SubagentSpawnEnvironmentSnapshot {
  return {
    terminalsFolder: environment?.terminalsFolder ?? null,
    projectFolder: environment?.projectFolder ?? null,
    shell: environment?.shell ?? null,
    timeZone: environment?.timeZone ?? null,
    agentTranscriptsFolder: environment?.agentTranscriptsFolder ?? null,
    artifactsFolder: environment?.artifactsFolder ?? null,
  }
}

interface ResolvedSubagentDefinitionFingerprintPayload extends SubagentSpawnJsonObject {
  readonly version: 2
  readonly agentType: string
  readonly source: SubagentDefinition["source"]
  readonly whenToUse: string
  readonly declaredTools: readonly string[] | null
  readonly disallowedTools: readonly string[]
  readonly inheritedMcpServers: readonly string[]
  readonly requiredMcpServers: readonly string[]
  readonly model: string | null
  readonly maxTurns: number | null
  readonly definitionPath: string | null
  readonly resolvedSystemPrompt: string
}

/**
 * Compile the complete immutable child request at the only point where live
 * agent/session/workspace inputs are allowed. Durable recovery consumes the
 * resulting request and never calls this function again.
 */
export function compileSubagentSpawnRequest(
  input: CompileSubagentSpawnRequestInput
): SubagentSpawnRequest {
  const resolvedSystemPrompt = getSubagentSystemPrompt(input.agent)
  const fingerprint = computeResolvedSubagentDefinitionFingerprint({
    agent: input.agent,
    resolvedSystemPrompt,
    maxTurns: input.maxTurns,
  })

  return normalizeSubagentSpawnRequestBoundary({
    version: 3,
    systemPrompt: input.finalSystemPrompt,
    agentDefinitionFingerprint: fingerprint,
    maxTurns: input.maxTurns,
    modelRequestPolicy: input.modelRequestPolicy,
    promptContext: input.promptContext,
    taskAttachments: input.taskAttachments,
    childContextAttachmentSnapshot: input.childContextAttachmentSnapshot,
    workspace: input.workspaceScope.toFrozenSnapshot(),
    requestEnvironment: input.requestEnvironment,
    toolContract: input.toolContract,
  }).request
}

export function computeResolvedSubagentDefinitionFingerprint(input: {
  readonly agent: SubagentDefinition
  readonly resolvedSystemPrompt?: string
  readonly maxTurns: number | null
}): string {
  const resolvedSystemPrompt =
    input.resolvedSystemPrompt ?? getSubagentSystemPrompt(input.agent)
  const payload: ResolvedSubagentDefinitionFingerprintPayload = {
    version: 2,
    agentType: input.agent.agentType,
    source: input.agent.source,
    whenToUse: input.agent.whenToUse,
    declaredTools: input.agent.tools ? [...input.agent.tools] : null,
    disallowedTools: [...(input.agent.disallowedTools ?? [])],
    inheritedMcpServers: [...(input.agent.inheritedMcpServers ?? [])],
    requiredMcpServers: [...(input.agent.requiredMcpServers ?? [])],
    model: input.agent.model ?? null,
    maxTurns: input.maxTurns,
    definitionPath: isCustomSubagent(input.agent) ? input.agent.filePath : null,
    resolvedSystemPrompt,
  }
  return `sha256:${createHash("sha256")
    .update(canonicalSpawnJson(payload))
    .digest("hex")}`
}

export const EMPTY_SUBAGENT_TASK_ATTACHMENTS: SubagentTaskAttachmentSnapshot =
  Object.freeze({ images: Object.freeze([]) })

/** Claude Code child isolation: no parent mutable attachment state is copied. */
export const EMPTY_SUBAGENT_CONTEXT_ATTACHMENTS: SubagentChildContextAttachmentSnapshot =
  Object.freeze({
    readPaths: Object.freeze([]),
    fileStates: Object.freeze([]),
    todos: Object.freeze([]),
    sessionMemory: Object.freeze([]),
    activeSubAgents: Object.freeze([]),
  })

function canonicalSpawnJson(value: SubagentSpawnJsonValue): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Resolved subagent definition contains a non-finite number"
      )
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const arrayValue = value as readonly SubagentSpawnJsonValue[]
    return `[${arrayValue.map((entry) => canonicalSpawnJson(entry)).join(",")}]`
  }
  const objectValue = value as SubagentSpawnJsonObject
  return `{${Object.keys(objectValue)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalSpawnJson(objectValue[key]!)}`
    )
    .join(",")}}`
}

function requireJsonObject(
  value: unknown,
  label: string
): SubagentSpawnJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Subagent prompt snapshot ${label} is not a JSON object`)
  }
  return value as SubagentSpawnJsonObject
}
