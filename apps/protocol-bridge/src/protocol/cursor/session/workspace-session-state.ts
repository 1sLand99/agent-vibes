import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  ParsedWorkspaceDeclaration,
  ParsedWorkspaceFolder,
  WorkspaceDeclarationProvenance,
} from "../tools/workspace-declaration"
import {
  canonicalizeAbsoluteLocalPath,
  WorkspaceScope,
  WorkspaceScopeError,
  type FrozenWorkspaceScopeSnapshot,
} from "./workspace-scope"

/**
 * Non-IDE grants are recorded with their source for administration and
 * persistence. They never grant access on their own: `scope` below is the
 * only executable authority.
 */
export interface WorkspaceGrant {
  readonly path: string
  readonly rawPath: string
  readonly source: "session" | "config"
  readonly addedAt: number
}

/**
 * Human-facing workspace data. It intentionally has no root-resolution API;
 * executable consumers must use `SessionWorkspaceState.scope`.
 */
export interface WorkspacePresentation {
  readonly provenance: WorkspaceDeclarationProvenance
  readonly folders: readonly ParsedWorkspaceFolder[]
}

/**
 * The complete lifecycle-owned workspace state. Scope is immutable and is the
 * sole executable root authority; presentation and grants are validated
 * metadata coupled to that scope.
 */
export interface SessionWorkspaceState {
  readonly scope: WorkspaceScope
  readonly presentation: WorkspacePresentation
  readonly grants: readonly WorkspaceGrant[]
}

/** Exact JSON shape persisted in the current session snapshot. */
export interface PersistedSessionWorkspaceState {
  readonly scope: FrozenWorkspaceScopeSnapshot
  readonly presentation: WorkspacePresentation
  readonly grants: readonly WorkspaceGrant[]
}

export class WorkspaceSessionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceSessionStateError"
  }
}

/** Bind a parsed protocol declaration into lifecycle state with no grants. */
export function createSessionWorkspaceFromDeclaration(
  declaration: ParsedWorkspaceDeclaration
): SessionWorkspaceState {
  return createWorkspaceState({
    scope: declaration.scope,
    presentation: {
      provenance: declaration.provenance,
      folders: declaration.folders,
    },
    grants: [],
  })
}

/**
 * Apply a new protocol declaration while retaining only the supplied grants.
 * This is used by refresh logic after it has decided which grants remain
 * valid; a declaration itself never imports grants from presentation fields.
 */
export function createSessionWorkspaceFromDeclarationWithGrants(
  declaration: ParsedWorkspaceDeclaration,
  grants: readonly WorkspaceGrant[]
): SessionWorkspaceState {
  const scope = createScopeWithGrants(declaration.scope, grants)
  return createWorkspaceState({
    scope,
    presentation: {
      provenance: declaration.provenance,
      folders: declaration.folders,
    },
    grants,
  })
}

/**
 * Replace the session/config grant set and construct a fresh immutable Scope.
 * The declaration's IDE root set and provenance remain unchanged.
 */
export function replaceSessionWorkspaceGrants(
  state: SessionWorkspaceState,
  grants: readonly WorkspaceGrant[]
): SessionWorkspaceState {
  const scope = createScopeWithGrants(state.scope, grants)
  return createWorkspaceState({
    scope,
    presentation: state.presentation,
    grants,
  })
}

/**
 * Validate and apply an entire grant batch against a detached immutable
 * workspace. Relative paths are always anchored to the current primary IDE
 * root; no caller can observe a partially applied batch.
 */
export function addWorkspaceGrants(
  state: SessionWorkspaceState,
  rawPaths: readonly string[],
  source: WorkspaceGrant["source"],
  addedAt: number
): {
  readonly state: SessionWorkspaceState
  readonly grants: readonly WorkspaceGrant[]
} {
  assertGrantTimestamp(addedAt, "workspace grant.addedAt")
  const candidates = resolveWorkspaceGrantBatch(
    state.scope,
    rawPaths,
    "workspace grant paths"
  )
  const nextGrants = [...state.grants]
  const accepted: WorkspaceGrant[] = []

  for (const candidate of candidates) {
    const existingIndex = nextGrants.findIndex(
      (grant) => grant.path === candidate.path
    )
    const existing = existingIndex >= 0 ? nextGrants[existingIndex] : undefined
    if (existing?.source === "config" && source === "session") {
      accepted.push(existing)
      continue
    }
    const grant = Object.freeze({
      path: candidate.path,
      rawPath: candidate.rawPath,
      source,
      addedAt,
    })
    if (existingIndex >= 0) {
      nextGrants.splice(existingIndex, 1, grant)
    } else {
      nextGrants.push(grant)
    }
    accepted.push(grant)
  }

  const next = replaceSessionWorkspaceGrants(state, nextGrants)
  const grants = accepted.map(
    (grant) => next.grants.find((candidate) => candidate.path === grant.path)!
  )
  return Object.freeze({ state: next, grants: Object.freeze(grants) })
}

