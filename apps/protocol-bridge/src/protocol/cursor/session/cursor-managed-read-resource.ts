import { fileURLToPath } from "node:url"

import type { CursorRule, SkillOptions } from "../../../gen/agent/v1_pb"
import { findCursorSkillForInternalPath } from "../skills/policy"
import {
  assertCanonicalAbsoluteLocalPath,
  canonicalizeAbsoluteLocalPath,
  type WorkspaceScope,
  WorkspaceScopeError,
} from "./workspace-scope"

export const CURSOR_MANAGED_READ_RESOURCE_VERSION = 1 as const

export type CursorManagedReadResourceSource =
  | "conversation_plan_registry"
  | "create_plan_result"

/** One exact, read-only file capability established by Cursor protocol state. */
export interface CursorManagedReadResource {
  readonly version: typeof CURSOR_MANAGED_READ_RESOURCE_VERSION
  readonly kind: "plan"
  readonly id: string
  readonly path: string
  readonly source: CursorManagedReadResourceSource
}

export interface CursorPlanRegistryInput {
  readonly plans?: Readonly<
    Record<
      string,
      {
        readonly id?: string
        readonly path?: string
      }
    >
  >
}

export class CursorManagedReadResourceError extends Error {
  constructor(message: string) {
    super(`Cursor managed read resource: ${message}`)
    this.name = "CursorManagedReadResourceError"
  }
}

/**
 * Convert the authoritative ConversationStateStructure plan registry into
 * exact file capabilities. The registry grants no parent-directory access.
 */
export function parseCursorManagedPlanRegistry(
  conversationState: CursorPlanRegistryInput
): readonly CursorManagedReadResource[] {
  const plans = conversationState.plans
  if (plans === undefined) return Object.freeze([])
  if (!isPlainRecord(plans)) {
    throw new CursorManagedReadResourceError(
      "conversation_state.plans must be a map"
    )
  }

  const resources: CursorManagedReadResource[] = []
  for (const [registryId, rawEntry] of Object.entries(plans)) {
    if (!isPlainRecord(rawEntry)) {
      throw new CursorManagedReadResourceError(
        `conversation_state.plans[${JSON.stringify(registryId)}] must be an object`
      )
    }
    requireIdentifier(registryId, "conversation_state.plans map key")
    const entryId = requireIdentifier(
      rawEntry.id,
      `conversation_state.plans[${JSON.stringify(registryId)}].id`
    )
    resources.push(
      createCursorManagedPlanReadResource({
        id: entryId,
        path: rawEntry.path,
        source: "conversation_plan_registry",
      })
    )
  }
  return freezeResources(resources)
}

export function createCursorManagedPlanReadResource(input: {
  readonly id: unknown
  readonly path: unknown
  readonly source: CursorManagedReadResourceSource
}): CursorManagedReadResource {
  return Object.freeze({
    version: CURSOR_MANAGED_READ_RESOURCE_VERSION,
    kind: "plan" as const,
    id: requireIdentifier(input.id, "plan id"),
    path: canonicalizeManagedFilePath(input.path, "plan path"),
    source: requireSource(input.source, "plan source"),
  })
}

export function upsertCursorManagedPlanReadResource(
  current: readonly CursorManagedReadResource[],
  input: { readonly id: unknown; readonly path: unknown }
): {
  readonly resources: readonly CursorManagedReadResource[]
  readonly resource: CursorManagedReadResource
} {
  const resource = createCursorManagedPlanReadResource({
    ...input,
    source: "create_plan_result",
  })
  const resources = current.filter(
    (candidate) =>
      candidate.id !== resource.id && candidate.path !== resource.path
  )
  return Object.freeze({
    resources: freezeResources([...resources, resource]),
    resource,
  })
}

/**
 * Reconcile one authoritative ConversationState plan registry without
 * revoking capabilities established by accepted CreatePlanResult records.
 * Registry authority is source-scoped: an empty registry removes only prior
 * registry entries. Tool-result capabilities remain owned by their durable
 * graph result for the lifetime of the conversation.
 */
export function reconcileCursorManagedPlanRegistry(
  current: readonly CursorManagedReadResource[],
  registry: readonly CursorManagedReadResource[]
): readonly CursorManagedReadResource[] {
  const durableToolResults = current.filter(
    (resource) => resource.source === "create_plan_result"
  )
  const nextRegistry = registry.filter(
    (resource) => resource.source === "conversation_plan_registry"
  )
  if (nextRegistry.length !== registry.length) {
    throw new CursorManagedReadResourceError(
      "plan registry refresh contains a non-registry capability source"
    )
  }
  const toolResultIds = new Set(
    durableToolResults.map((resource) => resource.id)
  )
  const toolResultPaths = new Set(
    durableToolResults.map((resource) => resource.path)
  )
  return freezeResources([
    ...nextRegistry.filter(
      (resource) =>
        !toolResultIds.has(resource.id) && !toolResultPaths.has(resource.path)
    ),
    ...durableToolResults,
  ])
}

export function serializeCursorManagedReadResources(
  resources: readonly CursorManagedReadResource[]
): CursorManagedReadResource[] {
  return resources.map((resource) => ({ ...resource }))
}

