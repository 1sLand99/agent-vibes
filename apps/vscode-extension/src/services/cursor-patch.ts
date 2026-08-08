import * as childProcess from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { logger as LoggerInstance } from "../utils/logger"
import {
  getCursorGlobalStorageStateDbPath,
  getCursorWorkbenchPath,
  getDefaultDataDir,
} from "../utils/platform"
import { CursorChecksumsService } from "./cursor-checksums"
import {
  CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKERS,
  getCursorAgentInputDockDetails,
  hasCursorAgentInputDockPatch,
  patchCursorAgentInputDockContent,
  removeCursorAgentInputDockPatchContent,
} from "./cursor-agent-input-dock"
import {
  getCursorWorkspaceControlDetails,
  hasCursorWorkspaceControlPatch,
  patchCursorWorkspaceControlContent,
  readWorkspaceControlRuntimeConfig,
  removeCursorWorkspaceControlPatchContent,
  type WorkspaceControlRuntimeConfig,
} from "./cursor-workspace-control"
import { CursorPatchBaselineService } from "./cursor-patch-baseline"
import {
  CURSOR_TRAFFIC_CAPTURE_MARKERS,
  CURSOR_TRAFFIC_CAPTURE_RULES,
  getCursorTrafficCaptureDetails,
  patchCursorTrafficCaptureContent,
  patchCursorTrafficCaptureRules,
} from "./cursor-traffic-capture"

type Logger = typeof LoggerInstance

const BACKUP_SUFFIX = ".transport_backup"
const IDLE_EXTENSION_HOST_KILLER_MARKER =
  "[AGENT_VIBES_DISABLE_IDLE_EXTENSION_HOST_KILLER]"
const IDLE_EXTENSION_HOST_KILLER_PATCH_INSERTION = `/*${IDLE_EXTENSION_HOST_KILLER_MARKER}*/return;`
const BRIDGE_ENDPOINT_PATCH_MARKER = "[AGENT_VIBES_CURSOR_BRIDGE_ENDPOINT]"
const PLAN_EDITOR_TAB_PATCH_MARKER =
  "[AGENT_VIBES_PRESERVE_CHAT_EDITOR_TAB_FOR_PLAN]"
const WORKSPACE_CHANGE_AGENT_GATE_TRACK_MARKER =
  "[AGENT_VIBES_WORKSPACE_CHANGE_AGENT_GATE_TRACK]"
const WORKSPACE_CHANGE_AGENT_GATE_RELEASE_MARKER =
  "[AGENT_VIBES_WORKSPACE_CHANGE_AGENT_GATE_RELEASE]"
const WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_MARKER =
  "[AGENT_VIBES_WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE]"
const WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_RELEASE_MARKER =
  "[AGENT_VIBES_WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_RELEASE]"
const WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_MARKER =
  "[AGENT_VIBES_WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION]"
const WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_RELEASE_MARKER =
  "[AGENT_VIBES_WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_RELEASE]"
const WORKSPACE_CHANGE_AGENT_GATE_MARKERS = [
  WORKSPACE_CHANGE_AGENT_GATE_TRACK_MARKER,
  WORKSPACE_CHANGE_AGENT_GATE_RELEASE_MARKER,
  WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_MARKER,
  WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_RELEASE_MARKER,
  WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_MARKER,
  WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_RELEASE_MARKER,
]
const WORKSPACE_CHANGE_AGENT_GATE_STATE_KEY =
  "__agentVibesWorkspaceChangeAgentGate"
const WORKSPACE_CHANGE_AGENT_TURN_TRACKED_KEY =
  "__agentVibesWorkspaceChangeTurnTracked"
const READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER =
  "[AGENT_VIBES_READ_TODOS_BUBBLE_TRANSLATION]"
const READ_TODOS_RESULT_TRANSLATION_PATCH_MARKER =
  "[AGENT_VIBES_READ_TODOS_RESULT_TRANSLATION]"
const BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER =
  "[AGENT_VIBES_CURSOR_CREDENTIALS_GUARD]"
const BRIDGE_ENDPOINT_GUARD_SCAN_BYTES = 1024
const SEMANTIC_METHOD_LOCAL_SEARCH_BYTES = 64 * 1024
const CURSOR_OPEN_AGENTS_WINDOW_ON_STARTUP_KEY =
  "cursor/userOpenAgentsWindowOnStartupPreference"
const CURSOR_FIRST_WINDOW_OPEN_GLASS_TREATMENT_KEY =
  "cursor/firstWindowOpenGlassTreatment"
const CURSOR_GLASS_STARTUP_HANDOFF_KEY = "cursor.glass.startupHandoff"
const CURSOR_APPLICATION_USER_STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser"
const CURSOR_AUTH_MEMBERSHIP_TYPE_KEY = "cursorAuth/stripeMembershipType"
const CURSOR_AUTH_SUBSCRIPTION_STATUS_KEY =
  "cursorAuth/stripeSubscriptionStatus"
const CURSOR_ENTITLEMENT_MEMBERSHIP_TYPE = "ultra"
const CURSOR_ENTITLEMENT_SUBSCRIPTION_STATUS = "active"
const CURSOR_NODE_EXTRA_CA_CERTS_ENV_KEY = "NODE_EXTRA_CA_CERTS"
const IDLE_EXTENSION_HOST_KILLER_PATCH = {
  name: "Disable Cursor Idle Extension Host Killer",
  marker: IDLE_EXTENSION_HOST_KILLER_MARKER,
}

const BRIDGE_ENDPOINT_PATCH = {
  name: "Cursor Bridge Endpoint",
  marker: BRIDGE_ENDPOINT_PATCH_MARKER,
}

const PLAN_EDITOR_TAB_PATCH = {
  name: "Preserve Chat Editor Tab When Opening Plan",
  marker: PLAN_EDITOR_TAB_PATCH_MARKER,
}

const WORKSPACE_CHANGE_AGENT_GATE_PATCH = {
  name: "Defer Workspace Folder Changes During Agent Turns",
}

const READ_TODOS_TRANSLATION_PATCH = {
  name: "Cursor Read Todos Translation",
}

const CURSOR_ENTITLEMENT_PATCH = {
  name: "Cursor Entitlement State",
}

const PATCH_MARKERS = [
  IDLE_EXTENSION_HOST_KILLER_MARKER,
  BRIDGE_ENDPOINT_PATCH_MARKER,
  ...CURSOR_AGENT_INPUT_RUNTIME_PATCH_MARKERS,
  PLAN_EDITOR_TAB_PATCH_MARKER,
  ...WORKSPACE_CHANGE_AGENT_GATE_MARKERS,
  READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER,
  READ_TODOS_RESULT_TRANSLATION_PATCH_MARKER,
  ...CURSOR_TRAFFIC_CAPTURE_MARKERS,
]

type IdleExtensionHostKillerLocation = {
  methodStart: number
  bodyStart: number
  bodyEnd: number
}

type MethodLocation = {
  start: number
  bodyStart: number
  end: number
}

type BridgeEndpointSegmentSummary = {
  hasMarker: boolean
  localCount: number
  matchingLocalCount: number
}

type CursorStartupPreferencePatchDetails = {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  canApply: boolean
  changed: boolean
  sql: string | null
  error: string | null
}

type CursorPersistentEndpointPatchDetails = {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  canApply: boolean
  changed: boolean
  currentUrl: string | null
  sql: string | null
  error: string | null
}

type CursorEntitlementPatchDetails = {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  canApply: boolean
  changed: boolean
  currentMembershipType: string | null
  currentSubscriptionStatus: string | null
  sql: string | null
  error: string | null
}

type CursorNodeCaPatchDetails = {
  caCertPath: string | null
  fileExists: boolean
  applied: boolean
  canApply: boolean
  changed: boolean
  currentValue: string | null
  error: string | null
}

type CursorApplicationUserEndpointNormalization = {
  value: string
  changed: boolean
  currentUrl: string | null
}

type CursorApplicationUserEntitlementNormalization = {
  value: string
  changed: boolean
  currentMembershipType: string | null
  currentSubscriptionStatus: string | null
}

export function locateIdleExtensionHostKillerMethod(
  content: string
): IdleExtensionHostKillerLocation | null {
  const anchor = "idle_extension_host_killer_config"
  let anchorIndex = content.indexOf(anchor)
  while (anchorIndex >= 0) {
    const evidenceStart = Math.max(
      0,
      anchorIndex - SEMANTIC_METHOD_LOCAL_SEARCH_BYTES
    )
    const evidenceEnd = Math.min(
      content.length,
      anchorIndex + SEMANTIC_METHOD_LOCAL_SEARCH_BYTES
    )
    if (
      !isIdleExtensionHostKillerMethodBody(
        content.slice(evidenceStart, evidenceEnd)
      )
    ) {
      anchorIndex = content.indexOf(anchor, anchorIndex + 1)
      continue
    }

    const method = locateSemanticMethodAt(
      content,
      anchorIndex,
      isIdleExtensionHostKillerMethodBody
    )
    if (method !== null) {
      return {
        methodStart: method.start,
        bodyStart: method.bodyStart + 1,
        bodyEnd: method.end,
      }
    }
    anchorIndex = content.indexOf(anchor, anchorIndex + 1)
  }

  return null
}

export function canPatchIdleExtensionHostKillerContent(
  content: string
): boolean {
  return (
    content.includes(IDLE_EXTENSION_HOST_KILLER_MARKER) ||
    locateIdleExtensionHostKillerMethod(content) !== null
  )
}

export function patchIdleExtensionHostKillerContent(
  content: string
): string | null {
  if (content.includes(IDLE_EXTENSION_HOST_KILLER_MARKER)) {
    return content
  }
  const location = locateIdleExtensionHostKillerMethod(content)
  if (!location) {
    return null
  }
  return (
    content.slice(0, location.bodyStart) +
    IDLE_EXTENSION_HOST_KILLER_PATCH_INSERTION +
    content.slice(location.bodyStart)
  )
}

type WorkspaceChangeAgentGateLocations = {
  composerConstructor: MethodLocation
  composerDispose: MethodLocation
  workspaceInitialize: MethodLocation
  workspaceConfiguration: MethodLocation
}

function locateSemanticMethodByAnchor(
  content: string,
  anchor: string,
  predicate: (body: string) => boolean
): MethodLocation | null {
  let anchorIndex = content.indexOf(anchor)
  while (anchorIndex !== -1) {
    const method = locateSemanticMethodAt(content, anchorIndex, predicate)
    if (method) return method
    anchorIndex = content.indexOf(anchor, anchorIndex + anchor.length)
  }
  return null
}

function locateWorkspaceChangeAgentGateLocations(
  content: string
): WorkspaceChangeAgentGateLocations | null {
  const composerConstructor = locateSemanticMethodByAnchor(
    content,
    "this._setupReactiveWatch()",
    (body) =>
      body.includes("this._composerHandle=") &&
      body.includes("this._powerMainService=") &&
      body.includes('this._acquire("agent-loop")') &&
      body.includes("this._setupReactiveWatch()")
  )
  const composerDispose = locateSemanticMethodByAnchor(
    content,
    'this._release("generation-ended")',
    (body) =>
      body.includes("this._disposed") &&
      body.includes('this._release("generation-ended")')
  )
  const workspaceInitialize = locateSemanticMethodByAnchor(
    content,
    'logWorkspaceFoldersChanged("initializeWorkspace"',
    (body) =>
      body.includes('logWorkspaceFoldersChanged("initializeWorkspace"') &&
      body.includes("this.workspace.update(") &&
      body.includes("this.initializeConfiguration(") &&
      body.includes("this._onDidChangeWorkspaceFolders.fire(")
  )
  const workspaceConfiguration = locateSemanticMethodByAnchor(
    content,
    'logWorkspaceFoldersChanged("updateWorkspaceConfiguration"',
    (body) =>
      body.includes(
        'logWorkspaceFoldersChanged("updateWorkspaceConfiguration"'
      ) &&
      body.includes("this.compareFolders(") &&
      body.includes("this.onFoldersChanged()") &&
      body.includes("this.handleWillChangeWorkspaceFolders(") &&
      body.includes("this._onDidChangeWorkspaceFolders.fire(")
  )

  if (
    !composerConstructor ||
    !composerDispose ||
    !workspaceInitialize ||
    !workspaceConfiguration
  ) {
    return null
  }

  return {
    composerConstructor,
    composerDispose,
    workspaceInitialize,
    workspaceConfiguration,
  }
}

