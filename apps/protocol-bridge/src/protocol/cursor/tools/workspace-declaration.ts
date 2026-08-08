import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  canonicalizeAbsoluteLocalPath,
  WorkspaceScope,
  WorkspaceScopeError,
} from "../session/workspace-scope"
import {
  parseCursorManagedPlanRegistry,
  type CursorManagedReadResource,
  type CursorPlanRegistryInput,
} from "../session/cursor-managed-read-resource"

/**
 * The protocol-owned declaration that established executable workspace authority.
 * `workspace_paths` is the direct Agent v1 declaration. Repository metadata
 * is intentionally a fallback only when that direct declaration is absent.
 */
export type WorkspaceDeclarationProvenance =
  | "request_context_env.workspace_paths"
  | "request_context_repository_info.workspace_uri_fallback"

export interface WorkspaceRepositoryInfo {
  readonly workspaceUri?: string
  readonly repoName?: string
  readonly isLocal?: boolean
}

/** Structural subset of agent.v1.RequestContext used at the authority edge. */
export interface WorkspaceFolderExtractionInput {
  readonly env?: {
    readonly workspacePaths?: readonly string[]
  }
  /**
   * Repository metadata can supply a local URI fallback and display labels.
   * It is never merged with direct `workspacePaths` roots.
   */
  readonly repositoryInfo?: readonly WorkspaceRepositoryInfo[]
  /** Metadata only. Git discovery never grants workspace authority. */
  readonly gitRepos?: ReadonlyArray<{
    readonly path?: string
  }>
}

/** Structural subset of ConversationStateStructure retained for resume only. */
export interface ConversationStateWorkspaceInput extends CursorPlanRegistryInput {
  readonly previousWorkspaceUris?: readonly string[]
}

export interface ParsedWorkspaceFolder {
  /** Canonical local file URI synthesized from the canonical local path. */
  readonly uri: string
  readonly path: string
  readonly name: string
}

/**
 * One accepted, immutable workspace declaration. `scope` is the sole
 * authority object; `folders` exists only to present that scope to current
 * project-context consumers until that presentation field is renamed.
 */
export interface ParsedWorkspaceDeclaration {
  readonly provenance: WorkspaceDeclarationProvenance
  readonly scope: WorkspaceScope
  readonly folders: readonly ParsedWorkspaceFolder[]
}

/**
 * A prior workspace URI is a resume locator, not authority for a new or
 * refreshed session. It must never be converted into a WorkspaceScope.
 */
export interface ParsedResumeWorkspaceReference {
  readonly uri: string
  readonly path: string
}

export interface ParsedCursorWorkspaceState {
  readonly declaration?: ParsedWorkspaceDeclaration
  readonly resumeReferences: readonly ParsedResumeWorkspaceReference[]
  readonly managedReadResources?: readonly CursorManagedReadResource[]
}

/** The presentation derived from a declared WorkspaceScope. */
export interface WorkspaceProjectContextPresentation {
  readonly rootPath: string
  readonly directories: string[]
  readonly files: string[]
  readonly workspaceFolders: Array<{
    uri: string
    path: string
    name: string
  }>
}

interface WorkspaceRootCandidate {
  readonly path: string
}

/**
 * A non-empty protocol workspace source was malformed or internally
 * inconsistent. Callers must reject the frame rather than treating this as an
 * omitted declaration and retaining a prior session scope.
 */
export class WorkspaceDeclarationProtocolError extends Error {
  constructor(message: string) {
    super(`Workspace declaration: ${message}`)
    this.name = "WorkspaceDeclarationProtocolError"
  }
}

/**
 * Parse one direct Agent v1 workspace declaration. Direct roots are accepted
 * only as local absolute filesystem paths. If the field is present but
 * malformed, parsing fails closed and repository metadata is not consulted.
 */
export function parseWorkspaceDeclaration(
  requestContext: WorkspaceFolderExtractionInput | undefined
): ParsedWorkspaceDeclaration | undefined {
  const directRoots = requestContext?.env?.workspacePaths
  if (directRoots !== undefined) {
    if (!Array.isArray(directRoots)) {
      throw new WorkspaceDeclarationProtocolError(
        "request_context_env.workspace_paths must be an array"
      )
    }
    if (directRoots.length > 0) {
      const candidates = directRoots.map((root, index) => ({
        path: requireStrictAbsoluteLocalPath(
          root,
          `request_context_env.workspace_paths[${index}]`
        ),
      }))
      return createWorkspaceDeclaration(
        "request_context_env.workspace_paths",
        candidates,
        collectRepositoryPresentationNames(requestContext?.repositoryInfo)
      )
    }
  }

  const repositories = requestContext?.repositoryInfo
  if (repositories === undefined) return undefined
  if (!isWorkspaceRepositoryInfoArray(repositories)) {
    throw new WorkspaceDeclarationProtocolError(
      "request_context.repository_info must be an array"
    )
  }
  if (repositories.length === 0) return undefined

  const localRepositories = repositories.filter(
    (repository) => repository?.isLocal === true
  )
  if (localRepositories.length === 0) return undefined

  const candidates = localRepositories.map((repository, index) => ({
    path: requireStrictLocalFileUri(
      repository?.workspaceUri,
      `request_context.repository_info.local[${index}].workspace_uri`
    ),
  }))
  return createWorkspaceDeclaration(
    "request_context_repository_info.workspace_uri_fallback",
    candidates,
    collectRepositoryPresentationNames(localRepositories)
  )
}

/**
 * Parse the two workspace-related protocol channels without conflating their
 * meaning. `previousWorkspaceUris` is carried forward solely as a resume
 * reference and never participates in workspace-root selection.
 */