/**
 * Validate and remove an entire grant batch against detached immutable state.
 * Missing grants are idempotent, but malformed inputs reject the whole batch.
 */
export function removeWorkspaceGrants(
  state: SessionWorkspaceState,
  rawPaths: readonly string[]
): {
  readonly state: SessionWorkspaceState
  readonly removed: readonly WorkspaceGrant[]
} {
  const candidates = resolveWorkspaceGrantBatch(
    state.scope,
    rawPaths,
    "workspace grant paths"
  )
  const removals = new Set(candidates.map((candidate) => candidate.path))
  const removed = state.grants.filter((grant) => removals.has(grant.path))
  if (removed.length === 0) {
    return Object.freeze({ state, removed: Object.freeze([]) })
  }
  return Object.freeze({
    state: replaceSessionWorkspaceGrants(
      state,
      state.grants.filter((grant) => !removals.has(grant.path))
    ),
    removed: Object.freeze(removed.map((grant) => Object.freeze({ ...grant }))),
  })
}

/**
 * Replace exactly the config-source grants. The complete config set is
 * validated before it is applied, so malformed config never creates a
 * partially authorized workspace.
 */
export function replaceConfiguredWorkspaceGrants(
  state: SessionWorkspaceState,
  rawPaths: readonly string[],
  addedAt: number
): SessionWorkspaceState {
  assertGrantTimestamp(addedAt, "configured workspace grant.addedAt")
  const configured: WorkspaceGrant[] = []
  const configuredPaths = new Set<string>()
  const sessionGrants = state.grants.filter(
    (grant) => grant.source === "session"
  )

  for (let index = 0; index < rawPaths.length; index += 1) {
    const rawPath = requireGrantPathText(
      rawPaths[index],
      `additionalWorkingDirectories[${index}]`
    )
    const canonicalPath = resolveWorkspaceGrantPath(state.scope, rawPath)
    if (state.scope.ideRoots.includes(canonicalPath)) {
      throw new WorkspaceSessionStateError(
        `additionalWorkingDirectories[${index}] duplicates an IDE root`
      )
    }
    if (configuredPaths.has(canonicalPath)) {
      throw new WorkspaceSessionStateError(
        `additionalWorkingDirectories[${index}] duplicates a configured root`
      )
    }
    configuredPaths.add(canonicalPath)
    configured.push(
      Object.freeze({
        path: canonicalPath,
        rawPath,
        source: "config" as const,
        addedAt,
      })
    )
  }

  // Project config owns an overlapping path for the current scope. It
  // replaces the session metadata instead of creating duplicate authority.
  const sessionWithoutConfigured = sessionGrants.filter(
    (grant) => !configuredPaths.has(grant.path)
  )
  return replaceSessionWorkspaceGrants(state, [
    ...sessionWithoutConfigured,
    ...configured,
  ])
}

/** Parse the only supported .cursor/agent-vibes.json schema. */
export function parseConfiguredWorkspaceGrantFile(
  value: unknown
): readonly string[] {
  const record = requireExactPlainRecord(
    value,
    ".cursor/agent-vibes.json",
    ["additionalWorkingDirectories"],
    ["additionalWorkingDirectories"]
  )
  const paths = record.additionalWorkingDirectories
  if (paths === undefined) return Object.freeze([])
  if (!isPlainArray(paths)) {
    throw new WorkspaceSessionStateError(
      ".cursor/agent-vibes.json.additionalWorkingDirectories must be an array"
    )
  }
  return Object.freeze(
    paths.map((entry, index) =>
      requireGrantPathText(
        entry,
        `.cursor/agent-vibes.json.additionalWorkingDirectories[${index}]`
      )
    )
  )
}