function getFirstMethodParameter(
  content: string,
  location: MethodLocation
): string | null {
  const signature = content.slice(location.start, location.bodyStart)
  return /\(\s*([A-Za-z_$][\w$]*)/u.exec(signature)?.[1] ?? null
}

function hasAnyWorkspaceChangeAgentGateMarker(content: string): boolean {
  return WORKSPACE_CHANGE_AGENT_GATE_MARKERS.some((marker) =>
    content.includes(marker)
  )
}

export function isWorkspaceChangeAgentGatePatchApplied(
  content: string
): boolean {
  return WORKSPACE_CHANGE_AGENT_GATE_MARKERS.every((marker) =>
    content.includes(marker)
  )
}

export function canPatchWorkspaceChangeAgentGateContent(
  content: string
): boolean {
  if (isWorkspaceChangeAgentGatePatchApplied(content)) return true
  if (hasAnyWorkspaceChangeAgentGateMarker(content)) return false
  return locateWorkspaceChangeAgentGateLocations(content) !== null
}

function createWorkspaceChangeWaitInsertion(
  marker: string,
  nextFoldersExpression: string
): string {
  const state = `globalThis[${JSON.stringify(
    WORKSPACE_CHANGE_AGENT_GATE_STATE_KEY
  )}]`
  return (
    `/*${marker}*/` +
    "let __agentVibesReleaseWorkspaceChange;" +
    "let __agentVibesPreviousWorkspaceChange=Promise.resolve();" +
    "{" +
    `const __agentVibesWorkspaceChanges=this.workspace?this.compareFolders(this.workspace.folders,${nextFoldersExpression}):null;` +
    "if(__agentVibesWorkspaceChanges&&(__agentVibesWorkspaceChanges.added.length||__agentVibesWorkspaceChanges.removed.length||__agentVibesWorkspaceChanges.changed.length)){" +
    `const __agentVibesWorkspaceGateState=(${state}??={activeTurns:0,waiters:[]});` +
    "__agentVibesWorkspaceGateState.workspaceTail??=Promise.resolve();" +
    "__agentVibesPreviousWorkspaceChange=__agentVibesWorkspaceGateState.workspaceTail;" +
    "__agentVibesWorkspaceGateState.workspaceTail=new Promise(__agentVibesResolve=>{__agentVibesReleaseWorkspaceChange=__agentVibesResolve})" +
    "}}" +
    "try{" +
    "if(__agentVibesReleaseWorkspaceChange){" +
    "await __agentVibesPreviousWorkspaceChange;" +
    "let __agentVibesWorkspaceChangeDeferred=!1;" +
    `while(${state}?.activeTurns>0){` +
    'if(!__agentVibesWorkspaceChangeDeferred){this.logService.info("[Agent Vibes] Deferring workspace folder change until active agent turns finish"),__agentVibesWorkspaceChangeDeferred=!0}' +
    "await new Promise(__agentVibesResolve=>{" +
    `const __agentVibesWorkspaceGateState=${state};` +
    "__agentVibesWorkspaceGateState&&__agentVibesWorkspaceGateState.activeTurns>0?__agentVibesWorkspaceGateState.waiters.push(__agentVibesResolve):__agentVibesResolve()" +
    "})}" +
    'if(__agentVibesWorkspaceChangeDeferred)this.logService.info("[Agent Vibes] Applying deferred workspace folder change")' +
    "}"
  )
}

function createWorkspaceChangeQueueReleaseInsertion(marker: string): string {
  return (
    `}finally{/*${marker}*/` +
    "if(__agentVibesReleaseWorkspaceChange)__agentVibesReleaseWorkspaceChange()" +
    "}"
  )
}

export function patchWorkspaceChangeAgentGateContent(
  content: string
): string | null {
  if (isWorkspaceChangeAgentGatePatchApplied(content)) return content
  if (hasAnyWorkspaceChangeAgentGateMarker(content)) return null

  const locations = locateWorkspaceChangeAgentGateLocations(content)
  if (!locations) return null

  const initializeWorkspaceParameter = getFirstMethodParameter(
    content,
    locations.workspaceInitialize
  )
  const configurationFoldersParameter = getFirstMethodParameter(
    content,
    locations.workspaceConfiguration
  )
  if (!initializeWorkspaceParameter || !configurationFoldersParameter) {
    return null
  }

  const state = `globalThis[${JSON.stringify(
    WORKSPACE_CHANGE_AGENT_GATE_STATE_KEY
  )}]`
  const tracked = `this[${JSON.stringify(
    WORKSPACE_CHANGE_AGENT_TURN_TRACKED_KEY
  )}]`
  const insertions = [
    {
      index: locations.composerConstructor.end - 1,
      text:
        `;/*${WORKSPACE_CHANGE_AGENT_GATE_TRACK_MARKER}*/` +
        `${tracked}=!0;` +
        `${state}??={activeTurns:0,waiters:[]};` +
        `${state}.activeTurns++`,
    },
    {
      index: locations.composerDispose.bodyStart + 1,
      text:
        `/*${WORKSPACE_CHANGE_AGENT_GATE_RELEASE_MARKER}*/` +
        `if(${tracked}){${tracked}=!1;` +
        `const __agentVibesWorkspaceGateState=${state};` +
        "if(__agentVibesWorkspaceGateState){" +
        "__agentVibesWorkspaceGateState.activeTurns=Math.max(0,__agentVibesWorkspaceGateState.activeTurns-1);" +
        "if(__agentVibesWorkspaceGateState.activeTurns===0){" +
        "for(const __agentVibesResolve of __agentVibesWorkspaceGateState.waiters.splice(0))__agentVibesResolve()" +
        "}}};",
    },
    {
      index: locations.workspaceInitialize.bodyStart + 1,
      text: createWorkspaceChangeWaitInsertion(
        WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_MARKER,
        `${initializeWorkspaceParameter}.folders`
      ),
    },
    {
      index: locations.workspaceInitialize.end - 1,
      text: createWorkspaceChangeQueueReleaseInsertion(
        WORKSPACE_CHANGE_AGENT_GATE_INITIALIZE_RELEASE_MARKER
      ),
    },
    {
      index: locations.workspaceConfiguration.bodyStart + 1,
      text: createWorkspaceChangeWaitInsertion(
        WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_MARKER,
        configurationFoldersParameter
      ),
    },
    {
      index: locations.workspaceConfiguration.end - 1,
      text: createWorkspaceChangeQueueReleaseInsertion(
        WORKSPACE_CHANGE_AGENT_GATE_CONFIGURATION_RELEASE_MARKER
      ),
    },
  ].sort((left, right) => right.index - left.index)

  let nextContent = content
  for (const insertion of insertions) {
    nextContent =
      nextContent.slice(0, insertion.index) +
      insertion.text +
      nextContent.slice(insertion.index)
  }

  return isWorkspaceChangeAgentGatePatchApplied(nextContent)
    ? nextContent
    : null
}

function locatePlanEditorOpenMethod(content: string): MethodLocation | null {
  const pattern = /async\s+openPlanInEditor\s*\([^)]*\)\s*\{/gu
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const bodyStart = match.index + match[0].lastIndexOf("{")
    const end = findMatchingBrace(content, bodyStart)
    if (end === null) continue
    const body = content.slice(bodyStart + 1, end)
    const isPlanEditorOpen =
      body.includes(".composerId") &&
      body.includes(".selectedComposerId") &&
      body.includes(".openEditor(") &&
      body.includes("preserveFocus")
    if (!isPlanEditorOpen) continue
    return { start: match.index, bodyStart, end }
  }

  return null
}

/**
 * Cursor opens plans in the editor by default. When the active Chat editor is
 * still a preview tab, opening the plan replaces that preview and Composer
 * subsequently falls back to the side pane. Pin the existing Chat editor just
 * before the native plan open so the plan becomes a sibling editor tab.
 */