export function parseCursorWorkspaceState(
  requestContext: WorkspaceFolderExtractionInput | undefined,
  conversationState?: ConversationStateWorkspaceInput
): ParsedCursorWorkspaceState {
  const declaration = parseWorkspaceDeclaration(requestContext)
  const resumeReferences = parseResumeWorkspaceReferences(conversationState)
  const managedReadResources = conversationState
    ? parseCursorManagedPlanRegistry(conversationState)
    : undefined
  return Object.freeze({
    ...(declaration ? { declaration } : {}),
    resumeReferences,
    ...(managedReadResources ? { managedReadResources } : {}),
  })
}

/**
 * Parse prior workspace URIs as local resume references. Invalid values are
 * discarded rather than broadened into authority; duplicate references are
 * collapsed by canonical path.
 */
export function parseResumeWorkspaceReferences(
  conversationState?: ConversationStateWorkspaceInput
): readonly ParsedResumeWorkspaceReference[] {
  const rawUris = conversationState?.previousWorkspaceUris
  if (!Array.isArray(rawUris)) return Object.freeze([])

  const references: ParsedResumeWorkspaceReference[] = []
  const seen = new Set<string>()
  for (const rawUri of rawUris) {
    const localPath = parseStrictLocalFileUri(rawUri)
    if (!localPath) continue
    try {
      const canonicalPath = canonicalizeAbsoluteLocalPath(
        localPath,
        "previousWorkspaceUris entry"
      )
      if (seen.has(canonicalPath)) continue
      seen.add(canonicalPath)
      references.push(
        Object.freeze({
          uri: pathToFileURL(canonicalPath).toString(),
          path: canonicalPath,
        })
      )
    } catch {
      // Resume references are non-authoritative and may refer to a path that
      // no longer exists or is no longer locally valid.
    }
  }
  return Object.freeze(references)
}

/**
 * Derive the project-context presentation from a declaration. This is
 * intentionally one-way: the presentation must not be used to reconstruct or
 * expand workspace authority.
 */
export function deriveProjectContextPresentation(
  declaration: ParsedWorkspaceDeclaration
): WorkspaceProjectContextPresentation {
  const workspaceFolders = declaration.folders.map((folder) => ({ ...folder }))
  return {
    rootPath: declaration.scope.primaryRoot,
    directories: workspaceFolders.map((folder) => folder.path),
    files: [],
    workspaceFolders,
  }
}

function createWorkspaceDeclaration(
  provenance: WorkspaceDeclarationProvenance,
  candidates: readonly WorkspaceRootCandidate[],
  presentationNames: ReadonlyMap<string, string>
): ParsedWorkspaceDeclaration {
  if (candidates.length === 0) {
    throw new WorkspaceDeclarationProtocolError(
      `${provenance} must contain at least one root`
    )
  }
  try {
    const scope = WorkspaceScope.create({
      primaryRoot: candidates[0]!.path,
      ideRoots: candidates.map((candidate) => candidate.path),
    })
    const folders = scope.allowedRoots.map((canonicalPath) =>
      Object.freeze({
        uri: pathToFileURL(canonicalPath).toString(),
        path: canonicalPath,
        name: presentationNames.get(canonicalPath) || basename(canonicalPath),
      })
    )
    return Object.freeze({
      provenance,
      scope,
      folders: Object.freeze(folders),
    })
  } catch (error) {
    if (error instanceof WorkspaceScopeError) {
      throw new WorkspaceDeclarationProtocolError(
        `${provenance} is invalid: ${error.message}`
      )
    }
    throw error
  }
}

function collectRepositoryPresentationNames(
  repositories: WorkspaceFolderExtractionInput["repositoryInfo"]
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  if (!isWorkspaceRepositoryInfoArray(repositories)) return names
  for (const repository of repositories) {
    if (repository?.isLocal !== true) continue
    const localPath = parseStrictLocalFileUri(repository?.workspaceUri)
    if (!localPath) continue
    try {
      const canonicalPath = canonicalizeAbsoluteLocalPath(
        localPath,
        "repositoryInfo workspaceUri"
      )
      const name = repository?.repoName?.trim()
      if (name && !names.has(canonicalPath)) {
        names.set(canonicalPath, name)
      }
    } catch {
      // Presentation metadata never changes root authority.
    }
  }
  return names
}

function isStrictAbsoluteLocalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    path.isAbsolute(value)
  )
}

function isWorkspaceRepositoryInfoArray(
  value: unknown
): value is readonly WorkspaceRepositoryInfo[] {
  return Array.isArray(value)
}

function requireStrictAbsoluteLocalPath(value: unknown, label: string): string {
  if (!isStrictAbsoluteLocalPath(value)) {
    throw new WorkspaceDeclarationProtocolError(
      `${label} must be a local absolute path`
    )
  }
  return value
}

function requireStrictLocalFileUri(value: unknown, label: string): string {
  const localPath = parseStrictLocalFileUri(value)
  if (!localPath) {
    throw new WorkspaceDeclarationProtocolError(
      `${label} must be a local file URI with an absolute path`
    )
  }
  return localPath
}

/** Accept only canonical local-file URI syntax, never URI-like fallbacks. */
function parseStrictLocalFileUri(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.startsWith("file:///")
  ) {
    return undefined
  }
  try {
    const url = new URL(value)
    if (url.protocol !== "file:" || url.hostname !== "") return undefined
    const localPath = fileURLToPath(url)
    if (!isStrictAbsoluteLocalPath(localPath)) return undefined
    return pathToFileURL(localPath).toString() === value ? localPath : undefined
  } catch {
    return undefined
  }
}

function basename(absolutePath: string): string {
  const name = path.basename(absolutePath)
  return name || absolutePath
}
