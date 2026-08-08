import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/**
 * A versioned, immutable representation of one workspace authority boundary.
 *
 * Live protocol state is normalized exactly once when a scope is created. The
 * resulting instance and its snapshot are deliberately immutable: callers
 * must create a new scope whenever the IDE workspace or granted additional
 * roots change. That keeps a durable child run from silently inheriting live
 * workspace state after it has been admitted.
 */
export const WORKSPACE_SCOPE_SNAPSHOT_VERSION = 1 as const

const MACOS_PRIVATE_PREFIX = "/private"
const MACOS_PRIVATE_SHORTFORM_ROOTS = ["/var", "/tmp", "/etc"]

export type WorkspaceScopeRootSource =
  | "primary"
  | "ide"
  | "session_additional"
  | "config_additional"

/**
 * The only live input shape accepted by the workspace authority boundary.
 * Every root is a local absolute filesystem path; URI and cwd interpretation
 * belong to the protocol parser, before a WorkspaceScope is constructed.
 */
export interface WorkspaceScopeInput {
  /** The selected root. It must be one of the IDE-provided roots. */
  readonly primaryRoot: string
  /** Complete root set supplied by the IDE. At least one entry is required. */
  readonly ideRoots: readonly string[]
  /** Explicit per-session grants. They can never select the primary root. */
  readonly sessionAdditionalRoots?: readonly string[]
  /** Explicit configuration grants. They can never select the primary root. */
  readonly configAdditionalRoots?: readonly string[]
}

export interface WorkspaceScopeRoot {
  readonly path: string
  readonly source: WorkspaceScopeRootSource
}

/**
 * The result of resolving a model/tool path inside this scope. `relativePath`
 * is always relative to the first granted root that contains the target.
 */
export interface WorkspaceTarget {
  readonly absolutePath: string
  readonly root: WorkspaceScopeRoot
  readonly relativePath: string
}

/**
 * Complete durable scope state. The root-source separation is retained so a
 * recovered scope cannot reinterpret an additional grant as an IDE root.
 */
export interface FrozenWorkspaceScopeSnapshot {
  readonly version: typeof WORKSPACE_SCOPE_SNAPSHOT_VERSION
  /** Stable identity of the canonical IDE root set, excluding grants. */
  readonly workspaceIdentity: string
  /** Exact authority and primary-selection fingerprint for this scope. */
  readonly scopeFingerprint: string
  readonly primaryRoot: string
  /** Exact IDE-provided identity order; it is never presentation-reordered. */
  readonly ideRoots: readonly string[]
  readonly sessionAdditionalRoots: readonly string[]
  readonly configAdditionalRoots: readonly string[]
}

export class WorkspaceScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkspaceScopeError"
  }
}

interface CanonicalWorkspaceScopeInput {
  readonly primaryRoot: string
  readonly ideRoots: readonly string[]
  readonly sessionAdditionalRoots: readonly string[]
  readonly configAdditionalRoots: readonly string[]
}

/**
 * The single authority object for every workspace-bound operation.
 *
 * Root inputs are normalized through the shared realpath/macOS-private-path
 * resolver, but this class never lets that resolver infer a root from the
 * bridge process cwd. Direct containment checks require an absolute local
 * path. `resolveTarget` is the sole relative-path entry point and always
 * anchors that path to `primaryRoot`.
 */
export class WorkspaceScope {
  readonly primaryRoot: string
  /**
   * Presentation-only IDE order with the selected primary root first.
   * `ideRoots` itself remains the immutable IDE identity order.
   */
  readonly primaryFirstIdeRoots: readonly string[]
  readonly ideRoots: readonly string[]
  readonly sessionAdditionalRoots: readonly string[]
  readonly configAdditionalRoots: readonly string[]
  readonly allowedRoots: readonly string[]
  readonly roots: readonly WorkspaceScopeRoot[]
  /** Stable across primary selection and additional-root grants. */
  readonly workspaceIdentity: string
  /** Changes when any executable authority or root ordering changes. */
  readonly scopeFingerprint: string

  private readonly frozenSnapshot: FrozenWorkspaceScopeSnapshot