/** Persist the exact scope snapshot and its presentation provenance. */
export function serializeSessionWorkspace(
  state: SessionWorkspaceState
): PersistedSessionWorkspaceState {
  return Object.freeze({
    scope: state.scope.toFrozenSnapshot(),
    presentation: Object.freeze({
      provenance: state.presentation.provenance,
      folders: Object.freeze(
        state.presentation.folders.map((folder) => Object.freeze({ ...folder }))
      ),
    }),
    grants: Object.freeze(
      state.grants.map((grant) => Object.freeze({ ...grant }))
    ),
  })
}

/** Restore only a complete, exact current persisted workspace shape. */
export function restoreSessionWorkspace(value: unknown): SessionWorkspaceState {
  const record = requireExactPlainRecord(value, "persisted workspace", [
    "scope",
    "presentation",
    "grants",
  ])
  let scope: WorkspaceScope
  try {
    scope = WorkspaceScope.fromFrozenSnapshot(record.scope)
  } catch (error) {
    throw new WorkspaceSessionStateError(
      `persisted workspace.scope is invalid: ${errorMessage(error)}`
    )
  }
  const presentation = parsePersistedPresentation(record.presentation)
  const grants = parsePersistedGrants(record.grants)
  return createWorkspaceState({ scope, presentation, grants })
}

/** Return the immutable root source list for REST diagnostics. */
export function describeWorkspaceRoots(state: SessionWorkspaceState): readonly {
  path: string
  source: "primary" | "ide" | "session_additional" | "config_additional"
}[] {
  return Object.freeze(
    state.scope.roots.map((root) =>
      Object.freeze({ path: root.path, source: root.source })
    )
  )
}

function createScopeWithGrants(
  baseScope: WorkspaceScope,
  grants: readonly WorkspaceGrant[]
): WorkspaceScope {
  const normalizedGrants = normalizeWorkspaceGrants(grants)
  try {
    return WorkspaceScope.create({
      primaryRoot: baseScope.primaryRoot,
      ideRoots: baseScope.ideRoots,
      sessionAdditionalRoots: normalizedGrants
        .filter((grant) => grant.source === "session")
        .map((grant) => grant.path),
      configAdditionalRoots: normalizedGrants
        .filter((grant) => grant.source === "config")
        .map((grant) => grant.path),
    })
  } catch (error) {
    throw new WorkspaceSessionStateError(
      `workspace grants cannot be applied: ${errorMessage(error)}`
    )
  }
}

function createWorkspaceState(input: {
  scope: WorkspaceScope
  presentation: WorkspacePresentation
  grants: readonly WorkspaceGrant[]
}): SessionWorkspaceState {
  const scope = input.scope
  if (!(scope instanceof WorkspaceScope)) {
    throw new WorkspaceSessionStateError(
      "workspace scope must be a WorkspaceScope"
    )
  }
  const grants = normalizeWorkspaceGrants(input.grants)
  assertScopeMatchesGrants(scope, grants)
  const presentation = normalizeWorkspacePresentation(input.presentation, scope)
  return Object.freeze({ scope, presentation, grants })
}

function normalizeWorkspacePresentation(
  value: WorkspacePresentation,
  scope: WorkspaceScope
): WorkspacePresentation {
  if (!value || typeof value !== "object") {
    throw new WorkspaceSessionStateError(
      "workspace presentation must be an object"
    )
  }
  if (!isWorkspaceDeclarationProvenance(value.provenance)) {
    throw new WorkspaceSessionStateError(
      "workspace presentation.provenance is invalid"
    )
  }
  if (!isPlainArray(value.folders)) {
    throw new WorkspaceSessionStateError(
      "workspace presentation.folders must be an array"
    )
  }
  const expectedPaths = [
    scope.primaryRoot,
    ...scope.ideRoots.filter((root) => root !== scope.primaryRoot),
  ]
  if (value.folders.length !== expectedPaths.length) {
    throw new WorkspaceSessionStateError(
      "workspace presentation.folders must exactly represent IDE roots"
    )
  }
  const foldersByPath = new Map<string, ParsedWorkspaceFolder>()
  for (let index = 0; index < value.folders.length; index += 1) {
    const folder = parseWorkspaceFolder(
      value.folders[index],
      `workspace presentation.folders[${index}]`
    )
    if (foldersByPath.has(folder.path)) {
      throw new WorkspaceSessionStateError(
        "workspace presentation.folders must not contain duplicate paths"
      )
    }
    foldersByPath.set(folder.path, folder)
  }
  const folders = expectedPaths.map((expectedPath) => {
    const folder = foldersByPath.get(expectedPath)
    if (!folder) {
      throw new WorkspaceSessionStateError(
        "workspace presentation.folders must not add or omit IDE roots"
      )
    }
    return Object.freeze({
      ...folder,
      uri: pathToFileURL(expectedPath).toString(),
    })
  })
  return Object.freeze({
    provenance: value.provenance,
    folders: Object.freeze(folders),
  })
}

