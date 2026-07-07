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
import { CursorPatchBaselineService } from "./cursor-patch-baseline"

type Logger = typeof LoggerInstance

const BACKUP_SUFFIX = ".transport_backup"
const IDLE_EXTENSION_HOST_KILLER_MARKER =
  "[AGENT_VIBES_DISABLE_IDLE_EXTENSION_HOST_KILLER]"
const IDLE_EXTENSION_HOST_KILLER_PATCH_INSERTION = `/*${IDLE_EXTENSION_HOST_KILLER_MARKER}*/return;`
const BRIDGE_ENDPOINT_PATCH_MARKER = "[AGENT_VIBES_CURSOR_BRIDGE_ENDPOINT]"
const BRIDGE_ENDPOINT_PATCH_INSERTION = `/*${BRIDGE_ENDPOINT_PATCH_MARKER}*/`
const BRIDGE_ENDPOINT_STORAGE_GUARD_MARKER =
  "[AGENT_VIBES_CURSOR_STORAGE_GUARD]"
const BRIDGE_ENDPOINT_PERSISTENT_GUARD_MARKER =
  "[AGENT_VIBES_CURSOR_ENDPOINT_GUARD]"
const BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER =
  "[AGENT_VIBES_CURSOR_CREDENTIALS_GUARD]"
const BRIDGE_ENDPOINT_MODULE_ID =
  '"out-build/vs/platform/reactivestorage/browser/reactiveStorageService.js"'
const BRIDGE_ENDPOINT_MODULE_SEARCH_LIMIT = 120_000
const BRIDGE_ENDPOINT_MIN_TARGETS = 4
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
const CURSOR_CREDS_ENDPOINT_FIELDS = [
  "backendUrl",
  "repoBackendUrl",
  "cppBackendUrl",
  "telemBackendUrl",
  "cmdkBackendUrl",
  "geoCppBackendUrl",
  "cppConfigBackendUrl",
  "bcProxyUrl",
  "agentUrl",
] as const
const CURSOR_CREDS_AGENT_ENDPOINT_FIELDS = [
  "agentBackendUrlPrivacy",
  "agentBackendUrlNonPrivacy",
] as const

const IDLE_EXTENSION_HOST_KILLER_PATCH = {
  name: "Disable Cursor Idle Extension Host Killer",
  marker: IDLE_EXTENSION_HOST_KILLER_MARKER,
}

const BRIDGE_ENDPOINT_PATCH = {
  name: "Cursor Bridge Endpoint",
  marker: BRIDGE_ENDPOINT_PATCH_MARKER,
}

const CURSOR_ENTITLEMENT_PATCH = {
  name: "Cursor Entitlement State",
}

/**
 * Patch rules for Cursor's workbench.desktop.main.js.
 * Each rule identifies a code pattern via regex and injects logging hooks
 * to capture gRPC transport traffic (request/response payloads).
 */
interface PatchRule {
  name: string
  find: RegExp
  replace: string
  marker: string
}