  private constructor(input: CanonicalWorkspaceScopeInput) {
    this.primaryRoot = input.primaryRoot
    this.ideRoots = freezeArray(input.ideRoots)
    this.sessionAdditionalRoots = freezeArray(input.sessionAdditionalRoots)
    this.configAdditionalRoots = freezeArray(input.configAdditionalRoots)

    this.primaryFirstIdeRoots = freezeArray([
      this.primaryRoot,
      ...this.ideRoots.filter((root) => root !== this.primaryRoot),
    ])
    this.allowedRoots = freezeArray([
      ...this.primaryFirstIdeRoots,
      ...this.sessionAdditionalRoots,
      ...this.configAdditionalRoots,
    ])
    this.roots = freezeArray(
      this.allowedRoots.map((root) =>
        Object.freeze({
          path: root,
          source: this.resolveRootSource(root),
        })
      )
    )
    this.workspaceIdentity = computeWorkspaceIdentity(this.ideRoots)
    this.scopeFingerprint = computeWorkspaceScopeFingerprint({
      primaryRoot: this.primaryRoot,
      ideRoots: this.ideRoots,
      sessionAdditionalRoots: this.sessionAdditionalRoots,
      configAdditionalRoots: this.configAdditionalRoots,
    })
    this.frozenSnapshot = Object.freeze({
      version: WORKSPACE_SCOPE_SNAPSHOT_VERSION,
      workspaceIdentity: this.workspaceIdentity,
      scopeFingerprint: this.scopeFingerprint,
      primaryRoot: this.primaryRoot,
      ideRoots: this.ideRoots,
      sessionAdditionalRoots: this.sessionAdditionalRoots,
      configAdditionalRoots: this.configAdditionalRoots,
    })
    Object.freeze(this)
  }

  /** Normalize a live, explicitly absolute local workspace declaration. */
  static create(input: WorkspaceScopeInput): WorkspaceScope {
    return new WorkspaceScope(normalizeWorkspaceScopeInput(input))
  }

  /**
   * Restore a complete durable scope without accepting old or partial shapes.
   * The snapshot must already contain canonical paths and an exact identity;
   * recovery never silently repairs persisted authority.
   */
  static fromFrozenSnapshot(value: unknown): WorkspaceScope {
    const record = requireExactRecord(value, "workspace scope snapshot", [
      "version",
      "workspaceIdentity",
      "scopeFingerprint",
      "primaryRoot",
      "ideRoots",
      "sessionAdditionalRoots",
      "configAdditionalRoots",
    ])
    if (record.version !== WORKSPACE_SCOPE_SNAPSHOT_VERSION) {
      throw new WorkspaceScopeError(
        "workspace scope snapshot.version must equal 1"
      )
    }
    if (
      typeof record.workspaceIdentity !== "string" ||
      !WORKSPACE_IDENTITY.test(record.workspaceIdentity)
    ) {
      throw new WorkspaceScopeError(
        "workspace scope snapshot.workspaceIdentity must be a sha256 identity"
      )
    }
    if (
      typeof record.scopeFingerprint !== "string" ||
      !WORKSPACE_IDENTITY.test(record.scopeFingerprint)
    ) {
      throw new WorkspaceScopeError(
        "workspace scope snapshot.scopeFingerprint must be a sha256 identity"
      )
    }

    const primaryRoot = assertCanonicalAbsoluteLocalPath(
      record.primaryRoot,
      "workspace scope snapshot.primaryRoot"
    )
    const ideRoots = assertCanonicalAbsoluteLocalPathArray(
      record.ideRoots,
      "workspace scope snapshot.ideRoots"
    )
    const sessionAdditionalRoots = assertCanonicalAbsoluteLocalPathArray(
      record.sessionAdditionalRoots,
      "workspace scope snapshot.sessionAdditionalRoots"
    )
    const configAdditionalRoots = assertCanonicalAbsoluteLocalPathArray(
      record.configAdditionalRoots,
      "workspace scope snapshot.configAdditionalRoots"
    )
    const normalized = assertScopeInvariants({
      primaryRoot,
      ideRoots,
      sessionAdditionalRoots,
      configAdditionalRoots,
    })
    const scope = new WorkspaceScope(normalized)
    if (scope.workspaceIdentity !== record.workspaceIdentity) {
      throw new WorkspaceScopeError(
        "workspace scope snapshot.workspaceIdentity does not match its canonical IDE roots"
      )
    }
    if (scope.scopeFingerprint !== record.scopeFingerprint) {
      throw new WorkspaceScopeError(
        "workspace scope snapshot.scopeFingerprint does not match its canonical authority"
      )
    }
    return scope
  }