export function restoreCursorManagedReadResources(
  value: unknown,
  label: string
): readonly CursorManagedReadResource[] {
  if (!Array.isArray(value)) {
    throw new CursorManagedReadResourceError(`${label} must be an array`)
  }
  const resources = value.map((raw, index) => {
    if (!isPlainRecord(raw)) {
      throw new CursorManagedReadResourceError(
        `${label}[${index}] must be an object`
      )
    }
    assertExactKeys(
      raw,
      ["version", "kind", "id", "path", "source"],
      `${label}[${index}]`
    )
    if (raw.version !== CURSOR_MANAGED_READ_RESOURCE_VERSION) {
      throw new CursorManagedReadResourceError(
        `${label}[${index}].version is unsupported`
      )
    }
    if (raw.kind !== "plan") {
      throw new CursorManagedReadResourceError(
        `${label}[${index}].kind must be plan`
      )
    }
    return createCursorManagedPlanReadResource({
      id: raw.id,
      path: requireCanonicalManagedFilePath(
        raw.path,
        `${label}[${index}].path`
      ),
      source: requireSource(raw.source, `${label}[${index}].source`),
    })
  })
  return freezeResources(resources)
}

function requireCanonicalManagedFilePath(
  value: unknown,
  label: string
): string {
  try {
    return assertCanonicalAbsoluteLocalPath(value, label)
  } catch (error) {
    throw new CursorManagedReadResourceError(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Resolve a read path through workspace authority, an exact Cursor-managed
 * file (plans), an exact bridge archive file (tool-result spill), or a
 * skill-owned internal tree discovered from session skill metadata.
 *
 * Skill ownership here only unlocks read/list/search admission. Inactive
 * skills are still blocked later by `CursorSkillsManager.guardToolAccess`.
 * Write tools must not call this helper.
 */
export function resolveCursorSessionReadablePath(input: {
  readonly workspaceScope?: WorkspaceScope
  readonly managedResources: readonly CursorManagedReadResource[]
  readonly skillAuthority?: {
    readonly rules?: readonly CursorRule[]
    readonly skillOptions?: SkillOptions
  }
  readonly exactExtraReadablePaths?: readonly string[]
  readonly path: string
}): string {
  let workspaceFailure: unknown
  if (input.workspaceScope) {
    try {
      return input.workspaceScope.resolveTarget(input.path).absolutePath
    } catch (error) {
      workspaceFailure = error
    }
  }

  let managedPath: string
  try {
    managedPath = canonicalizeManagedFilePath(input.path, "read path")
  } catch {
    throwWorkspaceReadFailure(workspaceFailure, input.workspaceScope)
  }
  const match = input.managedResources.find(
    (resource) => resource.path === managedPath
  )
  if (match) return match.path

  for (const rawExtra of input.exactExtraReadablePaths || []) {
    try {
      if (
        canonicalizeManagedFilePath(rawExtra, "archive path") === managedPath
      ) {
        return managedPath
      }
    } catch {
      // Ignore malformed archive grants; they never widen authority.
    }
  }

  if (
    input.skillAuthority &&
    findCursorSkillForInternalPath(
      input.skillAuthority.rules,
      managedPath,
      input.skillAuthority.skillOptions
    )
  ) {
    return managedPath
  }

  throwWorkspaceReadFailure(workspaceFailure, input.workspaceScope)
}

function throwWorkspaceReadFailure(
  workspaceFailure: unknown,
  workspaceScope: WorkspaceScope | undefined
): never {
  const workspaceReason =
    workspaceFailure instanceof WorkspaceScopeError
      ? workspaceFailure.message
      : workspaceScope
        ? "path is outside the declared session workspace scope"
        : "no declared session workspace scope"
  throw new CursorManagedReadResourceError(
    `${workspaceReason}; path is not an exact Cursor-managed readable file`
  )
}

function canonicalizeManagedFilePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new CursorManagedReadResourceError(
      `${label} must be a non-empty local absolute path or file URI`
    )
  }
  let localPath = value
  if (value.startsWith("file:")) {
    try {
      localPath = fileURLToPath(value)
    } catch {
      throw new CursorManagedReadResourceError(
        `${label} must be a valid local file URI`
      )
    }
  }
  try {
    return canonicalizeAbsoluteLocalPath(localPath, label)
  } catch (error) {
    throw new CursorManagedReadResourceError(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new CursorManagedReadResourceError(
      `${label} must be a non-empty string without NUL bytes`
    )
  }
  return value.trim()
}

function requireSource(
  value: unknown,
  label: string
): CursorManagedReadResourceSource {
  if (
    value !== "conversation_plan_registry" &&
    value !== "create_plan_result"
  ) {
    throw new CursorManagedReadResourceError(`${label} is unsupported`)
  }
  return value
}

function freezeResources(
  resources: readonly CursorManagedReadResource[]
): readonly CursorManagedReadResource[] {
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  for (const resource of resources) {
    if (seenIds.has(resource.id)) {
      throw new CursorManagedReadResourceError(
        `duplicate plan id ${JSON.stringify(resource.id)}`
      )
    }
    if (seenPaths.has(resource.path)) {
      throw new CursorManagedReadResourceError(
        `duplicate plan path ${JSON.stringify(resource.path)}`
      )
    }
    seenIds.add(resource.id)
    seenPaths.add(resource.path)
  }
  return Object.freeze(
    resources.map((resource) => Object.freeze({ ...resource }))
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new CursorManagedReadResourceError(
      `${label} must contain exactly ${canonicalExpected.join(", ")}`
    )
  }
}