function normalizeWorkspaceGrants(
  value: readonly WorkspaceGrant[]
): readonly WorkspaceGrant[] {
  if (!isPlainArray(value)) {
    throw new WorkspaceSessionStateError("workspace grants must be an array")
  }
  const seen = new Set<string>()
  const grants = value.map((candidate, index) => {
    const grant = parseWorkspaceGrant(candidate, `workspace grants[${index}]`)
    if (seen.has(grant.path)) {
      throw new WorkspaceSessionStateError(
        "workspace grants must not contain duplicate paths"
      )
    }
    seen.add(grant.path)
    return grant
  })
  return Object.freeze(grants)
}

function assertScopeMatchesGrants(
  scope: WorkspaceScope,
  grants: readonly WorkspaceGrant[]
): void {
  const sessionPaths = grants
    .filter((grant) => grant.source === "session")
    .map((grant) => grant.path)
  const configPaths = grants
    .filter((grant) => grant.source === "config")
    .map((grant) => grant.path)
  if (
    !sameOrderedPaths(scope.sessionAdditionalRoots, sessionPaths) ||
    !sameOrderedPaths(scope.configAdditionalRoots, configPaths)
  ) {
    throw new WorkspaceSessionStateError(
      "workspace scope grants must exactly match their metadata"
    )
  }
}

function parsePersistedPresentation(value: unknown): WorkspacePresentation {
  const record = requireExactPlainRecord(
    value,
    "persisted workspace.presentation",
    ["provenance", "folders"]
  )
  if (!isWorkspaceDeclarationProvenance(record.provenance)) {
    throw new WorkspaceSessionStateError(
      "persisted workspace.presentation.provenance is invalid"
    )
  }
  if (!isPlainArray(record.folders)) {
    throw new WorkspaceSessionStateError(
      "persisted workspace.presentation.folders must be an array"
    )
  }
  return {
    provenance: record.provenance,
    folders: record.folders.map((folder, index) =>
      parseWorkspaceFolder(
        folder,
        `persisted workspace.presentation.folders[${index}]`
      )
    ),
  }
}

function parsePersistedGrants(value: unknown): readonly WorkspaceGrant[] {
  if (!isPlainArray(value)) {
    throw new WorkspaceSessionStateError(
      "persisted workspace.grants must be an array"
    )
  }
  return value.map((grant, index) =>
    parseWorkspaceGrant(grant, `persisted workspace.grants[${index}]`)
  )
}

function parseWorkspaceFolder(
  value: unknown,
  label: string
): ParsedWorkspaceFolder {
  const record = requireExactPlainRecord(value, label, ["uri", "path", "name"])
  if (
    typeof record.path !== "string" ||
    typeof record.uri !== "string" ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    record.name.includes("\u0000")
  ) {
    throw new WorkspaceSessionStateError(`${label} is invalid`)
  }
  let canonicalPath: string
  try {
    canonicalPath = canonicalizeAbsoluteLocalPath(record.path, `${label}.path`)
  } catch (error) {
    throw new WorkspaceSessionStateError(
      `${label}.path is invalid: ${errorMessage(error)}`
    )
  }
  if (record.path !== canonicalPath) {
    throw new WorkspaceSessionStateError(`${label}.path must be canonical`)
  }
  if (record.uri !== pathToFileURL(canonicalPath).toString()) {
    throw new WorkspaceSessionStateError(`${label}.uri must match its path`)
  }
  return Object.freeze({
    uri: record.uri,
    path: canonicalPath,
    name: record.name,
  })
}