  /** Return the exact immutable state required to reconstruct this scope. */
  toFrozenSnapshot(): FrozenWorkspaceScopeSnapshot {
    return this.frozenSnapshot
  }

  /**
   * Test an absolute local path against this scope. Relative candidates are
   * rejected instead of falling back to the bridge cwd.
   */
  contains(candidatePath: string): boolean {
    const canonicalCandidate = canonicalizeAbsoluteLocalPath(
      candidatePath,
      "workspace candidate path"
    )
    return this.roots.some((root) =>
      isCanonicalPathWithinRoot(canonicalCandidate, root.path)
    )
  }

  /**
   * Resolve an absolute or workspace-relative target. Relative values are
   * deliberately anchored to primaryRoot, never process.cwd().
   */
  resolveTarget(targetPath: string): WorkspaceTarget {
    requireLocalPathText(targetPath, "workspace target path")
    const absoluteTarget = path.isAbsolute(targetPath)
      ? targetPath
      : path.resolve(this.primaryRoot, targetPath)
    const canonicalTarget = canonicalizeAbsoluteLocalPath(
      absoluteTarget,
      "workspace target path"
    )
    // Roots may legitimately overlap (for example, an IDE workspace opened
    // beside a parent repository). Absolute targets belong to their most
    // specific declared root; primary-first order is presentation policy, not
    // an ownership shortcut.
    let root: WorkspaceScopeRoot | undefined
    for (const candidate of this.roots) {
      if (!isCanonicalPathWithinRoot(canonicalTarget, candidate.path)) {
        continue
      }
      if (!root || candidate.path.length > root.path.length) {
        root = candidate
      }
    }
    if (!root) {
      throw new WorkspaceScopeError(
        `workspace target path is outside this workspace scope: ${canonicalTarget}`
      )
    }
    return Object.freeze({
      absolutePath: canonicalTarget,
      root,
      relativePath: path.relative(root.path, canonicalTarget),
    })
  }

  /** Iterate roots in primary-first authority order. */
  forEachRoot(visit: (root: WorkspaceScopeRoot, index: number) => void): void {
    for (let index = 0; index < this.roots.length; index += 1) {
      const root = this.roots[index]
      if (root) visit(root, index)
    }
  }

  private resolveRootSource(root: string): WorkspaceScopeRootSource {
    if (root === this.primaryRoot) return "primary"
    if (this.ideRoots.includes(root)) return "ide"
    if (this.sessionAdditionalRoots.includes(root)) {
      return "session_additional"
    }
    return "config_additional"
  }
}

/**
 * Canonicalize a live root or absolute candidate with the shared resolver.
 * This wrapper is intentionally stricter than the lower-level helper: it
 * rejects relative values before that helper can use process.cwd().
 */
export function canonicalizeAbsoluteLocalPath(
  value: string,
  label: string = "workspace path"
): string {
  requireLocalPathText(value, label)
  if (!path.isAbsolute(value)) {
    throw new WorkspaceScopeError(`${label} must be an absolute local path`)
  }
  // `value` is already absolute, so this never consults process.cwd().
  const canonical = normalizeAbsoluteLocalPathForScope(path.resolve(value))
  if (!canonical || !path.isAbsolute(canonical)) {
    throw new WorkspaceScopeError(
      `${label} must resolve to an absolute local path`
    )
  }
  return canonical
}

/**
 * Require that a durable path is already in the canonical form emitted by
 * `canonicalizeAbsoluteLocalPath`; recovery must not repair historical JSON.
 */
export function assertCanonicalAbsoluteLocalPath(
  value: unknown,
  label: string = "workspace path"
): string {
  const rawPath = requireLocalPathText(value, label)
  if (!path.isAbsolute(rawPath)) {
    throw new WorkspaceScopeError(`${label} must be an absolute local path`)
  }
  const canonical = canonicalizeAbsoluteLocalPath(rawPath, label)
  if (rawPath !== canonical) {
    throw new WorkspaceScopeError(
      `${label} must equal its canonical absolute local path`
    )
  }
  return canonical
}