export function patchPlanEditorTabContent(content: string): string | null {
  if (content.includes(PLAN_EDITOR_TAB_PATCH_MARKER)) return content

  const location = locatePlanEditorOpenMethod(content)
  if (!location) return null
  const body = content.slice(location.bodyStart + 1, location.end)
  const composerIdMatch =
    /const ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.composerId,/u.exec(body)
  const openEditorMatch =
    /await this\.[A-Za-z_$][\w$]*\.openEditor\(\{resource:/u.exec(body)
  const composerIdVariable = composerIdMatch?.[1]
  if (!composerIdVariable || !openEditorMatch) return null

  const insertionAt = location.bodyStart + 1 + openEditorMatch.index
  const insertion =
    `${composerIdVariable}&&this._composerViewsService.pinComposerEditor(${composerIdVariable}),` +
    `/*${PLAN_EDITOR_TAB_PATCH_MARKER}*/`
  return content.slice(0, insertionAt) + insertion + content.slice(insertionAt)
}

export function isPlanEditorTabPatchApplied(content: string): boolean {
  const location = locatePlanEditorOpenMethod(content)
  return (
    location !== null &&
    content
      .slice(location.bodyStart + 1, location.end)
      .includes(PLAN_EDITOR_TAB_PATCH_MARKER)
  )
}

type CaseBlockLocation = {
  start: number
  bodyStart: number
  end: number
}

function locateCaseBlocks(
  content: string,
  caseName: string
): CaseBlockLocation[] {
  const pattern = new RegExp(`case"${caseName}":\\{`, "gu")
  const locations: CaseBlockLocation[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const bodyStart = match.index + match[0].lastIndexOf("{")
    const end = findMatchingBrace(content, bodyStart)
    if (end === null) continue
    locations.push({ start: match.index, bodyStart, end })
  }

  return locations
}

function resolveCursorMessageTypeSymbol(
  content: string,
  messageType: string
): string | null {
  const escapedType = messageType.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const pattern = new RegExp(
    `([A-Za-z_$][\\w$]*)=[A-Za-z_$][\\w$]*\\.makeMessageType\\("${escapedType}"`,
    "u"
  )
  return pattern.exec(content)?.[1] ?? null
}

function resolveCursorTodoReadSymbols(
  content: string,
  todoItemSymbol: string
): { params: string; result: string } | null {
  const escapedSymbol = todoItemSymbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const todoItemPattern = new RegExp(
    `${escapedSymbol}=[A-Za-z_$][\\w$]*\\.makeMessageType\\("aiserver\\.v1\\.TodoItem"`,
    "u"
  )
  const todoItemDefinition = todoItemPattern.exec(content)
  if (todoItemDefinition?.index === undefined) return null

  const localDefinitions = content.slice(
    Math.max(0, todoItemDefinition.index - 2_000),
    Math.min(content.length, todoItemDefinition.index + 2_000)
  )
  const params = resolveCursorMessageTypeSymbol(
    localDefinitions,
    "aiserver.v1.TodoReadParams"
  )
  const result = resolveCursorMessageTypeSymbol(
    localDefinitions,
    "aiserver.v1.TodoReadResult"
  )
  return params && result ? { params, result } : null
}

function hasUnsupportedReadTodosTranslation(content: string): boolean {
  return /case"readTodosToolCall":(?=(?:case"[^"]+":)+throw new Error\(`Unsupported tool type for (?:bubble|result) translation:)/u.test(
    content
  )
}

/**
 * Cursor 3.11 exposes ReadTodosToolCall in agent.v1 and renders its live card,
 * but its ToolCall -> legacy ToolFormer translators still reject that oneof.
 * Complete both conversions using symbols discovered from the adjacent native
 * UpdateTodos conversion instead of depending on minified identifier names.
 */
export function patchReadTodosTranslationContent(
  content: string
): string | null {
  if (!hasUnsupportedReadTodosTranslation(content)) {
    return content
  }

  const updateTodoBlocks = locateCaseBlocks(content, "updateTodosToolCall")
  let bubbleInsertion: { at: number; value: string } | null = null
  let resultInsertion: { at: number; value: string } | null = null

  for (const location of updateTodoBlocks) {
    const body = content.slice(location.bodyStart, location.end + 1)
    if (!bubbleInsertion && body.includes(".TODO_WRITE")) {
      const bubbleMatch =
        /^\{([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.TODO_WRITE;const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.tool\.value\.args;\3&&\(([A-Za-z_$][\w$]*)=new /u.exec(
          body
        )
      const todoMappingMatch =
        /new ([A-Za-z_$][\w$]*)\(\{id:([A-Za-z_$][\w$]*)\.id,content:\2\.content,status:([A-Za-z_$][\w$]*)\(\2\.status\),dependencies:\2\.dependencies\}\)/u.exec(
          body
        )
      const readSymbols = todoMappingMatch
        ? resolveCursorTodoReadSymbols(content, todoMappingMatch[1]!)
        : null
      if (bubbleMatch && readSymbols) {
        const [, toolVariable, toolEnum, argsVariable, source, paramsVariable] =
          bubbleMatch
        if (
          !toolVariable ||
          !toolEnum ||
          !argsVariable ||
          !source ||
          !paramsVariable
        ) {
          return null
        }
        bubbleInsertion = {
          at: location.end + 1,
          value:
            `case"readTodosToolCall":{/*${READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER}*/` +
            `${toolVariable}=${toolEnum}.TODO_READ;const ${argsVariable}=${source}.tool.value.args;` +
            `${argsVariable}&&(${paramsVariable}=new ${readSymbols.params}({read:!0}));break}`,
        }
      }
    }

    if (
      !resultInsertion &&
      body.includes(".tool=") &&
      body.includes(".TODO_WRITE")
    ) {
      const resultMatch =
        /^\{const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.tool\.value;if\(([A-Za-z_$][\w$]*)\.tool=([A-Za-z_$][\w$]*)\.TODO_WRITE,/u.exec(
          body
        )
      const todoMappingMatch =
        /new ([A-Za-z_$][\w$]*)\(\{id:([A-Za-z_$][\w$]*)\.id,content:\2\.content,status:([A-Za-z_$][\w$]*)\(\2\.status\),dependencies:\2\.dependencies\}\)/u.exec(
          body
        )
      if (resultMatch && todoMappingMatch) {
        const [, callVariable, source, outputVariable, toolEnum] = resultMatch
        const [, nativeTodoItem, , normalizeStatus] = todoMappingMatch
        if (
          !callVariable ||
          !source ||
          !outputVariable ||
          !toolEnum ||
          !nativeTodoItem ||
          !normalizeStatus
        ) {
          return null
        }
        const readSymbols = resolveCursorTodoReadSymbols(
          content,
          nativeTodoItem
        )
        if (!readSymbols) return null
        resultInsertion = {
          at: location.end + 1,
          value:
            `case"readTodosToolCall":{/*${READ_TODOS_RESULT_TRANSLATION_PATCH_MARKER}*/` +
            `const ${callVariable}=${source}.tool.value;${outputVariable}.tool=${toolEnum}.TODO_READ;` +
            `if(${callVariable}.result?.result?.case==="success"){const agentVibesReadResult=${callVariable}.result.result.value;` +
            `${outputVariable}.result={case:"todoReadResult",value:new ${readSymbols.result}({todos:(agentVibesReadResult.todos??[]).map(agentVibesTodo=>new ${nativeTodoItem}({id:agentVibesTodo.id,content:agentVibesTodo.content,status:${normalizeStatus}(agentVibesTodo.status),dependencies:agentVibesTodo.dependencies}))})}}` +
            `else ${callVariable}.result?.result?.case==="error"&&(${outputVariable}.result={case:"todoReadResult",value:new ${readSymbols.result}({todos:[]})});break}`,
        }
      }
    }
  }

  if (
    (!content.includes(READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER) &&
      !bubbleInsertion) ||
    (!content.includes(READ_TODOS_RESULT_TRANSLATION_PATCH_MARKER) &&
      !resultInsertion)
  ) {
    return null
  }

  let nextContent = content
  const insertions = [bubbleInsertion, resultInsertion]
    .filter((entry): entry is { at: number; value: string } => entry !== null)
    .sort((left, right) => right.at - left.at)
  for (const insertion of insertions) {
    const marker = insertion.value.includes(
      READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER
    )
      ? READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER
      : READ_TODOS_RESULT_TRANSLATION_PATCH_MARKER
    if (nextContent.includes(marker)) continue
    nextContent =
      nextContent.slice(0, insertion.at) +
      insertion.value +
      nextContent.slice(insertion.at)
  }

  nextContent = nextContent.replace(
    /case"readTodosToolCall":(?=(?:case"[^"]+":)+throw new Error\(`Unsupported tool type for (?:bubble|result) translation:)/gu,
    ""
  )
  return hasUnsupportedReadTodosTranslation(nextContent) ? null : nextContent
}

export function isReadTodosTranslationPatchApplied(content: string): boolean {
  return !hasUnsupportedReadTodosTranslation(content)
}

type CursorWorkbenchPatchExclusion = "trafficCapture"

function rebuildCursorWorkbenchWithActivePatches(
  currentContent: string,
  originalContent: string,
  exclusions: ReadonlySet<CursorWorkbenchPatchExclusion>
): string | null {
  if (PATCH_MARKERS.some((marker) => originalContent.includes(marker))) {
    return null
  }

  let nextContent = originalContent
  if (currentContent.includes(BRIDGE_ENDPOINT_PATCH_MARKER)) {
    const bridgePort = getAppliedBridgeEndpointPort(currentContent)
    if (bridgePort === null) return null
    const patched = patchBridgeEndpointContent(nextContent, bridgePort)
    if (patched === null) return null
    nextContent = patched
  }
  if (currentContent.includes(IDLE_EXTENSION_HOST_KILLER_MARKER)) {
    const patched = patchIdleExtensionHostKillerContent(nextContent)
    if (patched === null) return null
    nextContent = patched
  }
  if (hasCursorAgentInputDockPatch(currentContent)) {
    const patched = patchCursorAgentInputDockContent(nextContent)
    if (patched === null) return null
    nextContent = patched
  }
  if (hasCursorWorkspaceControlPatch(currentContent)) {
    const runtimeConfig = readWorkspaceControlRuntimeConfig(currentContent)
    if (runtimeConfig === null) return null
    const patched = patchCursorWorkspaceControlContent(
      nextContent,
      runtimeConfig
    )
    if (patched === null) return null
    nextContent = patched
  }
  if (currentContent.includes(PLAN_EDITOR_TAB_PATCH_MARKER)) {
    const patched = patchPlanEditorTabContent(nextContent)
    if (patched === null) return null
    nextContent = patched
  }
  if (hasAnyWorkspaceChangeAgentGateMarker(currentContent)) {
    const patched = patchWorkspaceChangeAgentGateContent(nextContent)
    if (patched === null) return null
    nextContent = patched
  }
  if (
    currentContent.includes(READ_TODOS_BUBBLE_TRANSLATION_PATCH_MARKER) ||
    currentContent.includes(READ_TODOS_RESULT_TRANSLATION_PATCH_MARKER)
  ) {
    const patched = patchReadTodosTranslationContent(nextContent)
    if (patched === null) return null
    nextContent = patched
  }
  if (!exclusions.has("trafficCapture")) {
    const activeCaptureRules =
      getCursorTrafficCaptureDetails(currentContent).appliedRuleNames
    if (activeCaptureRules.length > 0) {
      const patched = patchCursorTrafficCaptureRules(
        nextContent,
        activeCaptureRules
      )
      if (patched === null) return null
      nextContent = patched
    }
  }
  return nextContent
}

export function rebuildCursorWorkbenchWithoutTrafficCapture(
  currentContent: string,
  originalContent: string
): string | null {
  return rebuildCursorWorkbenchWithActivePatches(
    currentContent,
    originalContent,
    new Set(["trafficCapture"])
  )
}

function normalizeBridgePort(port: number): number {
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 2026
}

export function getCursorBridgeEndpointUrl(port: number): string {
  return `https://localhost:${normalizeBridgePort(port)}`
}

function getAppliedBridgeEndpointPort(content: string): number | null {
  if (!content.includes(BRIDGE_ENDPOINT_PATCH_MARKER)) return null
  const endpoints = getBridgeEndpointCredentialsGuardEndpoints(content)
  if (endpoints.length !== 1) return null
  const portMatch = /:(\d+)$/u.exec(endpoints[0]!)
  if (!portMatch?.[1]) return null
  const port = Number.parseInt(portMatch[1], 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function getCursorWorkbenchPaths(): string[] {
  const desktopPath = getCursorWorkbenchPath()
  if (!desktopPath || !fs.existsSync(desktopPath)) {
    return []
  }

  const paths = [desktopPath]
  const glassPath = desktopPath.replace(
    /workbench\.desktop\.main\.js$/u,
    "workbench.glass.main.js"
  )
  if (glassPath !== desktopPath && fs.existsSync(glassPath)) {
    paths.push(glassPath)
  }

  return [...new Set(paths)]
}

function isLocalBridgeEndpoint(value: string | null): boolean {
  return value !== null && /^https:\/\/localhost:\d+$/u.test(value)
}

function getLocalBridgeEndpointLiterals(content: string): string[] {
  const endpoints: string[] = []
  const localEndpointLiteralPattern = /(["'`])(https:\/\/localhost:\d+)\1/gu
  let match: RegExpExecArray | null
  while ((match = localEndpointLiteralPattern.exec(content)) !== null) {
    const value = match[2]
    if (value !== undefined && isLocalBridgeEndpoint(value)) {
      endpoints.push(value)
    }
  }
  return endpoints
}

function getBridgeEndpointCredentialsGuardSegment(
  content: string
): string | null {
  const markerIndex = content.indexOf(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)
  if (
    markerIndex < 0 ||
    content.indexOf(
      BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER,
      markerIndex + BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER.length
    ) >= 0
  ) {
    return null
  }

  return content.slice(
    Math.max(0, markerIndex - 128),
    Math.min(content.length, markerIndex + BRIDGE_ENDPOINT_GUARD_SCAN_BYTES)
  )
}

function getBridgeEndpointCredentialsGuardEndpoints(content: string): string[] {
  const segment = getBridgeEndpointCredentialsGuardSegment(content)
  return segment === null ? [] : getLocalBridgeEndpointLiterals(segment)
}

function summarizeLocalBridgeEndpoints(
  content: string,
  bridgeUrl: string
): BridgeEndpointSegmentSummary {
  const summary: BridgeEndpointSegmentSummary = {
    hasMarker: content.includes(BRIDGE_ENDPOINT_PATCH_MARKER),
    localCount: 0,
    matchingLocalCount: 0,
  }

  const endpoints = getBridgeEndpointCredentialsGuardEndpoints(content)
  for (const endpoint of endpoints) {
    summary.localCount++
    if (endpoint === bridgeUrl) {
      summary.matchingLocalCount++
    }
  }

  return summary
}

function getBridgeEndpointCredentialsGuard(): string {
  return `/*${BRIDGE_ENDPOINT_PATCH_MARKER}*//*${BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER}*/`
}

function getBridgeEndpointCredentialsGuardBody(bridgeUrl: string): string {
  return `const e=this.reactiveStorageService.applicationUserPersistentStorage.cursorCreds,agentVibesNormalize=${getBridgeEndpointCredentialsGuard()}(base,url="${bridgeUrl}")=>{const r={...(base||{})},s=e=>/(?:backend|proxy|agent).*url|url.*(?:backend|proxy|agent)/i.test(e),t=e=>{const r={...(e||{})};for(const e in r)typeof r[e]=="string"&&(r[e]=url);return r.default=url,r};for(const e in r)if(s(e)){const s=r[e];r[e]=s&&typeof s=="object"?t(s):url}return r};return agentVibesNormalize(e)}`
}

function locateExistingBridgeEndpointCredentialsGuard(
  content: string
): MethodLocation | null {
  const markerIndex = content.indexOf(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)
  if (markerIndex < 0) {
    return null
  }

  return locateSemanticMethodAt(content, markerIndex, (body) =>
    body.includes(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)
  )
}

function hasCurrentBridgeEndpointCredentialsGuard(
  content: string,
  bridgeUrl: string
): boolean {
  const guard = getBridgeEndpointCredentialsGuardSegment(content)
  if (guard === null) {
    return false
  }

  return (
    guard.includes("agentVibesNormalize") &&
    guard.includes("backend|proxy|agent).*url") &&
    guard.includes('url="' + bridgeUrl + '"')
  )
}

function locateBridgeEndpointCredentialsMethod(
  content: string
): MethodLocation | null {
  const credentialAnchor = ".applicationUserPersistentStorage.cursorCreds"
  let anchorIndex = content.indexOf(credentialAnchor)
  while (anchorIndex >= 0) {
    const method = locateSemanticMethodAt(
      content,
      anchorIndex,
      (body) =>
        body.includes("reactiveStorageService") &&
        body.includes("applicationUserPersistentStorage.cursorCreds")
    )
    if (method !== null) {
      return method
    }
    anchorIndex = content.indexOf(credentialAnchor, anchorIndex + 1)
  }

  return null
}

function canPatchBridgeEndpointCredentialsGuard(content: string): boolean {
  if (
    content.includes(BRIDGE_ENDPOINT_PATCH_MARKER) !==
    content.includes(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)
  ) {
    return false
  }

  return (
    (content.includes(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER) &&
      locateExistingBridgeEndpointCredentialsGuard(content) !== null) ||
    locateBridgeEndpointCredentialsMethod(content) !== null
  )
}

function patchBridgeEndpointCredentialsGuard(
  content: string,
  bridgeUrl: string
): string | null {
  if (!canPatchBridgeEndpointCredentialsGuard(content)) {
    return null
  }

  if (content.includes(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)) {
    const existingGuard = locateExistingBridgeEndpointCredentialsGuard(content)
    if (existingGuard === null) {
      return null
    }

    return (
      content.slice(0, existingGuard.start) +
      content.slice(existingGuard.start, existingGuard.bodyStart + 1) +
      getBridgeEndpointCredentialsGuardBody(bridgeUrl) +
      content.slice(existingGuard.end)
    )
  }

  const method = locateBridgeEndpointCredentialsMethod(content)
  if (!method) {
    return null
  }

  return (
    content.slice(0, method.start) +
    content.slice(method.start, method.bodyStart + 1) +
    getBridgeEndpointCredentialsGuardBody(bridgeUrl) +
    content.slice(method.end)
  )
}

export function canPatchBridgeEndpointContent(content: string): boolean {
  return canPatchBridgeEndpointCredentialsGuard(content)
}

export function patchBridgeEndpointContent(
  content: string,
  port: number
): string | null {
  const bridgeUrl = getCursorBridgeEndpointUrl(port)
  const contentWithCredentialsGuard = patchBridgeEndpointCredentialsGuard(
    content,
    bridgeUrl
  )
  if (contentWithCredentialsGuard === null) {
    return null
  }

  const afterSummary = summarizeLocalBridgeEndpoints(
    contentWithCredentialsGuard,
    bridgeUrl
  )
  if (
    !afterSummary.hasMarker ||
    afterSummary.localCount !== 1 ||
    afterSummary.localCount !== afterSummary.matchingLocalCount ||
    contentWithCredentialsGuard === content
  ) {
    return null
  }

  return contentWithCredentialsGuard
}

export function getBridgeEndpointDetails(
  content: string,
  port: number
): {
  currentUrl: string | null
  applied: boolean
  canApply: boolean
  requiresPortUpdate: boolean
  coverage: Omit<CursorBridgeEndpointCoverage, "workbenchFiles">
} {
  const bridgeUrl = getCursorBridgeEndpointUrl(port)
  const summary = summarizeLocalBridgeEndpoints(content, bridgeUrl)
  const credentialsGuard = hasCurrentBridgeEndpointCredentialsGuard(
    content,
    bridgeUrl
  )
  const canApply = canPatchBridgeEndpointCredentialsGuard(content)
  const applied =
    summary.hasMarker &&
    credentialsGuard &&
    summary.localCount === 1 &&
    summary.localCount === summary.matchingLocalCount

  return {
    currentUrl: summary.matchingLocalCount > 0 ? bridgeUrl : null,
    applied,
    canApply,
    requiresPortUpdate: summary.hasMarker && canApply && !applied,
    coverage: {
      apiTargets: 0,
      agentTargets: 0,
      localEndpoints: summary.localCount,
      matchingLocalEndpoints: summary.matchingLocalCount,
      credentialsGuard,
      persistentGuard: true,
      storageGuardRemoved: true,
    },
  }
}

function toSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function runSqlite(
  dbPath: string,
  sql: string
): {
  success: boolean
  stdout: string
  error: string | null
} {
  const result = childProcess.spawnSync(
    "sqlite3",
    [dbPath, ".timeout 5000", sql],
    {
      encoding: "utf-8",
      timeout: 10_000,
    }
  )
  const error = result.error
    ? result.error.message
    : result.status === 0
      ? null
      : result.stderr || `sqlite3 exited with status ${result.status}`
  return {
    success: error === null,
    stdout: result.stdout ?? "",
    error,
  }
}

function parseSqliteKeyValueRows(stdout: string): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) {
      continue
    }
    const separator = line.indexOf("\t")
    if (separator < 0) {
      continue
    }
    rows.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return rows
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function firstEndpointUrl(
  currentUrl: string | null,
  value: unknown
): string | null {
  if (currentUrl !== null || typeof value !== "string") {
    return currentUrl
  }
  return /^https?:\/\//u.test(value) || isLocalBridgeEndpoint(value)
    ? value
    : currentUrl
}

function isCursorBridgeEndpointField(field: string): boolean {
  return /(?:backend|proxy|agent).*url|url.*(?:backend|proxy|agent)/iu.test(
    field
  )
}

function normalizeCursorAgentEndpointMap(
  value: unknown,
  bridgeUrl: string
): {
  value: Record<string, unknown>
  changed: boolean
  currentUrl: string | null
} {
  const source = isRecord(value) ? value : {}
  const next: Record<string, unknown> = { ...source }
  let changed = !isRecord(value)
  let currentUrl: string | null = null

  for (const [key, entryValue] of Object.entries(source)) {
    currentUrl = firstEndpointUrl(currentUrl, entryValue)
    if (typeof entryValue === "string" && entryValue !== bridgeUrl) {
      next[key] = bridgeUrl
      changed = true
    }
  }

  currentUrl = firstEndpointUrl(currentUrl, next.default)
  if (next.default !== bridgeUrl) {
    next.default = bridgeUrl
    changed = true
  }

  return { value: next, changed, currentUrl }
}

export function normalizeCursorApplicationUserEndpointValue(
  value: string,
  bridgeUrl: string
): CursorApplicationUserEndpointNormalization | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  if (!isRecord(parsed) || !isRecord(parsed.cursorCreds)) {
    return null
  }

  let changed = false
  let currentUrl: string | null = null
  const cursorCreds: Record<string, unknown> = { ...parsed.cursorCreds }

  for (const [field, fieldValue] of Object.entries(cursorCreds)) {
    if (!isCursorBridgeEndpointField(field)) {
      continue
    }

    if (typeof fieldValue === "string") {
      currentUrl = firstEndpointUrl(currentUrl, fieldValue)
      if (fieldValue !== bridgeUrl) {
        cursorCreds[field] = bridgeUrl
        changed = true
      }
      continue
    }

    const normalizedMap = normalizeCursorAgentEndpointMap(fieldValue, bridgeUrl)
    currentUrl = currentUrl ?? normalizedMap.currentUrl
    if (normalizedMap.changed) {
      cursorCreds[field] = normalizedMap.value
      changed = true
    }
  }

  const nextUser: Record<string, unknown> = { ...parsed }
  if (changed) {
    nextUser.cursorCreds = cursorCreds
  }

  if (
    isRecord(parsed.cppConfig) &&
    typeof parsed.cppConfig.cppUrl === "string"
  ) {
    currentUrl = firstEndpointUrl(currentUrl, parsed.cppConfig.cppUrl)
    if (parsed.cppConfig.cppUrl !== bridgeUrl) {
      nextUser.cppConfig = { ...parsed.cppConfig, cppUrl: bridgeUrl }
      changed = true
    }
  }

  return {
    value: changed ? JSON.stringify(nextUser) : value,
    changed,
    currentUrl,
  }
}

export function normalizeCursorApplicationUserEntitlementValue(
  value: string
): CursorApplicationUserEntitlementNormalization | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }

  if (!isRecord(parsed)) {
    return null
  }

  const currentMembershipType =
    typeof parsed.membershipType === "string" ? parsed.membershipType : null
  const currentSubscriptionStatus =
    typeof parsed.subscriptionStatus === "string"
      ? parsed.subscriptionStatus
      : null
  const nextUser: Record<string, unknown> = { ...parsed }
  let changed = false

  if (parsed.membershipType !== CURSOR_ENTITLEMENT_MEMBERSHIP_TYPE) {
    nextUser.membershipType = CURSOR_ENTITLEMENT_MEMBERSHIP_TYPE
    changed = true
  }
  if (parsed.subscriptionStatus !== CURSOR_ENTITLEMENT_SUBSCRIPTION_STATUS) {
    nextUser.subscriptionStatus = CURSOR_ENTITLEMENT_SUBSCRIPTION_STATUS
    changed = true
  }

  return {
    value: changed ? JSON.stringify(nextUser) : value,
    changed,
    currentMembershipType,
    currentSubscriptionStatus,
  }
}

function _getCursorPersistentEndpointPatchDetails(
  port: number
): CursorPersistentEndpointPatchDetails {
  const filePath = getCursorGlobalStorageStateDbPath()
  const result: CursorPersistentEndpointPatchDetails = {
    filePath,
    fileExists: false,
    applied: true,
    canApply: false,
    changed: false,
    currentUrl: null,
    sql: null,
    error: null,
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return result
  }

  result.fileExists = true
  const selectResult = runSqlite(
    filePath,
    `SELECT key || char(9) || value FROM ItemTable WHERE key=${toSqlString(
      CURSOR_APPLICATION_USER_STORAGE_KEY
    )};`
  )
  if (!selectResult.success) {
    result.applied = false
    result.error = selectResult.error
    return result
  }

  const value = parseSqliteKeyValueRows(selectResult.stdout).get(
    CURSOR_APPLICATION_USER_STORAGE_KEY
  )
  if (value === undefined) {
    return result
  }

  const normalized = normalizeCursorApplicationUserEndpointValue(
    value,
    getCursorBridgeEndpointUrl(port)
  )
  if (normalized === null) {
    result.applied = false
    result.error = "Cursor applicationUser endpoint storage is not writable"
    return result
  }

  result.currentUrl = normalized.currentUrl
  result.applied = !normalized.changed
  result.changed = normalized.changed
  result.canApply = true
  if (normalized.changed) {
    result.sql = `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${toSqlString(
      CURSOR_APPLICATION_USER_STORAGE_KEY
    )},${toSqlString(normalized.value)});`
  }

  return result
}

function getCursorEntitlementPatchDetails(): CursorEntitlementPatchDetails {
  const filePath = getCursorGlobalStorageStateDbPath()
  const result: CursorEntitlementPatchDetails = {
    filePath,
    fileExists: false,
    applied: true,
    canApply: false,
    changed: false,
    currentMembershipType: null,
    currentSubscriptionStatus: null,
    sql: null,
    error: null,
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return result
  }

  result.fileExists = true
  const selectedKeys = [
    CURSOR_AUTH_MEMBERSHIP_TYPE_KEY,
    CURSOR_AUTH_SUBSCRIPTION_STATUS_KEY,
    CURSOR_APPLICATION_USER_STORAGE_KEY,
  ]
    .map(toSqlString)
    .join(",")
  const selectResult = runSqlite(
    filePath,
    `SELECT key || char(9) || value FROM ItemTable WHERE key IN (${selectedKeys});`
  )
  if (!selectResult.success) {
    result.applied = false
    result.error = selectResult.error
    return result
  }

  const rows = parseSqliteKeyValueRows(selectResult.stdout)
  const membershipType = rows.get(CURSOR_AUTH_MEMBERSHIP_TYPE_KEY) ?? null
  const subscriptionStatus =
    rows.get(CURSOR_AUTH_SUBSCRIPTION_STATUS_KEY) ?? null
  const applicationUser = rows.get(CURSOR_APPLICATION_USER_STORAGE_KEY)
  result.currentMembershipType = membershipType
  result.currentSubscriptionStatus = subscriptionStatus

  const statements: string[] = []
  if (membershipType !== CURSOR_ENTITLEMENT_MEMBERSHIP_TYPE) {
    statements.push(
      `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${toSqlString(
        CURSOR_AUTH_MEMBERSHIP_TYPE_KEY
      )},${toSqlString(CURSOR_ENTITLEMENT_MEMBERSHIP_TYPE)});`
    )
  }
  if (subscriptionStatus !== CURSOR_ENTITLEMENT_SUBSCRIPTION_STATUS) {
    statements.push(
      `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${toSqlString(
        CURSOR_AUTH_SUBSCRIPTION_STATUS_KEY
      )},${toSqlString(CURSOR_ENTITLEMENT_SUBSCRIPTION_STATUS)});`
    )
  }

  if (applicationUser !== undefined) {
    const normalized =
      normalizeCursorApplicationUserEntitlementValue(applicationUser)
    if (normalized === null) {
      result.applied = false
      result.error =
        "Cursor applicationUser entitlement storage is not writable"
      return result
    }

    result.currentMembershipType =
      normalized.currentMembershipType ?? result.currentMembershipType
    result.currentSubscriptionStatus =
      normalized.currentSubscriptionStatus ?? result.currentSubscriptionStatus
    if (normalized.changed) {
      statements.push(
        `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${toSqlString(
          CURSOR_APPLICATION_USER_STORAGE_KEY
        )},${toSqlString(normalized.value)});`
      )
    }
  }

  result.canApply = true
  result.changed = statements.length > 0
  result.applied = !result.changed
  if (statements.length > 0) {
    result.sql = `BEGIN IMMEDIATE;${statements.join("")}COMMIT;`
  }

  return result
}

function _getCursorStartupPreferencePatchDetails(): CursorStartupPreferencePatchDetails {
  const filePath = getCursorGlobalStorageStateDbPath()
  const result: CursorStartupPreferencePatchDetails = {
    filePath,
    fileExists: false,
    applied: true,
    canApply: false,
    changed: false,
    sql: null,
    error: null,
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return result
  }

  result.fileExists = true
  const keys = [
    CURSOR_OPEN_AGENTS_WINDOW_ON_STARTUP_KEY,
    CURSOR_FIRST_WINDOW_OPEN_GLASS_TREATMENT_KEY,
    CURSOR_GLASS_STARTUP_HANDOFF_KEY,
  ]
  const selectResult = runSqlite(
    filePath,
    `SELECT key || char(9) || value FROM ItemTable WHERE key IN (${keys
      .map(toSqlString)
      .join(",")});`
  )
  if (!selectResult.success) {
    result.applied = false
    result.error = selectResult.error
    return result
  }

  const rows = parseSqliteKeyValueRows(selectResult.stdout)
  const hasAgentsStartupOptOut =
    rows.get(CURSOR_OPEN_AGENTS_WINDOW_ON_STARTUP_KEY) === "false"
  const hasFirstWindowGlassOptOut =
    rows.get(CURSOR_FIRST_WINDOW_OPEN_GLASS_TREATMENT_KEY) === "false"
  const hasStartupHandoff = rows.has(CURSOR_GLASS_STARTUP_HANDOFF_KEY)
  const changed =
    !hasAgentsStartupOptOut || !hasFirstWindowGlassOptOut || hasStartupHandoff

  result.applied = !changed
  result.canApply = true
  result.changed = changed
  if (changed) {
    result.sql = [
      `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${toSqlString(
        CURSOR_OPEN_AGENTS_WINDOW_ON_STARTUP_KEY
      )},${toSqlString("false")});`,
      `INSERT OR REPLACE INTO ItemTable(key,value) VALUES(${toSqlString(
        CURSOR_FIRST_WINDOW_OPEN_GLASS_TREATMENT_KEY
      )},${toSqlString("false")});`,
      `DELETE FROM ItemTable WHERE key=${toSqlString(
        CURSOR_GLASS_STARTUP_HANDOFF_KEY
      )};`,
    ].join("")
  }

  return result
}

function getCursorBridgeCaCertPath(): string | null {
  return path.join(getDefaultDataDir(), "certs", "ca.pem")
}

function readLaunchdNodeExtraCaCerts(): {
  success: boolean
  value: string | null
  error: string | null
} {
  const result = childProcess.spawnSync(
    "launchctl",
    ["getenv", CURSOR_NODE_EXTRA_CA_CERTS_ENV_KEY],
    {
      encoding: "utf-8",
      timeout: 10_000,
    }
  )
  if (result.error) {
    return {
      success: false,
      value: null,
      error: result.error.message,
    }
  }
  if (result.status !== 0) {
    return {
      success: false,
      value: null,
      error: result.stderr || `launchctl exited with status ${result.status}`,
    }
  }

  return {
    success: true,
    value: result.stdout.trim() || null,
    error: null,
  }
}

function writeLaunchdNodeExtraCaCerts(caCertPath: string): {
  success: boolean
  error: string | null
} {
  const result = childProcess.spawnSync(
    "launchctl",
    ["setenv", CURSOR_NODE_EXTRA_CA_CERTS_ENV_KEY, caCertPath],
    {
      encoding: "utf-8",
      timeout: 10_000,
    }
  )
  if (result.error) {
    return { success: false, error: result.error.message }
  }
  if (result.status !== 0) {
    return {
      success: false,
      error: result.stderr || `launchctl exited with status ${result.status}`,
    }
  }

  return { success: true, error: null }
}

function getCursorNodeCaPatchDetails(): CursorNodeCaPatchDetails {
  const caCertPath = getCursorBridgeCaCertPath()
  const result: CursorNodeCaPatchDetails = {
    caCertPath,
    fileExists: Boolean(caCertPath && fs.existsSync(caCertPath)),
    applied: true,
    canApply: false,
    changed: false,
    currentValue: null,
    error: null,
  }

  if (!caCertPath || !result.fileExists) {
    result.applied = false
    result.error = "Agent Vibes CA certificate not found"
    return result
  }

  if (process.platform === "darwin") {
    const launchdValue = readLaunchdNodeExtraCaCerts()
    if (!launchdValue.success) {
      result.applied = false
      result.canApply = true
      result.changed = true
      result.error = launchdValue.error
      return result
    }

    result.currentValue = launchdValue.value
    result.applied = launchdValue.value === caCertPath
    result.canApply = true
    result.changed = !result.applied
    return result
  }

  const currentValue = process.env[CURSOR_NODE_EXTRA_CA_CERTS_ENV_KEY] ?? null
  result.currentValue = currentValue
  result.applied = currentValue === caCertPath
  result.canApply = true
  result.changed = !result.applied
  return result
}

function applyCursorNodeCaPatch(details: CursorNodeCaPatchDetails): {
  success: boolean
  error: string | null
} {
  if (!details.caCertPath || !details.fileExists) {
    return {
      success: false,
      error: details.error ?? "Agent Vibes CA certificate not found",
    }
  }

  process.env[CURSOR_NODE_EXTRA_CA_CERTS_ENV_KEY] = details.caCertPath
  if (process.platform !== "darwin") {
    return { success: true, error: null }
  }

  return writeLaunchdNodeExtraCaCerts(details.caCertPath)
}

function isIdleExtensionHostKillerMethodBody(body: string): boolean {
  const requiredSignals = [
    "idle_extension_host_killer_config",
    "extensionHostsKilledForIdle",
    "stopExtensionHostsForIdleInFlight",
  ]
  if (!requiredSignals.every((signal) => body.includes(signal))) {
    return false
  }
  if (!/this\.stopExtensionHostsForIdle\(/.test(body)) {
    return false
  }

  const secondarySignals = [
    "idleMinutesToKillExtensionHost",
    "freeMemoryPercentageToKillExtensionHost",
    "getFreeMemoryPercentage",
    "describeActiveAgentWork",
    "consecutiveIdleMinutes",
    "restartExtensionHostsKilledForIdle",
  ]
  return secondarySignals.filter((signal) => body.includes(signal)).length >= 3
}

function findMatchingBrace(
  content: string,
  openBraceIndex: number
): number | null {
  let depth = 0
  let mode: "code" | "single" | "double" | "template" | "line" | "block" =
    "code"
  let escaped = false

  for (let i = openBraceIndex; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (mode === "line") {
      if (ch === "\n" || ch === "\r") mode = "code"
      continue
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = "code"
        i++
      }
      continue
    }
    if (mode === "single" || mode === "double" || mode === "template") {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (
        (mode === "single" && ch === "'") ||
        (mode === "double" && ch === '"') ||
        (mode === "template" && ch === "`")
      ) {
        mode = "code"
      }
      continue
    }

    if (ch === "/" && next === "/") {
      mode = "line"
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      mode = "block"
      i++
      continue
    }
    if (ch === "'") {
      mode = "single"
      continue
    }
    if (ch === '"') {
      mode = "double"
      continue
    }
    if (ch === "`") {
      mode = "template"
      continue
    }
    if (ch === "{") {
      depth++
      continue
    }
    if (ch === "}") {
      depth--
      if (depth === 0) return i
    }
  }

  return null
}

function locateSemanticMethodAt(
  content: string,
  anchorIndex: number,
  predicate: (body: string) => boolean
): MethodLocation | null {
  const localStart = Math.max(
    0,
    anchorIndex - SEMANTIC_METHOD_LOCAL_SEARCH_BYTES
  )
  const searchStarts = localStart === 0 ? [0] : [localStart, 0]

  for (const searchStart of searchStarts) {
    const methodPattern = /(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^{};]*\)\s*\{/gu
    methodPattern.lastIndex = searchStart
    const candidates: Array<{ start: number; bodyStart: number }> = []
    let match: RegExpExecArray | null

    while ((match = methodPattern.exec(content)) !== null) {
      if (match.index > anchorIndex) {
        break
      }
      candidates.push({
        start: match.index,
        bodyStart: match.index + match[0].lastIndexOf("{"),
      })
    }

    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index]
      if (!candidate) {
        continue
      }
      const end = findMatchingBrace(content, candidate.bodyStart)
      if (end === null || end < anchorIndex) {
        continue
      }
      const body = content.slice(candidate.bodyStart + 1, end)
      if (predicate(body)) {
        return {
          start: candidate.start,
          bodyStart: candidate.bodyStart,
          end: end + 1,
        }
      }
    }
  }

  return null
}

export interface PatchStatus {
  filePath: string | null
  fileExists: boolean
  backupExists: boolean
  patches: Array<{ name: string; applied: boolean }>
  allApplied: boolean
  isPatched: boolean
}

export interface CursorSinglePatchStatus {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  canApply: boolean
  managedBaseline: boolean
  legacyBackupExists: boolean
  legacyBackupClean: boolean
}

export interface CursorBridgeEndpointPatchStatus {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  canApply: boolean
  managedBaseline: boolean
  endpointUrl: string
  currentUrl: string | null
  requiresPortUpdate: boolean
  coverage: CursorBridgeEndpointCoverage
}

export interface CursorTrafficCapturePatchStatus {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  partial: boolean
  canApply: boolean
  managedBaseline: boolean
  totalRules: number
  appliedRules: number
  availableRules: number
  missingRules: string[]
}

export interface CursorAgentInputDockPatchStatus {
  filePath: string | null
  fileExists: boolean
  applied: boolean
  partial: boolean
  canApply: boolean
  managedBaseline: boolean
  workbenchFiles: number
  legacyFiles: number
}

export interface CursorBridgeEndpointCoverage {
  workbenchFiles: number
  apiTargets: number
  agentTargets: number
  localEndpoints: number
  matchingLocalEndpoints: number
  credentialsGuard: boolean
  persistentGuard: boolean
  storageGuardRemoved: boolean
}

export interface CursorPatchApplyResult {
  success: boolean
  applied: number
  checksumApplied: boolean
  checksumUpdated: number
  errors: string[]
  restartRequired?: boolean
}

const CURSOR_PATCH_STATUS_CACHE_TTL_MS = 30_000

type CursorPatchStatusCache<T> = {
  key: string
  expiresAt: number
  status: T
}

type CursorPatchStatusOptions = {
  force?: boolean
}

/**
 * CursorPatchService — Manages independent Cursor workbench patches and their
 * shared original-file baseline.
 */
export class CursorPatchService {
  private static bridgeEndpointStatusCache: CursorPatchStatusCache<CursorBridgeEndpointPatchStatus> | null =
    null
  private static idleKillerStatusCache: CursorPatchStatusCache<CursorSinglePatchStatus> | null =
    null
  private static agentInputDockStatusCache: CursorPatchStatusCache<CursorAgentInputDockPatchStatus> | null =
    null
  private static workspaceControlStatusCache: CursorPatchStatusCache<CursorAgentInputDockPatchStatus> | null =
    null
  private static trafficCaptureStatusCache: CursorPatchStatusCache<CursorTrafficCapturePatchStatus> | null =
    null
  private static legacyStatusCache: CursorPatchStatusCache<PatchStatus> | null =
    null
  private static workspaceControlRuntimeConfig:
    | WorkspaceControlRuntimeConfig
    | undefined

  private readonly logger: Logger
  private readonly baseline = new CursorPatchBaselineService()
  private readonly checksums = new CursorChecksumsService()

  constructor(logger: Logger) {
    this.logger = logger
  }

  static configureWorkspaceControlRuntime(
    runtimeConfig: WorkspaceControlRuntimeConfig
  ): void {
    CursorPatchService.workspaceControlRuntimeConfig = runtimeConfig
    CursorPatchService.workspaceControlStatusCache = null
  }

  static invalidateStatusCache(): void {
    CursorPatchService.bridgeEndpointStatusCache = null
    CursorPatchService.idleKillerStatusCache = null
    CursorPatchService.agentInputDockStatusCache = null
    CursorPatchService.workspaceControlStatusCache = null
    CursorPatchService.trafficCaptureStatusCache = null
    CursorPatchService.legacyStatusCache = null
    CursorChecksumsService.invalidateStatusCache()
    CursorPatchBaselineService.invalidateStatusCache()
  }

  invalidateStatusCache(): void {
    CursorPatchService.invalidateStatusCache()
  }

  private static getCachedStatus<T>(
    cache: CursorPatchStatusCache<T> | null,
    key: string,
    force: boolean | undefined
  ): T | null {
    if (force || !cache || cache.key !== key || cache.expiresAt <= Date.now()) {
      return null
    }
    return cache.status
  }

  private static setCachedStatus<T>(
    key: string,
    status: T,
    expiresAt = Date.now() + CURSOR_PATCH_STATUS_CACHE_TTL_MS
  ): CursorPatchStatusCache<T> {
    return {
      key,
      expiresAt,
      status,
    }
  }

  private static getBridgeEndpointCacheKey(
    port: number,
    filePaths: string[]
  ): string {
    const caCertPath = getCursorBridgeCaCertPath()
    const trackedPaths = caCertPath ? [...filePaths, caCertPath] : filePaths
    const signatures = trackedPaths.map((filePath) => {
      try {
        const stat = fs.statSync(filePath)
        return `${filePath}:${stat.size}:${stat.mtimeMs}`
      } catch {
        return `${filePath}:missing`
      }
    })
    return `bridge:${normalizeBridgePort(port)}:${signatures.join("|")}`
  }

  getBridgeEndpointPatchStatus(
    port: number,
    options: CursorPatchStatusOptions = {}
  ): CursorBridgeEndpointPatchStatus {
    const filePaths = getCursorWorkbenchPaths()
    const cacheKey = CursorPatchService.getBridgeEndpointCacheKey(
      port,
      filePaths
    )
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.bridgeEndpointStatusCache,
      cacheKey,
      options.force
    )
    if (cached) {
      return cached
    }

    const filePath = filePaths[0] ?? getCursorWorkbenchPath()
    const endpointUrl = getCursorBridgeEndpointUrl(port)
    const result: CursorBridgeEndpointPatchStatus = {
      filePath,
      fileExists: false,
      applied: false,
      canApply: false,
      managedBaseline: false,
      endpointUrl,
      currentUrl: null,
      requiresPortUpdate: false,
      coverage: {
        workbenchFiles: 0,
        apiTargets: 0,
        agentTargets: 0,
        localEndpoints: 0,
        matchingLocalEndpoints: 0,
        credentialsGuard: false,
        persistentGuard: false,
        storageGuardRemoved: false,
      },
    }

    if (filePaths.length === 0) {
      CursorPatchService.bridgeEndpointStatusCache =
        CursorPatchService.setCachedStatus(
          cacheKey,
          result,
          Number.POSITIVE_INFINITY
        )
      return result
    }

    result.fileExists = true
    result.managedBaseline = filePaths.every((path) =>
      this.baseline.hasOriginal(path)
    )
    const workbenchContents = filePaths.map((path) =>
      fs.readFileSync(path, "utf-8")
    )
    const workbenchDetails = workbenchContents.map((content) =>
      getBridgeEndpointDetails(content, port)
    )
    const planEditorTabTargets = workbenchContents.filter(
      (content) => locatePlanEditorOpenMethod(content) !== null
    )
    const planEditorTabPatchApplied =
      planEditorTabTargets.length > 0
        ? planEditorTabTargets.every(isPlanEditorTabPatchApplied)
        : workbenchContents.every(
            (content) => !content.includes("openPlanInEditor(")
          )
    const workspaceChangeAgentGateTargets = workbenchContents.filter(
      canPatchWorkspaceChangeAgentGateContent
    )
    const workspaceChangeAgentGatePatchApplied =
      workspaceChangeAgentGateTargets.length > 0 &&
      workspaceChangeAgentGateTargets.every(
        isWorkspaceChangeAgentGatePatchApplied
      )
    const readTodosTranslationPatchApplied = workbenchContents.every(
      isReadTodosTranslationPatchApplied
    )
    const nodeCaDetails = getCursorNodeCaPatchDetails()
    result.coverage = {
      workbenchFiles: workbenchDetails.length,
      apiTargets: workbenchDetails.reduce(
        (sum, details) => sum + details.coverage.apiTargets,
        0
      ),
      agentTargets: workbenchDetails.reduce(
        (sum, details) => sum + details.coverage.agentTargets,
        0
      ),
      localEndpoints: workbenchDetails.reduce(
        (sum, details) => sum + details.coverage.localEndpoints,
        0
      ),
      matchingLocalEndpoints: workbenchDetails.reduce(
        (sum, details) => sum + details.coverage.matchingLocalEndpoints,
        0
      ),
      credentialsGuard:
        workbenchDetails.length > 0 &&
        workbenchDetails.every((details) => details.coverage.credentialsGuard),
      persistentGuard: true,
      storageGuardRemoved:
        workbenchDetails.length > 0 &&
        workbenchDetails.every(
          (details) => details.coverage.storageGuardRemoved
        ),
    }

    result.applied =
      workbenchDetails.every((details) => details.applied) &&
      planEditorTabPatchApplied &&
      workspaceChangeAgentGatePatchApplied &&
      readTodosTranslationPatchApplied &&
      nodeCaDetails.applied
    result.canApply =
      workbenchDetails.some((details) => details.canApply) ||
      planEditorTabTargets.some(
        (content) => !isPlanEditorTabPatchApplied(content)
      ) ||
      workspaceChangeAgentGateTargets.some(
        (content) => !isWorkspaceChangeAgentGatePatchApplied(content)
      ) ||
      workbenchContents.some(
        (content) => !isReadTodosTranslationPatchApplied(content)
      ) ||
      nodeCaDetails.canApply
    result.currentUrl =
      workbenchDetails.find((details) => !details.applied)?.currentUrl ??
      workbenchDetails[0]?.currentUrl ??
      null
    result.requiresPortUpdate = workbenchDetails.some(
      (details) => details.requiresPortUpdate
    )

    CursorPatchService.bridgeEndpointStatusCache =
      CursorPatchService.setCachedStatus(
        cacheKey,
        result,
        Number.POSITIVE_INFINITY
      )
    return result
  }

  applyBridgeEndpointPatch(port: number): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePaths = getCursorWorkbenchPaths()
    if (filePaths.length === 0) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const workbenchStatuses = filePaths.map((path) => {
      const content = fs.readFileSync(path, "utf-8")
      return {
        path,
        content,
        status: getBridgeEndpointDetails(content, port),
        hasPlanEditorTabTarget: locatePlanEditorOpenMethod(content) !== null,
        planEditorTabPatchApplied: isPlanEditorTabPatchApplied(content),
        workspaceChangeAgentGatePatchSupported:
          canPatchWorkspaceChangeAgentGateContent(content),
        workspaceChangeAgentGatePatchApplied:
          isWorkspaceChangeAgentGatePatchApplied(content),
        readTodosTranslationPatchApplied:
          isReadTodosTranslationPatchApplied(content),
      }
    })
    const planEditorTabStatuses = workbenchStatuses.filter(
      ({ hasPlanEditorTabTarget }) => hasPlanEditorTabTarget
    )
    if (
      planEditorTabStatuses.length === 0 &&
      workbenchStatuses.some(({ content }) =>
        content.includes("openPlanInEditor(")
      )
    ) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [`Pattern not found: ${PLAN_EDITOR_TAB_PATCH.name}`],
      }
    }
    const workspaceChangeAgentGateStatuses = workbenchStatuses.filter(
      ({ workspaceChangeAgentGatePatchSupported }) =>
        workspaceChangeAgentGatePatchSupported
    )
    if (workspaceChangeAgentGateStatuses.length === 0) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          `Pattern not found: ${WORKSPACE_CHANGE_AGENT_GATE_PATCH.name}`,
        ],
      }
    }
    const nodeCaStatus = getCursorNodeCaPatchDetails()
    if (
      workbenchStatuses.every(({ status }) => status.applied) &&
      planEditorTabStatuses.every(
        ({ planEditorTabPatchApplied }) => planEditorTabPatchApplied
      ) &&
      workspaceChangeAgentGateStatuses.every(
        ({ workspaceChangeAgentGatePatchApplied }) =>
          workspaceChangeAgentGatePatchApplied
      ) &&
      workbenchStatuses.every(
        ({ readTodosTranslationPatchApplied }) =>
          readTodosTranslationPatchApplied
      ) &&
      nodeCaStatus.applied
    ) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    let applied = 0
    let restartRequired = false

    for (const workbenchStatus of workbenchStatuses) {
      let nextContent = workbenchStatus.content

      if (!workbenchStatus.status.applied) {
        const bridgePatchedContent = patchBridgeEndpointContent(
          nextContent,
          port
        )
        if (bridgePatchedContent === null) {
          return {
            success: false,
            applied,
            checksumApplied: false,
            checksumUpdated: 0,
            errors: [
              `Pattern not found: Cursor Bridge Endpoint (${workbenchStatus.path})`,
            ],
            restartRequired,
          }
        }

        nextContent = bridgePatchedContent
      }

      if (
        workbenchStatus.hasPlanEditorTabTarget &&
        !workbenchStatus.planEditorTabPatchApplied
      ) {
        const planEditorPatchedContent = patchPlanEditorTabContent(nextContent)
        if (planEditorPatchedContent === null) {
          return {
            success: false,
            applied,
            checksumApplied: false,
            checksumUpdated: 0,
            errors: [
              `Pattern not found: ${PLAN_EDITOR_TAB_PATCH.name} (${workbenchStatus.path})`,
            ],
            restartRequired,
          }
        }
        nextContent = planEditorPatchedContent
      }

      if (
        workbenchStatus.workspaceChangeAgentGatePatchSupported &&
        !workbenchStatus.workspaceChangeAgentGatePatchApplied
      ) {
        const workspaceChangeAgentGatePatchedContent =
          patchWorkspaceChangeAgentGateContent(nextContent)
        if (workspaceChangeAgentGatePatchedContent === null) {
          return {
            success: false,
            applied,
            checksumApplied: false,
            checksumUpdated: 0,
            errors: [
              `Pattern not found: ${WORKSPACE_CHANGE_AGENT_GATE_PATCH.name} (${workbenchStatus.path})`,
            ],
            restartRequired,
          }
        }
        nextContent = workspaceChangeAgentGatePatchedContent
      }

      if (!workbenchStatus.readTodosTranslationPatchApplied) {
        const readTodosPatchedContent =
          patchReadTodosTranslationContent(nextContent)
        if (readTodosPatchedContent === null) {
          return {
            success: false,
            applied,
            checksumApplied: false,
            checksumUpdated: 0,
            errors: [
              `Pattern not found: ${READ_TODOS_TRANSLATION_PATCH.name} (${workbenchStatus.path})`,
            ],
            restartRequired,
          }
        }
        nextContent = readTodosPatchedContent
      }

      if (nextContent === workbenchStatus.content) {
        continue
      }

      this.baseline.ensureOriginals([workbenchStatus.path])
      fs.writeFileSync(workbenchStatus.path, nextContent, "utf-8")
      applied += 1
      restartRequired = true
    }

    if (nodeCaStatus.canApply && !nodeCaStatus.applied) {
      const updateResult = applyCursorNodeCaPatch(nodeCaStatus)
      if (!updateResult.success) {
        return {
          success: false,
          applied,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Failed to configure Cursor CA trust: ${updateResult.error}`,
          ],
          restartRequired,
        }
      }
      applied += 1
    } else if (nodeCaStatus.error && !nodeCaStatus.applied) {
      return {
        success: false,
        applied,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [`Failed to read Cursor CA trust: ${nodeCaStatus.error}`],
        restartRequired,
      }
    }

    this.logger.info(
      `Applied patch: Cursor Bridge Endpoint (${getCursorBridgeEndpointUrl(port)})`
    )
    return this.finalizePatchApply({ applied, restartRequired })
  }

  getAgentInputDockPatchStatus(
    options: CursorPatchStatusOptions = {}
  ): CursorAgentInputDockPatchStatus {
    const filePaths = getCursorWorkbenchPaths()
    const cacheKey =
      filePaths.length === 0
        ? "agent-input-dock:missing"
        : `agent-input-dock:${filePaths
            .map((filePath) => {
              const stat = fs.statSync(filePath)
              return `${filePath}:${stat.size}:${stat.mtimeMs}`
            })
            .join("|")}`
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.agentInputDockStatusCache,
      cacheKey,
      options.force
    )
    if (cached) return cached

    const result: CursorAgentInputDockPatchStatus = {
      filePath: filePaths[0] ?? getCursorWorkbenchPath(),
      fileExists: filePaths.length > 0,
      applied: false,
      partial: false,
      canApply: false,
      managedBaseline: false,
      workbenchFiles: filePaths.length,
      legacyFiles: 0,
    }
    if (filePaths.length === 0) {
      CursorPatchService.agentInputDockStatusCache =
        CursorPatchService.setCachedStatus(cacheKey, result)
      return result
    }

    const contents = filePaths.map((filePath) =>
      fs.readFileSync(filePath, "utf-8")
    )
    const details = contents.map((content) =>
      getCursorAgentInputDockDetails(content)
    )
    result.applied = details.every((detail) => detail.applied)
    result.partial =
      !result.applied &&
      details.some((detail) => detail.applied || detail.partial)
    result.canApply = details.every((detail) => detail.canApply)
    result.managedBaseline = filePaths.every((filePath) =>
      this.baseline.hasOriginal(filePath)
    )
    result.legacyFiles = details.filter(
      (detail) => detail.legacyMarkers.length > 0
    ).length

    CursorPatchService.agentInputDockStatusCache =
      CursorPatchService.setCachedStatus(cacheKey, result)
    return result
  }

  applyAgentInputDockPatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePaths = getCursorWorkbenchPaths()
    if (filePaths.length === 0) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const plans = filePaths.map((filePath) => {
      const content = fs.readFileSync(filePath, "utf-8")
      return {
        filePath,
        content,
        details: getCursorAgentInputDockDetails(content),
      }
    })
    if (plans.every((plan) => plan.details.applied)) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    const nextPlans: Array<{
      filePath: string
      content: string
      nextContent: string
    }> = []
    for (const plan of plans) {
      const nextContent = patchCursorAgentInputDockContent(plan.content)
      if (nextContent === null) {
        return {
          success: false,
          applied: 0,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Agent input dock cannot safely migrate the existing runtime: ${plan.filePath}`,
          ],
        }
      }
      nextPlans.push({ ...plan, nextContent })
    }

    const changedPlans = nextPlans.filter(
      (plan) => plan.nextContent !== plan.content
    )
    if (changedPlans.length === 0) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    const unmanagedPlans = changedPlans.filter(
      (plan) => !this.baseline.hasOriginal(plan.filePath)
    )
    const baselineCandidates = unmanagedPlans.map((plan) => ({
      filePath: plan.filePath,
      cleanContent: removeCursorAgentInputDockPatchContent(plan.content),
    }))
    if (
      baselineCandidates.length > 0 &&
      baselineCandidates.every(
        (candidate) =>
          candidate.cleanContent !== null &&
          !PATCH_MARKERS.some((marker) =>
            candidate.cleanContent!.includes(marker)
          )
      )
    ) {
      for (const candidate of baselineCandidates) {
        this.baseline.captureOriginalContent(
          candidate.filePath,
          candidate.cleanContent!
        )
      }
    }
    for (const plan of changedPlans) {
      fs.writeFileSync(plan.filePath, plan.nextContent, "utf-8")
    }
    this.logger.info(
      `Applied patch: Agent Input Dock (${changedPlans.length} workbench file(s))`
    )
    return this.finalizePatchApply({
      applied: changedPlans.length,
      restartRequired: true,
    })
  }

  disableAgentInputDockPatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePaths = getCursorWorkbenchPaths()
    if (filePaths.length === 0) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const activeFiles = filePaths
      .map((filePath) => ({
        filePath,
        currentContent: fs.readFileSync(filePath, "utf-8"),
      }))
      .filter(({ currentContent }) =>
        hasCursorAgentInputDockPatch(currentContent)
      )
    if (activeFiles.length === 0) {
      return this.finalizePatchApply({ applied: 0 })
    }

    const nextFiles: Array<{ filePath: string; nextContent: string }> = []
    for (const activeFile of activeFiles) {
      const nextContent = removeCursorAgentInputDockPatchContent(
        activeFile.currentContent
      )
      if (nextContent === null) {
        return {
          success: false,
          applied: 0,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Agent input dock could not be disabled because its owned runtime boundary is incomplete: ${activeFile.filePath}`,
          ],
        }
      }
      nextFiles.push({ filePath: activeFile.filePath, nextContent })
    }

    for (const nextFile of nextFiles) {
      fs.writeFileSync(nextFile.filePath, nextFile.nextContent, "utf-8")
    }
    this.logger.info(
      `Disabled patch: Agent Input Dock (${nextFiles.length} workbench file(s))`
    )
    return this.finalizePatchApply({
      applied: nextFiles.length,
      restartRequired: true,
    })
  }

  getWorkspaceControlPatchStatus(
    options: CursorPatchStatusOptions = {}
  ): CursorAgentInputDockPatchStatus {
    const filePaths = getCursorWorkbenchPaths()
    const runtimeConfigKey = JSON.stringify(
      CursorPatchService.workspaceControlRuntimeConfig ?? null
    )
    const cacheKey =
      filePaths.length === 0
        ? `workspace-control:missing:${runtimeConfigKey}`
        : `workspace-control:${runtimeConfigKey}:${filePaths
            .map((filePath) => {
              const stat = fs.statSync(filePath)
              return `${filePath}:${stat.size}:${stat.mtimeMs}`
            })
            .join("|")}`
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.workspaceControlStatusCache,
      cacheKey,
      options.force
    )
    if (cached) return cached

    const result: CursorAgentInputDockPatchStatus = {
      filePath: filePaths[0] ?? getCursorWorkbenchPath(),
      fileExists: filePaths.length > 0,
      applied: false,
      partial: false,
      canApply: false,
      managedBaseline: false,
      workbenchFiles: filePaths.length,
      legacyFiles: 0,
    }
    if (filePaths.length === 0) {
      CursorPatchService.workspaceControlStatusCache =
        CursorPatchService.setCachedStatus(cacheKey, result)
      return result
    }

    const contents = filePaths.map((filePath) =>
      fs.readFileSync(filePath, "utf-8")
    )
    const details = contents.map((content) =>
      getCursorWorkspaceControlDetails(content)
    )
    const expectedRuntimeConfig =
      CursorPatchService.workspaceControlRuntimeConfig
    const runtimeConfigMatches =
      expectedRuntimeConfig === undefined ||
      contents.every(
        (content) =>
          JSON.stringify(readWorkspaceControlRuntimeConfig(content)) ===
          JSON.stringify(expectedRuntimeConfig)
      )
    result.applied =
      details.every((detail) => detail.applied) && runtimeConfigMatches
    result.partial =
      !result.applied &&
      details.some((detail) => detail.applied || detail.partial)
    result.canApply = details.every((detail) => detail.canApply)
    result.managedBaseline = filePaths.every((filePath) =>
      this.baseline.hasOriginal(filePath)
    )

    CursorPatchService.workspaceControlStatusCache =
      CursorPatchService.setCachedStatus(cacheKey, result)
    return result
  }

  applyWorkspaceControlPatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const runtimeConfig = CursorPatchService.workspaceControlRuntimeConfig
    if (runtimeConfig === undefined) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Workspace control runtime is not configured"],
      }
    }

    const filePaths = getCursorWorkbenchPaths()
    if (filePaths.length === 0) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const expectedRuntimeConfigJson = JSON.stringify(runtimeConfig)
    const plans = filePaths.map((filePath) => {
      const content = fs.readFileSync(filePath, "utf-8")
      return {
        filePath,
        content,
        details: getCursorWorkspaceControlDetails(content),
        runtimeConfigMatches:
          JSON.stringify(readWorkspaceControlRuntimeConfig(content)) ===
          expectedRuntimeConfigJson,
      }
    })
    if (
      plans.every((plan) => plan.details.applied && plan.runtimeConfigMatches)
    ) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    const nextPlans: Array<{
      filePath: string
      content: string
      nextContent: string
    }> = []
    for (const plan of plans) {
      const nextContent = patchCursorWorkspaceControlContent(
        plan.content,
        runtimeConfig
      )
      if (nextContent === null) {
        return {
          success: false,
          applied: 0,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Workspace control cannot safely migrate the existing runtime: ${plan.filePath}`,
          ],
        }
      }
      nextPlans.push({ ...plan, nextContent })
    }

    const changedPlans = nextPlans.filter(
      (plan) => plan.nextContent !== plan.content
    )
    if (changedPlans.length === 0) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    const unmanagedPlans = changedPlans.filter(
      (plan) => !this.baseline.hasOriginal(plan.filePath)
    )
    const baselineCandidates = unmanagedPlans.map((plan) => ({
      filePath: plan.filePath,
      cleanContent: removeCursorWorkspaceControlPatchContent(plan.content),
    }))
    if (
      baselineCandidates.length > 0 &&
      baselineCandidates.every(
        (candidate) =>
          candidate.cleanContent !== null &&
          !PATCH_MARKERS.some((marker) =>
            candidate.cleanContent!.includes(marker)
          )
      )
    ) {
      for (const candidate of baselineCandidates) {
        this.baseline.captureOriginalContent(
          candidate.filePath,
          candidate.cleanContent!
        )
      }
    }
    for (const plan of changedPlans) {
      fs.writeFileSync(plan.filePath, plan.nextContent, "utf-8")
    }
    this.logger.info(
      `Applied patch: Workspace Control (${changedPlans.length} workbench file(s))`
    )
    return this.finalizePatchApply({
      applied: changedPlans.length,
      restartRequired: true,
    })
  }

  disableWorkspaceControlPatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePaths = getCursorWorkbenchPaths()
    if (filePaths.length === 0) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const activeFiles = filePaths
      .map((filePath) => ({
        filePath,
        currentContent: fs.readFileSync(filePath, "utf-8"),
      }))
      .filter(({ currentContent }) =>
        hasCursorWorkspaceControlPatch(currentContent)
      )
    if (activeFiles.length === 0) {
      return this.finalizePatchApply({ applied: 0 })
    }

    const nextFiles: Array<{ filePath: string; nextContent: string }> = []
    for (const activeFile of activeFiles) {
      const nextContent = removeCursorWorkspaceControlPatchContent(
        activeFile.currentContent
      )
      if (nextContent === null) {
        return {
          success: false,
          applied: 0,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Workspace control could not be disabled because its owned runtime boundary is incomplete: ${activeFile.filePath}`,
          ],
        }
      }
      nextFiles.push({ filePath: activeFile.filePath, nextContent })
    }

    for (const nextFile of nextFiles) {
      fs.writeFileSync(nextFile.filePath, nextFile.nextContent, "utf-8")
    }
    this.logger.info(
      `Disabled patch: Workspace Control (${nextFiles.length} workbench file(s))`
    )
    return this.finalizePatchApply({
      applied: nextFiles.length,
      restartRequired: true,
    })
  }

  getIdleExtensionHostKillerStatus(
    options: CursorPatchStatusOptions = {}
  ): CursorSinglePatchStatus {
    const cacheKey = "idle-killer"
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.idleKillerStatusCache,
      cacheKey,
      options.force
    )
    if (cached) {
      return cached
    }

    const filePath = getCursorWorkbenchPath()
    const result: CursorSinglePatchStatus = {
      filePath,
      fileExists: false,
      applied: false,
      canApply: false,
      managedBaseline: false,
      legacyBackupExists: false,
      legacyBackupClean: false,
    }

    if (!filePath || !fs.existsSync(filePath)) {
      CursorPatchService.idleKillerStatusCache =
        CursorPatchService.setCachedStatus(cacheKey, result)
      return result
    }

    result.fileExists = true
    result.managedBaseline = this.baseline.hasOriginal(filePath)
    const legacyBackupPath = filePath + BACKUP_SUFFIX
    result.legacyBackupExists = fs.existsSync(legacyBackupPath)
    if (result.legacyBackupExists) {
      const backupContent = fs.readFileSync(legacyBackupPath, "utf-8")
      result.legacyBackupClean = !backupContent.includes(
        IDLE_EXTENSION_HOST_KILLER_PATCH.marker
      )
    }

    const content = fs.readFileSync(filePath, "utf-8")
    result.applied = content.includes(IDLE_EXTENSION_HOST_KILLER_PATCH.marker)
    result.canApply = canPatchIdleExtensionHostKillerContent(content)

    CursorPatchService.idleKillerStatusCache =
      CursorPatchService.setCachedStatus(cacheKey, result)
    return result
  }

  applyIdleExtensionHostKillerPatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePath = getCursorWorkbenchPath()
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const content = fs.readFileSync(filePath, "utf-8")
    if (content.includes(IDLE_EXTENSION_HOST_KILLER_PATCH.marker)) {
      if (!this.baseline.hasOriginal(filePath)) {
        const legacyBackupPath = filePath + BACKUP_SUFFIX
        if (fs.existsSync(legacyBackupPath)) {
          const backupContent = fs.readFileSync(legacyBackupPath, "utf-8")
          if (
            !backupContent.includes(IDLE_EXTENSION_HOST_KILLER_PATCH.marker)
          ) {
            this.baseline.captureOriginalFromFile(filePath, legacyBackupPath)
            this.logger.info(
              "Captured existing Cursor idle killer patch baseline from legacy backup"
            )
          }
        }
      }
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    const nextContent = patchIdleExtensionHostKillerContent(content)
    if (nextContent === null) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          "Pattern not found: Disable Cursor Idle Extension Host Killer",
        ],
      }
    }

    this.baseline.ensureOriginals([filePath])
    fs.writeFileSync(filePath, nextContent, "utf-8")
    this.logger.info("Applied patch: Disable Cursor Idle Extension Host Killer")
    return this.finalizePatchApply({ applied: 1 })
  }

  getTrafficCapturePatchStatus(
    options: CursorPatchStatusOptions = {}
  ): CursorTrafficCapturePatchStatus {
    const filePath = getCursorWorkbenchPath()
    let cacheKey = "traffic-capture:missing"
    if (filePath && fs.existsSync(filePath)) {
      const fileStat = fs.statSync(filePath)
      cacheKey = `traffic-capture:${fileStat.size}:${fileStat.mtimeMs}`
    }
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.trafficCaptureStatusCache,
      cacheKey,
      options.force
    )
    if (cached) return cached

    const result: CursorTrafficCapturePatchStatus = {
      filePath,
      fileExists: false,
      applied: false,
      partial: false,
      canApply: false,
      managedBaseline: false,
      totalRules: CURSOR_TRAFFIC_CAPTURE_RULES.length,
      appliedRules: 0,
      availableRules: 0,
      missingRules: [],
    }
    if (!filePath || !fs.existsSync(filePath)) {
      CursorPatchService.trafficCaptureStatusCache =
        CursorPatchService.setCachedStatus(cacheKey, result)
      return result
    }

    result.fileExists = true
    result.managedBaseline = this.baseline.hasOriginal(filePath)
    const details = getCursorTrafficCaptureDetails(
      fs.readFileSync(filePath, "utf-8")
    )
    result.applied = details.applied
    result.partial = details.partial
    result.canApply = details.canApply
    result.appliedRules = details.appliedRuleNames.length
    result.availableRules = details.availableRuleNames.length
    result.missingRules = details.missingRuleNames

    CursorPatchService.trafficCaptureStatusCache =
      CursorPatchService.setCachedStatus(cacheKey, result)
    return result
  }

  applyTrafficCapturePatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePath = getCursorWorkbenchPath()
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const content = fs.readFileSync(filePath, "utf-8")
    const details = getCursorTrafficCaptureDetails(content)
    if (details.applied) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }
    const nextContent = patchCursorTrafficCaptureContent(content)
    if (nextContent === null) {
      const detail = details.missingRuleNames.join(", ") || "unknown rules"
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [`Traffic capture is unavailable for: ${detail}`],
      }
    }

    this.baseline.ensureOriginals([filePath])
    fs.writeFileSync(filePath, nextContent, "utf-8")
    this.logger.info(
      `Applied patch: Cursor Traffic Capture (${CURSOR_TRAFFIC_CAPTURE_RULES.length} hooks)`
    )
    return this.finalizePatchApply({ applied: 1 })
  }

  disableTrafficCapturePatch(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePath = getCursorWorkbenchPath()
    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    const currentContent = fs.readFileSync(filePath, "utf-8")
    const captureDetails = getCursorTrafficCaptureDetails(currentContent)
    if (
      !captureDetails.applied &&
      captureDetails.appliedRuleNames.length === 0
    ) {
      return this.finalizePatchApply({ applied: 0 })
    }

    const original = this.baseline.readOriginal(filePath)
    if (!original.content) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          `Cannot disable traffic capture without the managed Cursor baseline: ${original.error || "backup unavailable"}`,
        ],
      }
    }
    const nextContent = rebuildCursorWorkbenchWithoutTrafficCapture(
      currentContent,
      original.content
    )
    if (nextContent === null) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          "Traffic capture could not be disabled without changing active Cursor patches",
        ],
      }
    }

    fs.writeFileSync(filePath, nextContent, "utf-8")
    this.logger.info("Disabled patch: Cursor Traffic Capture")
    return this.finalizePatchApply({ applied: 1 })
  }

  /** Get the current patch status of the Cursor installation */
  getStatus(options: CursorPatchStatusOptions = {}): PatchStatus {
    const cacheKey = "legacy"
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.legacyStatusCache,
      cacheKey,
      options.force
    )
    if (cached) {
      return cached
    }

    const filePath = getCursorWorkbenchPath()
    const result: PatchStatus = {
      filePath,
      fileExists: false,
      backupExists: false,
      patches: [],
      allApplied: false,
      isPatched: false,
    }

    if (!filePath || !fs.existsSync(filePath)) {
      CursorPatchService.legacyStatusCache = CursorPatchService.setCachedStatus(
        cacheKey,
        result
      )
      return result
    }

    result.fileExists = true
    result.backupExists = fs.existsSync(filePath + BACKUP_SUFFIX)

    const content = fs.readFileSync(filePath, "utf-8")
    const entitlementDetails = getCursorEntitlementPatchDetails()
    result.isPatched = PATCH_MARKERS.some((m) => content.includes(m))
    result.patches = [
      {
        name: BRIDGE_ENDPOINT_PATCH.name,
        applied: content.includes(BRIDGE_ENDPOINT_PATCH.marker),
      },
      {
        name: PLAN_EDITOR_TAB_PATCH.name,
        applied: isPlanEditorTabPatchApplied(content),
      },
      {
        name: WORKSPACE_CHANGE_AGENT_GATE_PATCH.name,
        applied: isWorkspaceChangeAgentGatePatchApplied(content),
      },
      {
        name: READ_TODOS_TRANSLATION_PATCH.name,
        applied: isReadTodosTranslationPatchApplied(content),
      },
      {
        name: CURSOR_ENTITLEMENT_PATCH.name,
        applied: !entitlementDetails.fileExists || entitlementDetails.applied,
      },
      {
        name: IDLE_EXTENSION_HOST_KILLER_PATCH.name,
        applied: content.includes(IDLE_EXTENSION_HOST_KILLER_PATCH.marker),
      },
    ]
    result.allApplied = result.patches.every((p) => p.applied)

    CursorPatchService.legacyStatusCache = CursorPatchService.setCachedStatus(
      cacheKey,
      result
    )
    return result
  }

  /** Apply Agent Vibes patches to Cursor workbench */
  applyPatches(): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const errors: string[] = []
    const filePath = getCursorWorkbenchPath()

    if (!filePath || !fs.existsSync(filePath)) {
      return {
        success: false,
        applied: 0,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: ["Cursor workbench file not found"],
      }
    }

    // Create backup if needed
    const backupPath = filePath + BACKUP_SUFFIX
    if (!fs.existsSync(backupPath)) {
      const content = fs.readFileSync(filePath, "utf-8")
      if (PATCH_MARKERS.some((m) => content.includes(m))) {
        return {
          success: false,
          applied: 0,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            "Cannot create clean backup — file is already patched. Reinstall Cursor first.",
          ],
        }
      }
      fs.copyFileSync(filePath, backupPath)
      this.logger.info("Created backup of Cursor workbench")
    }

    // Apply patches
    let content = fs.readFileSync(filePath, "utf-8")
    const original = content
    let applied = 0

    const idlePatchedContent = patchIdleExtensionHostKillerContent(content)
    if (idlePatchedContent === null) {
      errors.push(`Pattern not found: ${IDLE_EXTENSION_HOST_KILLER_PATCH.name}`)
    } else if (idlePatchedContent !== content) {
      content = idlePatchedContent
      applied++
      this.logger.info(
        `Applied patch: ${IDLE_EXTENSION_HOST_KILLER_PATCH.name}`
      )
    }

    const planEditorPatchedContent = patchPlanEditorTabContent(content)
    if (planEditorPatchedContent === null) {
      errors.push(`Pattern not found: ${PLAN_EDITOR_TAB_PATCH.name}`)
    } else if (planEditorPatchedContent !== content) {
      content = planEditorPatchedContent
      applied++
      this.logger.info(`Applied patch: ${PLAN_EDITOR_TAB_PATCH.name}`)
    }

    const workspaceChangeAgentGatePatchedContent =
      patchWorkspaceChangeAgentGateContent(content)
    if (workspaceChangeAgentGatePatchedContent === null) {
      errors.push(
        `Pattern not found: ${WORKSPACE_CHANGE_AGENT_GATE_PATCH.name}`
      )
    } else if (workspaceChangeAgentGatePatchedContent !== content) {
      content = workspaceChangeAgentGatePatchedContent
      applied++
      this.logger.info(
        `Applied patch: ${WORKSPACE_CHANGE_AGENT_GATE_PATCH.name}`
      )
    }

    const readTodosPatchedContent = patchReadTodosTranslationContent(content)
    if (readTodosPatchedContent === null) {
      errors.push(`Pattern not found: ${READ_TODOS_TRANSLATION_PATCH.name}`)
    } else if (readTodosPatchedContent !== content) {
      content = readTodosPatchedContent
      applied++
      this.logger.info(`Applied patch: ${READ_TODOS_TRANSLATION_PATCH.name}`)
    }

    if (content !== original) {
      fs.writeFileSync(filePath, content, "utf-8")
    }

    return this.finalizePatchApply({ applied, errors })
  }

  private finalizePatchApply(input: {
    applied: number
    errors?: string[]
    forceChecksum?: boolean
    restartRequired?: boolean
  }): CursorPatchApplyResult {
    const patchErrors = input.errors ?? []
    const shouldApplyChecksum =
      input.applied > 0 || input.forceChecksum === true
    if (!shouldApplyChecksum) {
      return {
        success: patchErrors.length === 0,
        applied: input.applied,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: patchErrors,
        restartRequired: input.restartRequired ?? false,
      }
    }

    const checksumResult = this.applyChecksumsAfterPatch()
    const errors = [...patchErrors, ...checksumResult.errors]
    return {
      success: errors.length === 0,
      applied: input.applied,
      checksumApplied: checksumResult.applied,
      checksumUpdated: checksumResult.updated,
      errors,
      restartRequired: input.restartRequired ?? input.applied > 0,
    }
  }

  private applyChecksumsAfterPatch(): {
    applied: boolean
    updated: number
    errors: string[]
  } {
    const status = this.checksums.getStatus({ force: true })
    if (!status.productExists || !status.hasChecksums) {
      return { applied: false, updated: 0, errors: [] }
    }

    const result = this.checksums.apply()
    if (!result.success) {
      return {
        applied: false,
        updated: 0,
        errors: result.errors.map(
          (error) => `Checksum repair failed: ${error}`
        ),
      }
    }

    this.logger.info(
      `Applied Cursor checksum repair after patch (updated=${result.updated})`
    )
    return { applied: true, updated: result.updated, errors: [] }
  }

  /** Restore Cursor workbench from backup */
  restore(): boolean {
    this.invalidateStatusCache()

    const filePath = getCursorWorkbenchPath()
    if (!filePath) {
      this.logger.error("Cursor workbench file not found")
      return false
    }

    const backupPath = filePath + BACKUP_SUFFIX
    if (!fs.existsSync(backupPath)) {
      this.logger.error("No backup found — cannot restore")
      return false
    }

    const backupContent = fs.readFileSync(backupPath, "utf-8")
    if (PATCH_MARKERS.some((m) => backupContent.includes(m))) {
      this.logger.error("Backup file is corrupted (contains patches)")
      return false
    }

    fs.copyFileSync(backupPath, filePath)
    this.logger.info("Restored Cursor workbench from backup")
    return true
  }
}