function parseWorkspaceGrant(value: unknown, label: string): WorkspaceGrant {
  const record = requireExactPlainRecord(value, label, [
    "path",
    "rawPath",
    "source",
    "addedAt",
  ])
  if (typeof record.path !== "string") {
    throw new WorkspaceSessionStateError(`${label}.path must be a string`)
  }
  let canonicalPath: string
  try {
    canonicalPath = canonicalizeAbsoluteLocalPath(record.path, `${label}.path`)
  } catch (error) {
    throw new WorkspaceSessionStateError(
      `${label}.path is invalid: ${errorMessage(error)}`
    )
  }
  if (record.path !== canonicalPath) {
    throw new WorkspaceSessionStateError(`${label}.path must be canonical`)
  }
  if (record.source !== "session" && record.source !== "config") {
    throw new WorkspaceSessionStateError(`${label}.source is invalid`)
  }
  assertGrantTimestamp(record.addedAt, `${label}.addedAt`)
  return Object.freeze({
    path: canonicalPath,
    rawPath: requireGrantPathText(record.rawPath, `${label}.rawPath`),
    source: record.source,
    addedAt: record.addedAt,
  })
}

interface ResolvedWorkspaceGrantCandidate {
  readonly path: string
  readonly rawPath: string
}

function resolveWorkspaceGrantBatch(
  scope: WorkspaceScope,
  rawPaths: readonly string[],
  label: string
): readonly ResolvedWorkspaceGrantCandidate[] {
  if (!isPlainArray(rawPaths) || rawPaths.length === 0) {
    throw new WorkspaceSessionStateError(`${label} must be a non-empty array`)
  }
  const paths = new Set<string>()
  const candidates: ResolvedWorkspaceGrantCandidate[] = []
  for (let index = 0; index < rawPaths.length; index += 1) {
    const rawPath = requireGrantPathText(rawPaths[index], `${label}[${index}]`)
    const canonicalPath = resolveWorkspaceGrantPath(scope, rawPath)
    if (scope.ideRoots.includes(canonicalPath)) {
      throw new WorkspaceSessionStateError(
        `${label}[${index}] must not duplicate an IDE root`
      )
    }
    if (paths.has(canonicalPath)) {
      throw new WorkspaceSessionStateError(
        `${label}[${index}] duplicates another path in the same batch`
      )
    }
    paths.add(canonicalPath)
    candidates.push(Object.freeze({ path: canonicalPath, rawPath }))
  }
  return Object.freeze(candidates)
}

function resolveWorkspaceGrantPath(
  scope: WorkspaceScope,
  rawPath: string
): string {
  const text = requireGrantPathText(rawPath, "workspace grant path")
  const absolutePath =
    text === "~"
      ? os.homedir()
      : text.startsWith("~/") || text.startsWith("~\\")
        ? path.resolve(os.homedir(), text.slice(2))
        : path.isAbsolute(text)
          ? text
          : path.resolve(scope.primaryRoot, text)
  try {
    return canonicalizeAbsoluteLocalPath(absolutePath, "workspace grant path")
  } catch (error) {
    throw new WorkspaceSessionStateError(
      `workspace grant path is invalid: ${errorMessage(error)}`
    )
  }
}

function requireGrantPathText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000")
  ) {
    throw new WorkspaceSessionStateError(`${label} must be a non-empty path`)
  }
  return value
}

function assertGrantTimestamp(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceSessionStateError(
      `${label} must be a non-negative integer`
    )
  }
}

function isWorkspaceDeclarationProvenance(
  value: unknown
): value is WorkspaceDeclarationProvenance {
  return (
    value === "request_context_env.workspace_paths" ||
    value === "request_context_repository_info.workspace_uri_fallback"
  )
}

function isPlainArray(value: unknown): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
      return false
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) return false
  }
  return true
}

function requireExactPlainRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceSessionStateError(`${label} must be a plain object`)
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceSessionStateError(`${label} must be a plain object`)
  }
  const record = value as Record<string, unknown>
  const keys: string[] = []
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") {
      throw new WorkspaceSessionStateError(
        `${label} must not contain symbol properties`
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new WorkspaceSessionStateError(
        `${label} must not contain non-JSON properties`
      )
    }
    keys.push(key)
  }
  const expected = new Set(expectedKeys)
  const optional = new Set(optionalKeys)
  const unsupported = keys.filter((key) => !expected.has(key))
  const missing = expectedKeys.filter(
    (key) =>
      !optional.has(key) && !Object.prototype.hasOwnProperty.call(record, key)
  )
  if (unsupported.length > 0 || missing.length > 0) {
    throw new WorkspaceSessionStateError(
      `${label} has ${[
        ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
        ...(unsupported.length > 0
          ? [`unsupported ${unsupported.join(", ")}`]
          : []),
      ].join("; ")} field(s)`
    )
  }
  return record
}

function sameOrderedPaths(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof WorkspaceScopeError || error instanceof Error) {
    return error.message
  }
  return String(error)
}