function normalizeWorkspaceScopeInput(
  value: WorkspaceScopeInput
): CanonicalWorkspaceScopeInput {
  const record = requireWorkspaceScopeInput(value)
  const primaryRoot = canonicalizeAbsoluteLocalPath(
    requireLocalPathText(record.primaryRoot, "workspace scope.primaryRoot"),
    "workspace scope.primaryRoot"
  )
  const ideRoots = canonicalizeAbsoluteLocalPathArray(
    record.ideRoots,
    "workspace scope.ideRoots"
  )
  const sessionAdditionalRoots = canonicalizeAbsoluteLocalPathArray(
    record.sessionAdditionalRoots ?? [],
    "workspace scope.sessionAdditionalRoots"
  )
  const configAdditionalRoots = canonicalizeAbsoluteLocalPathArray(
    record.configAdditionalRoots ?? [],
    "workspace scope.configAdditionalRoots"
  )
  return assertScopeInvariants({
    primaryRoot,
    ideRoots,
    sessionAdditionalRoots,
    configAdditionalRoots,
  })
}

function assertScopeInvariants(
  input: CanonicalWorkspaceScopeInput
): CanonicalWorkspaceScopeInput {
  if (input.ideRoots.length === 0) {
    throw new WorkspaceScopeError("workspace scope.ideRoots must not be empty")
  }
  assertNoDuplicates(input.ideRoots, "workspace scope.ideRoots")
  assertNoDuplicates(
    input.sessionAdditionalRoots,
    "workspace scope.sessionAdditionalRoots"
  )
  assertNoDuplicates(
    input.configAdditionalRoots,
    "workspace scope.configAdditionalRoots"
  )
  if (!input.ideRoots.includes(input.primaryRoot)) {
    throw new WorkspaceScopeError(
      "workspace scope.primaryRoot must be one of workspace scope.ideRoots"
    )
  }

  const additionalRoots = [
    ...input.sessionAdditionalRoots,
    ...input.configAdditionalRoots,
  ]
  assertNoDuplicates(additionalRoots, "workspace scope.additionalRoots")
  if (additionalRoots.includes(input.primaryRoot)) {
    throw new WorkspaceScopeError(
      "workspace scope.additionalRoots must not select the primary root"
    )
  }
  for (const root of additionalRoots) {
    if (input.ideRoots.includes(root)) {
      throw new WorkspaceScopeError(
        "workspace scope.additionalRoots must not duplicate an IDE root"
      )
    }
  }
  return {
    primaryRoot: input.primaryRoot,
    ideRoots: freezeArray(input.ideRoots),
    sessionAdditionalRoots: freezeArray(input.sessionAdditionalRoots),
    configAdditionalRoots: freezeArray(input.configAdditionalRoots),
  }
}

function canonicalizeAbsoluteLocalPathArray(
  value: unknown,
  label: string
): readonly string[] {
  return requirePathArray(value, label).map((entry, index) =>
    canonicalizeAbsoluteLocalPath(entry, `${label}[${index}]`)
  )
}

function assertCanonicalAbsoluteLocalPathArray(
  value: unknown,
  label: string
): readonly string[] {
  return requirePathArray(value, label).map((entry, index) =>
    assertCanonicalAbsoluteLocalPath(entry, `${label}[${index}]`)
  )
}

function requireWorkspaceScopeInput(
  value: WorkspaceScopeInput
): Record<string, unknown> {
  return requireExactRecord(
    value,
    "workspace scope",
    [
      "primaryRoot",
      "ideRoots",
      "sessionAdditionalRoots",
      "configAdditionalRoots",
    ],
    ["sessionAdditionalRoots", "configAdditionalRoots"]
  )
}

function requireExactRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceScopeError(`${label} must be a plain object`)
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceScopeError(`${label} must be a plain object`)
  }
  const record = value as Record<string, unknown>
  const keys: string[] = []
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") {
      throw new WorkspaceScopeError(
        `${label} must not contain symbol properties`
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new WorkspaceScopeError(
        `${label} must not contain non-JSON properties`
      )
    }
    keys.push(key)
  }
  const expected = new Set(expectedKeys)
  const unsupported = keys.filter((key) => !expected.has(key))
  const optional = new Set(optionalKeys)
  const missing = expectedKeys.filter(
    (key) =>
      !optional.has(key) && !Object.prototype.hasOwnProperty.call(record, key)
  )
  if (unsupported.length > 0 || missing.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unsupported.length > 0
        ? [`unsupported ${unsupported.join(", ")}`]
        : []),
    ]
    throw new WorkspaceScopeError(`${label} has ${details.join("; ")} field(s)`)
  }
  return record
}