const TRANSPORT_PATCHES: PatchRule[] = [
  {
    name: "Transport Request Initiation",
    find: /this\.structuredLogService\.debug\("transport","Initiating stream AI connect",\{service:e\.typeName,method:t\.name,streamId:(\w+),requestId:(\w+)\?\?"not-found"/,
    replace:
      'console.warn("[TRANSPORT_REQUEST]",JSON.stringify({service:e.typeName,method:t.name,streamId:$1,requestId:$2,requestType:t.I?.typeName,responseType:t.O?.typeName})),this.structuredLogService.debug("transport","Initiating stream AI connect",{service:e.typeName,method:t.name,streamId:$1,requestId:$2??"not-found"',
    marker: "[TRANSPORT_REQUEST]",
  },
  {
    name: "Transport Request Payload",
    find: /const (\w+)=new t\.I\((\w+)\);(\w+)=(\w+)\.wrap\(\1\.toBinary\(\)\)/,
    replace:
      'const $1=new t.I($2);(()=>{try{console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:t.I?.typeName,payload:$1.toJson?$1.toJson():$2}))}catch(xErr){console.warn("[TRANSPORT_REQUEST_PAYLOAD]",JSON.stringify({type:t.I?.typeName,error:String(xErr)}))}})();$3=$4.wrap($1.toBinary())',
    marker: "[TRANSPORT_REQUEST_PAYLOAD]",
  },
  {
    name: "Transport Response Chunk",
    find: /this\._proxy\.\$pushAiConnectTransportStreamChunk\((\w+),(\w+),(\w+)\)/,
    replace:
      '(console.warn("[TRANSPORT_CHUNK]",JSON.stringify({streamId:$2,chunkSize:$1?.length||0,chunkB64:$1?btoa(String.fromCharCode.apply(null,$1.slice(0,2000))):null})),this._proxy.$pushAiConnectTransportStreamChunk($1,$2,$3))',
    marker: "[TRANSPORT_CHUNK]",
  },
  {
    name: "Transport Response Yield",
    find: /for await\(const (\w+) of (\w+)\)\{if\((\w+)\.token\.isCancellationRequested\)continue;yield t\.O\.fromBinary\(\1\.buffer\)\}/,
    replace:
      'for await(const $1 of $2){if($3.token.isCancellationRequested)continue;const xResp=t.O.fromBinary($1.buffer);(()=>{try{console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:t.O?.typeName,payload:xResp.toJson?xResp.toJson():xResp}))}catch(xErr){console.warn("[TRANSPORT_RESPONSE]",JSON.stringify({type:t.O?.typeName,error:String(xErr)}))}})();yield xResp}',
    marker: "[TRANSPORT_RESPONSE]",
  },
  {
    name: "Unary Request Payload",
    find: /const (\w+)=new a\.I\((\w+)\),(\w+)=(\w+)\.wrap\(\1\.toBinary\(\)\)/,
    replace:
      'const $1=new a.I($2);(()=>{try{const svc=o.typeName,mth=a.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_REQUEST]",JSON.stringify({service:svc,method:mth,type:a.I?.typeName,payload:$1.toJson?$1.toJson():$2}))}catch(xErr){console.warn("[UNARY_REQUEST]",JSON.stringify({service:o.typeName,method:a.name,type:a.I?.typeName,error:String(xErr)}))}})();const $3=$4.wrap($1.toBinary())',
    marker: "[UNARY_REQUEST]",
  },
  {
    name: "Unary Response",
    find: /const (\w+)=(\w+)\.message,(\w+)=\2\.header,(\w+)=\2\.trailer,(\w+)=a\.O\.fromBinary\(\1\)/,
    replace:
      'const $1=$2.message,$3=$2.header,$4=$2.trailer,$5=a.O.fromBinary($1);(()=>{try{const svc=o.typeName,mth=a.name;const skip=["GetTeams","GetUser","GetSubscription","CheckQueuePosition","FlushEvents","Batch","SubmitLogs","SubmitSpans","BootstrapStatsig","ReportClientNumericMetrics"];if(skip.includes(mth))return;console.warn("[UNARY_RESPONSE]",JSON.stringify({service:svc,method:mth,type:a.O?.typeName,payload:$5.toJson?$5.toJson():$5}))}catch(xErr){console.warn("[UNARY_RESPONSE]",JSON.stringify({service:o.typeName,method:a.name,type:a.O?.typeName,error:String(xErr)}))}})()',
    marker: "[UNARY_RESPONSE]",
  },
]

const PATCH_MARKERS = [
  IDLE_EXTENSION_HOST_KILLER_MARKER,
  BRIDGE_ENDPOINT_PATCH_MARKER,
  ...TRANSPORT_PATCHES.map((p) => p.marker),
]

type IdleExtensionHostKillerLocation = {
  methodStart: number
  bodyStart: number
  bodyEnd: number
}

type BridgeEndpointConstantsLocation = {
  start: number
  end: number
  segment: string
}

type CursorBridgeEndpointKind = "api" | "agent"

type BridgeEndpointSegmentSummary = {
  hasMarker: boolean
  hasStorageGuard: boolean
  hasPersistentGuard: boolean
  targetCount: number
  apiTargetCount: number
  agentTargetCount: number
  localCount: number
  matchingLocalCount: number
  firstCurrentUrl: string | null
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
  const methodPattern =
    /async\s+maybeStopExtensionHostsForIdle\s*\([^)]*\)\s*\{/g
  let match: RegExpExecArray | null

  while ((match = methodPattern.exec(content)) !== null) {
    const openBraceOffset = match[0].lastIndexOf("{")
    if (openBraceOffset < 0) continue
    const openBrace = match.index + openBraceOffset

    const closeBrace = findMatchingBrace(content, openBrace)
    if (closeBrace === null) continue

    const body = content.slice(openBrace + 1, closeBrace)
    if (isIdleExtensionHostKillerMethodBody(body)) {
      return {
        methodStart: match.index,
        bodyStart: openBrace + 1,
        bodyEnd: closeBrace,
      }
    }
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

function normalizeBridgePort(port: number): number {
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 2026
}

export function getCursorBridgeEndpointUrl(port: number): string {
  return `https://localhost:${normalizeBridgePort(port)}`
}

function getCursorBridgeEndpointWorkbenchPaths(): string[] {
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

function locateBridgeEndpointConstants(
  content: string
): BridgeEndpointConstantsLocation | null {
  const moduleIndex = content.indexOf(BRIDGE_ENDPOINT_MODULE_ID)
  if (moduleIndex < 0) {
    return null
  }

  const end = Math.min(
    content.length,
    moduleIndex + BRIDGE_ENDPOINT_MODULE_SEARCH_LIMIT
  )
  const segment = content.slice(moduleIndex, end)

  return {
    start: moduleIndex,
    end,
    segment,
  }
}

function getCursorBridgeEndpointKind(
  value: string
): CursorBridgeEndpointKind | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:") {
      return null
    }
    if (/^api\d+\.cursor\.sh$/u.test(url.hostname)) {
      return "api"
    }
    if (/^repo\d+\.cursor\.sh$/u.test(url.hostname)) {
      return "api"
    }
    if (/^agent[a-z0-9-]*\.api\d+\.cursor\.sh$/u.test(url.hostname)) {
      return "agent"
    }
  } catch {
    return null
  }

  return null
}

function isLocalBridgeEndpoint(value: string | null): boolean {
  return value !== null && /^https:\/\/localhost:\d+$/u.test(value)
}

function summarizeBridgeEndpointSegment(
  segment: string,
  bridgeUrl: string
): BridgeEndpointSegmentSummary {
  const summary: BridgeEndpointSegmentSummary = {
    hasMarker: segment.includes(BRIDGE_ENDPOINT_PATCH_MARKER),
    hasStorageGuard: segment.includes(BRIDGE_ENDPOINT_STORAGE_GUARD_MARKER),
    hasPersistentGuard: segment.includes(
      BRIDGE_ENDPOINT_PERSISTENT_GUARD_MARKER
    ),
    targetCount: 0,
    apiTargetCount: 0,
    agentTargetCount: 0,
    localCount: 0,
    matchingLocalCount: 0,
    firstCurrentUrl: null,
  }

  const stringLiteralPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"/gu
  let match: RegExpExecArray | null
  while ((match = stringLiteralPattern.exec(segment)) !== null) {
    const value = match[1]
    if (value === undefined) {
      continue
    }
    const kind = getCursorBridgeEndpointKind(value)
    if (kind !== null) {
      summary.targetCount++
      if (kind === "api") {
        summary.apiTargetCount++
      } else {
        summary.agentTargetCount++
      }
      summary.firstCurrentUrl ??= value
      continue
    }

    if (isLocalBridgeEndpoint(value)) {
      summary.localCount++
      if (value === bridgeUrl) {
        summary.matchingLocalCount++
      }
      summary.firstCurrentUrl ??= value
    }
  }

  return summary
}

function hasFreshBridgeEndpointTargets(
  summary: BridgeEndpointSegmentSummary
): boolean {
  return (
    summary.targetCount >= BRIDGE_ENDPOINT_MIN_TARGETS &&
    summary.apiTargetCount > 0 &&
    summary.agentTargetCount > 0
  )
}

function hasManagedBridgeEndpointTargets(
  summary: BridgeEndpointSegmentSummary
): boolean {
  return (
    summary.hasMarker && (summary.localCount > 0 || summary.targetCount > 0)
  )
}

function locateExistingBridgeEndpointStorageGuard(
  segment: string
): { start: number; end: number } | null {
  const markerIndex = segment.indexOf(BRIDGE_ENDPOINT_STORAGE_GUARD_MARKER)
  if (markerIndex < 0) {
    return null
  }

  const start = segment.lastIndexOf("/*", markerIndex)
  if (start < 0) {
    return null
  }

  const arrowIndex = segment.indexOf("=>", markerIndex)
  if (arrowIndex < 0) {
    return null
  }

  const bodyStart = segment.indexOf("{", arrowIndex)
  if (bodyStart < 0) {
    return null
  }

  const bodyEnd = findMatchingBrace(segment, bodyStart)
  if (bodyEnd === null) {
    return null
  }

  return {
    start,
    end: segment[bodyEnd + 1] === "," ? bodyEnd + 2 : bodyEnd + 1,
  }
}

function canRemoveBridgeEndpointStorageGuard(segment: string): boolean {
  return (
    !segment.includes(BRIDGE_ENDPOINT_STORAGE_GUARD_MARKER) ||
    locateExistingBridgeEndpointStorageGuard(segment) !== null
  )
}

function removeBridgeEndpointStorageGuard(segment: string): string | null {
  const location = locateExistingBridgeEndpointStorageGuard(segment)
  if (location === null) {
    return segment.includes(BRIDGE_ENDPOINT_STORAGE_GUARD_MARKER)
      ? null
      : segment
  }

  return segment.slice(0, location.start) + segment.slice(location.end)
}

function locateExistingBridgeEndpointPersistentGuard(
  segment: string
): { start: number; end: number } | null {
  const markerIndex = segment.indexOf(BRIDGE_ENDPOINT_PERSISTENT_GUARD_MARKER)
  if (markerIndex < 0) {
    return null
  }

  const start = segment.lastIndexOf("/*", markerIndex)
  if (start < 0) {
    return null
  }

  const arrowIndex = segment.indexOf("=>", markerIndex)
  if (arrowIndex < 0) {
    return null
  }

  const bodyStart = segment.indexOf("{", arrowIndex)
  if (bodyStart < 0) {
    return null
  }

  const bodyEnd = findMatchingBrace(segment, bodyStart)
  if (bodyEnd === null) {
    return null
  }

  return {
    start,
    end: segment[bodyEnd + 1] === "," ? bodyEnd + 2 : bodyEnd + 1,
  }
}

function locateBridgeEndpointMigrationInsertion(
  segment: string
): number | null {
  const cursorCredsIndex = segment.indexOf("cursorCreds:")
  if (cursorCredsIndex < 0) {
    return null
  }

  const tail = segment.slice(cursorCredsIndex)
  const identifier = String.raw`[A-Za-z_$][\w$]*`
  const match = new RegExp(
    String.raw`\},${identifier}=\[\(${identifier},${identifier}\)=>`,
    "u"
  ).exec(tail)
  if (!match) {
    return null
  }

  const arrayStart = match[0].lastIndexOf("[")
  if (arrayStart < 0) {
    return null
  }

  return cursorCredsIndex + match.index + arrayStart + 1
}

function getBridgeEndpointPersistentGuard(bridgeUrl: string): string {
  return `/*${BRIDGE_ENDPOINT_PERSISTENT_GUARD_MARKER}*/(e,t)=>{const n="${bridgeUrl}",r=t?.cursorCreds;if(!r||typeof r!="object")return t;const a=e=>{const t={...(e||{})};for(const e in t)typeof t[e]=="string"&&(t[e]=n);return t.default=n,t},s={...r,backendUrl:n,repoBackendUrl:n,cppBackendUrl:n,telemBackendUrl:n,cmdkBackendUrl:n,geoCppBackendUrl:n,cppConfigBackendUrl:n,bcProxyUrl:n,agentUrl:n,agentBackendUrlPrivacy:a(r.agentBackendUrlPrivacy),agentBackendUrlNonPrivacy:a(r.agentBackendUrlNonPrivacy)};let o={...t,cursorCreds:s};return o.cppConfig&&typeof o.cppConfig=="object"&&typeof o.cppConfig.cppUrl=="string"?{...o,cppConfig:{...o.cppConfig,cppUrl:n}}:o},`
}

function canPatchBridgeEndpointPersistentGuard(segment: string): boolean {
  return segment.includes(BRIDGE_ENDPOINT_PERSISTENT_GUARD_MARKER)
    ? locateExistingBridgeEndpointPersistentGuard(segment) !== null
    : locateBridgeEndpointMigrationInsertion(segment) !== null
}

function patchBridgeEndpointPersistentGuard(
  segment: string,
  bridgeUrl: string
): string | null {
  const guard = getBridgeEndpointPersistentGuard(bridgeUrl)
  const existingGuard = locateExistingBridgeEndpointPersistentGuard(segment)
  if (existingGuard !== null) {
    return (
      segment.slice(0, existingGuard.start) +
      guard +
      segment.slice(existingGuard.end)
    )
  }

  const insertion = locateBridgeEndpointMigrationInsertion(segment)
  if (insertion === null) {
    return null
  }

  return segment.slice(0, insertion) + guard + segment.slice(insertion)
}

function getBridgeEndpointCredentialsGuard(): string {
  return `/*${BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER}*/`
}

function getBridgeEndpointCredentialsGuardMethod(bridgeUrl: string): string {
  return `getEffectiveCredentials(){const e=this.reactiveStorageService.applicationUserPersistentStorage.cursorCreds,t=this.testBackendUrlOverride,agentVibesNormalize=${getBridgeEndpointCredentialsGuard()}(base,url="${bridgeUrl}")=>({...base,backendUrl:url,repoBackendUrl:url,cppBackendUrl:url,telemBackendUrl:url,geoCppBackendUrl:url,cppConfigBackendUrl:url,cmdkBackendUrl:url,bcProxyUrl:url,agentUrl:url,agentBackendUrlPrivacy:{default:url},agentBackendUrlNonPrivacy:{default:url}});if(!t)return agentVibesNormalize(e);const n=this.getAgentBackendUrls(t);return agentVibesNormalize({...e,backendUrl:t,repoBackendUrl:t,cppBackendUrl:t,telemBackendUrl:t,geoCppBackendUrl:t,cppConfigBackendUrl:t,cmdkBackendUrl:t,bcProxyUrl:t,agentUrl:t,agentBackendUrlNonPrivacy:n},t)}`
}

function locateExistingBridgeEndpointCredentialsGuard(
  content: string
): { start: number; end: number } | null {
  const markerIndex = content.indexOf(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)
  if (markerIndex < 0) {
    return null
  }

  const methodStart = content.lastIndexOf(
    "getEffectiveCredentials(){",
    markerIndex
  )
  if (methodStart < 0) {
    return null
  }

  const bodyStart = content.indexOf("{", methodStart)
  if (bodyStart < 0 || bodyStart > markerIndex) {
    return null
  }

  const bodyEnd = findMatchingBrace(content, bodyStart)
  if (bodyEnd === null) {
    return null
  }

  return { start: methodStart, end: bodyEnd + 1 }
}

function hasCurrentBridgeEndpointCredentialsGuard(content: string): boolean {
  const existingGuard = locateExistingBridgeEndpointCredentialsGuard(content)
  if (existingGuard === null) {
    return false
  }

  const guard = content.slice(existingGuard.start, existingGuard.end)
  return guard.includes("repoBackendUrl:url") && guard.includes("agentUrl:url")
}

function locateBridgeEndpointCredentialsGuard(
  content: string
): RegExpExecArray | null {
  const identifier = String.raw`[A-Za-z_$][\w$]*`
  const pattern = new RegExp(
    String.raw`getEffectiveCredentials\(\)\{const (${identifier})=this\.reactiveStorageService\.applicationUserPersistentStorage\.cursorCreds,(${identifier})=this\.testBackendUrlOverride;if\(!\2\)return \1;const (${identifier})=this\.getAgentBackendUrls\(\2\);return\{\.\.\.\1,backendUrl:\2,repoBackendUrl:\2,telemBackendUrl:\2,geoCppBackendUrl:\2,cppConfigBackendUrl:\2,cmdkBackendUrl:\2,bcProxyUrl:\2,agentBackendUrlNonPrivacy:\3\}\}`,
    "u"
  )
  return pattern.exec(content)
}

function canPatchBridgeEndpointCredentialsGuard(content: string): boolean {
  return (
    (content.includes(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER) &&
      locateExistingBridgeEndpointCredentialsGuard(content) !== null) ||
    locateBridgeEndpointCredentialsGuard(content) !== null
  )
}

function patchBridgeEndpointCredentialsGuard(
  content: string,
  bridgeUrl: string
): string | null {
  if (content.includes(BRIDGE_ENDPOINT_CREDENTIALS_GUARD_MARKER)) {
    const existingGuard = locateExistingBridgeEndpointCredentialsGuard(content)
    if (existingGuard === null) {
      return null
    }

    return (
      content.slice(0, existingGuard.start) +
      getBridgeEndpointCredentialsGuardMethod(bridgeUrl) +
      content.slice(existingGuard.end)
    )
  }

  const match = locateBridgeEndpointCredentialsGuard(content)
  if (!match) {
    return null
  }

  if (!match[1] || !match[2] || !match[3]) {
    return null
  }

  return (
    content.slice(0, match.index) +
    getBridgeEndpointCredentialsGuardMethod(bridgeUrl) +
    content.slice(match.index + match[0].length)
  )
}

export function canPatchBridgeEndpointContent(content: string): boolean {
  const location = locateBridgeEndpointConstants(content)
  if (!location) {
    return false
  }

  const bridgeUrl = getCursorBridgeEndpointUrl(2026)
  const summary = summarizeBridgeEndpointSegment(location.segment, bridgeUrl)
  return (
    (hasFreshBridgeEndpointTargets(summary) ||
      hasManagedBridgeEndpointTargets(summary)) &&
    canRemoveBridgeEndpointStorageGuard(location.segment) &&
    canPatchBridgeEndpointPersistentGuard(location.segment) &&
    canPatchBridgeEndpointCredentialsGuard(content)
  )
}

export function patchBridgeEndpointContent(
  content: string,
  port: number
): string | null {
  const location = locateBridgeEndpointConstants(content)
  if (!location) {
    return null
  }

  const bridgeUrl = getCursorBridgeEndpointUrl(port)
  let segment = location.segment
  const beforeSummary = summarizeBridgeEndpointSegment(segment, bridgeUrl)

  if (
    !hasFreshBridgeEndpointTargets(beforeSummary) &&
    !hasManagedBridgeEndpointTargets(beforeSummary)
  ) {
    return null
  }

  let replaced = 0
  let markerInserted = beforeSummary.hasMarker
  segment = segment.replace(
    /"([^"\\]*(?:\\.[^"\\]*)*)"/gu,
    (match: string, value: string): string => {
      const shouldReplace =
        getCursorBridgeEndpointKind(value) !== null ||
        (beforeSummary.hasMarker && isLocalBridgeEndpoint(value))
      if (!shouldReplace) {
        return match
      }

      const marker = markerInserted ? "" : BRIDGE_ENDPOINT_PATCH_INSERTION
      markerInserted = true
      replaced++
      return `"${bridgeUrl}"${marker}`
    }
  )

  const segmentWithoutStorageGuard = removeBridgeEndpointStorageGuard(segment)
  if (segmentWithoutStorageGuard === null) {
    return null
  }
  segment = segmentWithoutStorageGuard

  const segmentWithoutPersistentGuard = segment
  const segmentWithPersistentGuard = patchBridgeEndpointPersistentGuard(
    segment,
    bridgeUrl
  )
  if (segmentWithPersistentGuard === null) {
    return null
  }
  segment = segmentWithPersistentGuard
  const persistentGuardChanged = segment !== segmentWithoutPersistentGuard

  const afterSummary = summarizeBridgeEndpointSegment(segment, bridgeUrl)
  if (
    !afterSummary.hasMarker ||
    afterSummary.hasStorageGuard ||
    !afterSummary.hasPersistentGuard ||
    afterSummary.targetCount > 0 ||
    afterSummary.localCount < BRIDGE_ENDPOINT_MIN_TARGETS ||
    afterSummary.localCount !== afterSummary.matchingLocalCount ||
    (replaced === 0 &&
      !beforeSummary.hasStorageGuard &&
      !persistentGuardChanged)
  ) {
    return null
  }

  const contentWithEndpointPatch =
    content.slice(0, location.start) + segment + content.slice(location.end)
  const contentWithCredentialsGuard = patchBridgeEndpointCredentialsGuard(
    contentWithEndpointPatch,
    bridgeUrl
  )
  if (contentWithCredentialsGuard === null) {
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
  const location = locateBridgeEndpointConstants(content)
  if (!location) {
    return {
      currentUrl: null,
      applied: false,
      canApply: false,
      requiresPortUpdate: false,
      coverage: {
        apiTargets: 0,
        agentTargets: 0,
        localEndpoints: 0,
        matchingLocalEndpoints: 0,
        credentialsGuard: false,
        persistentGuard: false,
        storageGuardRemoved: false,
      },
    }
  }

  const summary = summarizeBridgeEndpointSegment(location.segment, bridgeUrl)
  const credentialsGuard = hasCurrentBridgeEndpointCredentialsGuard(content)
  const canApply =
    (hasFreshBridgeEndpointTargets(summary) ||
      hasManagedBridgeEndpointTargets(summary)) &&
    canRemoveBridgeEndpointStorageGuard(location.segment) &&
    canPatchBridgeEndpointPersistentGuard(location.segment) &&
    canPatchBridgeEndpointCredentialsGuard(content)
  const applied =
    summary.hasMarker &&
    !summary.hasStorageGuard &&
    summary.hasPersistentGuard &&
    credentialsGuard &&
    summary.targetCount === 0 &&
    summary.localCount >= BRIDGE_ENDPOINT_MIN_TARGETS &&
    summary.localCount === summary.matchingLocalCount

  return {
    currentUrl: summary.firstCurrentUrl,
    applied,
    canApply,
    requiresPortUpdate:
      summary.hasMarker && summary.localCount > 0 && canApply && !applied,
    coverage: {
      apiTargets: summary.apiTargetCount,
      agentTargets: summary.agentTargetCount,
      localEndpoints: summary.localCount,
      matchingLocalEndpoints: summary.matchingLocalCount,
      credentialsGuard,
      persistentGuard: summary.hasPersistentGuard,
      storageGuardRemoved: !summary.hasStorageGuard,
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
  return getCursorBridgeEndpointKind(value) !== null ||
    isLocalBridgeEndpoint(value)
    ? value
    : currentUrl
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

  for (const field of CURSOR_CREDS_ENDPOINT_FIELDS) {
    currentUrl = firstEndpointUrl(currentUrl, cursorCreds[field])
    if (cursorCreds[field] !== bridgeUrl) {
      cursorCreds[field] = bridgeUrl
      changed = true
    }
  }

  for (const field of CURSOR_CREDS_AGENT_ENDPOINT_FIELDS) {
    const normalizedMap = normalizeCursorAgentEndpointMap(
      cursorCreds[field],
      bridgeUrl
    )
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

function getCursorPersistentEndpointPatchDetails(
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

function getCursorStartupPreferencePatchDetails(): CursorStartupPreferencePatchDetails {
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
 * CursorPatchService — Manages patching and restoring Cursor's
 * workbench.desktop.main.js to inject transport-layer traffic capture.
 */
export class CursorPatchService {
  private static bridgeEndpointStatusCache: CursorPatchStatusCache<CursorBridgeEndpointPatchStatus> | null =
    null
  private static idleKillerStatusCache: CursorPatchStatusCache<CursorSinglePatchStatus> | null =
    null
  private static legacyStatusCache: CursorPatchStatusCache<PatchStatus> | null =
    null

  private readonly logger: Logger
  private readonly baseline = new CursorPatchBaselineService()
  private readonly checksums = new CursorChecksumsService()

  constructor(logger: Logger) {
    this.logger = logger
  }

  static invalidateStatusCache(): void {
    CursorPatchService.bridgeEndpointStatusCache = null
    CursorPatchService.idleKillerStatusCache = null
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
    status: T
  ): CursorPatchStatusCache<T> {
    return {
      key,
      expiresAt: Date.now() + CURSOR_PATCH_STATUS_CACHE_TTL_MS,
      status,
    }
  }

  getBridgeEndpointPatchStatus(
    port: number,
    options: CursorPatchStatusOptions = {}
  ): CursorBridgeEndpointPatchStatus {
    const cacheKey = `bridge:${normalizeBridgePort(port)}`
    const cached = CursorPatchService.getCachedStatus(
      CursorPatchService.bridgeEndpointStatusCache,
      cacheKey,
      options.force
    )
    if (cached) {
      return cached
    }

    const filePaths = getCursorBridgeEndpointWorkbenchPaths()
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
        CursorPatchService.setCachedStatus(cacheKey, result)
      return result
    }

    result.fileExists = true
    result.managedBaseline = filePaths.every((path) =>
      this.baseline.hasOriginal(path)
    )
    const workbenchDetails = filePaths.map((path) =>
      getBridgeEndpointDetails(fs.readFileSync(path, "utf-8"), port)
    )
    const startupPreferenceDetails = getCursorStartupPreferencePatchDetails()
    const persistentEndpointDetails =
      getCursorPersistentEndpointPatchDetails(port)
    const entitlementDetails = getCursorEntitlementPatchDetails()
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
      persistentGuard:
        workbenchDetails.length > 0 &&
        workbenchDetails.every((details) => details.coverage.persistentGuard),
      storageGuardRemoved:
        workbenchDetails.length > 0 &&
        workbenchDetails.every(
          (details) => details.coverage.storageGuardRemoved
        ),
    }

    result.applied =
      workbenchDetails.every((details) => details.applied) &&
      (!startupPreferenceDetails.fileExists ||
        startupPreferenceDetails.applied) &&
      (!persistentEndpointDetails.fileExists ||
        persistentEndpointDetails.applied) &&
      (!entitlementDetails.fileExists || entitlementDetails.applied) &&
      nodeCaDetails.applied
    result.canApply =
      workbenchDetails.some((details) => details.canApply) ||
      (startupPreferenceDetails.fileExists &&
        startupPreferenceDetails.canApply) ||
      (persistentEndpointDetails.fileExists &&
        persistentEndpointDetails.canApply) ||
      (entitlementDetails.fileExists && entitlementDetails.canApply) ||
      nodeCaDetails.canApply
    result.currentUrl =
      persistentEndpointDetails.currentUrl ??
      workbenchDetails.find((details) => !details.applied)?.currentUrl ??
      workbenchDetails[0]?.currentUrl ??
      null
    result.requiresPortUpdate =
      workbenchDetails.some((details) => details.requiresPortUpdate) ||
      (startupPreferenceDetails.fileExists &&
        startupPreferenceDetails.changed) ||
      (persistentEndpointDetails.fileExists &&
        persistentEndpointDetails.changed) ||
      (entitlementDetails.fileExists && entitlementDetails.changed) ||
      nodeCaDetails.changed

    CursorPatchService.bridgeEndpointStatusCache =
      CursorPatchService.setCachedStatus(cacheKey, result)
    return result
  }

  applyBridgeEndpointPatch(port: number): CursorPatchApplyResult {
    this.invalidateStatusCache()

    const filePaths = getCursorBridgeEndpointWorkbenchPaths()
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
      }
    })
    const startupPreferenceStatus = getCursorStartupPreferencePatchDetails()
    const persistentEndpointStatus =
      getCursorPersistentEndpointPatchDetails(port)
    const entitlementStatus = getCursorEntitlementPatchDetails()
    const nodeCaStatus = getCursorNodeCaPatchDetails()
    if (
      workbenchStatuses.every(({ status }) => status.applied) &&
      (!startupPreferenceStatus.fileExists ||
        startupPreferenceStatus.applied) &&
      (!persistentEndpointStatus.fileExists ||
        persistentEndpointStatus.applied) &&
      (!entitlementStatus.fileExists || entitlementStatus.applied) &&
      nodeCaStatus.applied
    ) {
      return this.finalizePatchApply({ applied: 0, forceChecksum: true })
    }

    let applied = 0
    let restartRequired = false

    for (const workbenchStatus of workbenchStatuses) {
      if (workbenchStatus.status.applied) {
        continue
      }

      const nextContent = patchBridgeEndpointContent(
        workbenchStatus.content,
        port
      )
      if (nextContent === null) {
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

      this.baseline.ensureOriginals([workbenchStatus.path])
      fs.writeFileSync(workbenchStatus.path, nextContent, "utf-8")
      applied += 1
      restartRequired = true
    }

    if (
      startupPreferenceStatus.fileExists &&
      startupPreferenceStatus.canApply &&
      startupPreferenceStatus.sql !== null &&
      startupPreferenceStatus.filePath
    ) {
      const updateResult = runSqlite(
        startupPreferenceStatus.filePath,
        startupPreferenceStatus.sql
      )
      if (!updateResult.success) {
        return {
          success: false,
          applied,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Failed to update Cursor startup preferences: ${updateResult.error}`,
          ],
          restartRequired,
        }
      }
      applied += 1
      restartRequired = true
    } else if (
      startupPreferenceStatus.fileExists &&
      startupPreferenceStatus.error
    ) {
      return {
        success: false,
        applied,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          `Failed to read Cursor startup preferences: ${startupPreferenceStatus.error}`,
        ],
        restartRequired,
      }
    }

    if (
      persistentEndpointStatus.fileExists &&
      persistentEndpointStatus.canApply &&
      persistentEndpointStatus.sql !== null &&
      persistentEndpointStatus.filePath
    ) {
      const updateResult = runSqlite(
        persistentEndpointStatus.filePath,
        persistentEndpointStatus.sql
      )
      if (!updateResult.success) {
        return {
          success: false,
          applied,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Failed to update Cursor endpoint storage: ${updateResult.error}`,
          ],
          restartRequired,
        }
      }
      applied += 1
      restartRequired = true
    } else if (
      persistentEndpointStatus.fileExists &&
      persistentEndpointStatus.error
    ) {
      return {
        success: false,
        applied,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          `Failed to read Cursor endpoint storage: ${persistentEndpointStatus.error}`,
        ],
        restartRequired,
      }
    }

    if (
      entitlementStatus.fileExists &&
      entitlementStatus.canApply &&
      entitlementStatus.sql !== null &&
      entitlementStatus.filePath
    ) {
      const updateResult = runSqlite(
        entitlementStatus.filePath,
        entitlementStatus.sql
      )
      if (!updateResult.success) {
        return {
          success: false,
          applied,
          checksumApplied: false,
          checksumUpdated: 0,
          errors: [
            `Failed to update Cursor entitlement storage: ${updateResult.error}`,
          ],
          restartRequired,
        }
      }
      applied += 1
      restartRequired = true
    } else if (entitlementStatus.fileExists && entitlementStatus.error) {
      return {
        success: false,
        applied,
        checksumApplied: false,
        checksumUpdated: 0,
        errors: [
          `Failed to read Cursor entitlement storage: ${entitlementStatus.error}`,
        ],
        restartRequired,
      }
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
      restartRequired = true
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
        name: CURSOR_ENTITLEMENT_PATCH.name,
        applied: !entitlementDetails.fileExists || entitlementDetails.applied,
      },
      {
        name: IDLE_EXTENSION_HOST_KILLER_PATCH.name,
        applied: content.includes(IDLE_EXTENSION_HOST_KILLER_PATCH.marker),
      },
      ...TRANSPORT_PATCHES.map((p) => ({
        name: p.name,
        applied: content.includes(p.marker),
      })),
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

    for (const patch of TRANSPORT_PATCHES) {
      if (content.includes(patch.marker)) {
        continue // already applied
      }
      if (patch.find.test(content)) {
        content = content.replace(patch.find, patch.replace)
        applied++
        this.logger.info(`Applied patch: ${patch.name}`)
      } else {
        errors.push(`Pattern not found: ${patch.name}`)
      }
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