function requirePathArray(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new WorkspaceScopeError(`${label} must be a plain array`)
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new WorkspaceScopeError(`${label} must not contain array holes`)
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) {
      throw new WorkspaceScopeError(
        `${label} must not contain non-index array properties`
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new WorkspaceScopeError(
        `${label} must not contain non-JSON array properties`
      )
    }
  }
  return value.map((entry, index) =>
    requireLocalPathText(entry, `${label}[${index}]`)
  )
}

function requireLocalPathText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\u0000")) {
    throw new WorkspaceScopeError(`${label} must be a non-empty local path`)
  }
  return value
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new WorkspaceScopeError(
      `${label} must not contain duplicate canonical paths`
    )
  }
}

function isCanonicalPathWithinRoot(
  canonicalCandidate: string,
  canonicalRoot: string
): boolean {
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  )
}

/**
 * Resolve a path exactly once at the scope boundary. Existing paths use
 * `realpathSync`; write-new-file paths inherit the canonical form of their
 * nearest existing ancestor before the unresolved suffix is reattached.
 */
function normalizeAbsoluteLocalPathForScope(absolutePath: string): string {
  let resolved = absolutePath
  try {
    resolved = fs.realpathSync(absolutePath)
  } catch {
    const parts = absolutePath.split(path.sep)
    for (let index = parts.length - 1; index > 0; index -= 1) {
      const ancestor = parts.slice(0, index).join(path.sep) || path.sep
      try {
        const canonicalAncestor = fs.realpathSync(ancestor)
        const unresolvedSuffix = parts.slice(index).join(path.sep)
        resolved = unresolvedSuffix
          ? path.join(canonicalAncestor, unresolvedSuffix)
          : canonicalAncestor
        break
      } catch {
        // Continue until an existing ancestor establishes the physical path.
      }
    }
  }
  return stripMacosPrivatePrefix(resolved)
}

function stripMacosPrivatePrefix(absolutePath: string): string {
  if (process.platform !== "darwin") return absolutePath
  if (!absolutePath.startsWith(MACOS_PRIVATE_PREFIX)) return absolutePath
  const suffix = absolutePath.slice(MACOS_PRIVATE_PREFIX.length)
  for (const shortRoot of MACOS_PRIVATE_SHORTFORM_ROOTS) {
    if (suffix === shortRoot || suffix.startsWith(`${shortRoot}/`)) {
      return suffix
    }
  }
  return absolutePath
}

function computeWorkspaceIdentity(ideRoots: readonly string[]): string {
  const canonicalIdentity = JSON.stringify({
    version: WORKSPACE_SCOPE_SNAPSHOT_VERSION,
    // Identity is a root *set*: primary selection, host ordering, and grants
    // are intentionally excluded so a durable grant can bind to one IDE
    // workspace even while the user changes its selected folder.
    ideRoots: [...ideRoots].sort(),
  })
  return `sha256:${createHash("sha256").update(canonicalIdentity).digest("hex")}`
}

function computeWorkspaceScopeFingerprint(
  input: CanonicalWorkspaceScopeInput
): string {
  const canonicalIdentity = JSON.stringify({
    version: WORKSPACE_SCOPE_SNAPSHOT_VERSION,
    workspaceIdentity: computeWorkspaceIdentity(input.ideRoots),
    primaryRoot: input.primaryRoot,
    allowedRoots: [
      input.primaryRoot,
      ...input.ideRoots.filter((root) => root !== input.primaryRoot),
      ...input.sessionAdditionalRoots,
      ...input.configAdditionalRoots,
    ],
    sessionAdditionalRoots: input.sessionAdditionalRoots,
    configAdditionalRoots: input.configAdditionalRoots,
  })
  return `sha256:${createHash("sha256").update(canonicalIdentity).digest("hex")}`
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values])
}

const WORKSPACE_IDENTITY = /^sha256:[a-f0-9]{64}$/
