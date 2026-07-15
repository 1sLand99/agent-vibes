import { createHash } from "node:crypto"
import type { ParsedCursorRequest } from "../tools/cursor-request-parser"
import { normalizePathForBoundaryCheck } from "./workspace-root-resolver"

type ProjectContext = NonNullable<ParsedCursorRequest["projectContext"]>

/**
 * Promote one IDE workspace folder to the primary project root while
 * preserving the complete multi-root workspace set.
 *
 * Returns null when the requested root is not present in the IDE-provided
 * workspace folder list. Callers must never turn an arbitrary path into a
 * workspace root through this helper.
 */
export function promoteWorkspaceRoot(
  projectContext: ProjectContext,
  preferredRoot: string
): ProjectContext | null {
  const normalizedPreferred = normalizePathForBoundaryCheck(preferredRoot)
  if (!normalizedPreferred) return null

  const workspaceFolders = projectContext.workspaceFolders || []
  if (workspaceFolders.length === 0) {
    return normalizePathForBoundaryCheck(projectContext.rootPath) ===
      normalizedPreferred
      ? projectContext
      : null
  }

  const preferredIndex = workspaceFolders.findIndex(
    (folder) =>
      normalizePathForBoundaryCheck(folder.path) === normalizedPreferred
  )
  if (preferredIndex < 0) return null

  const preferredFolder = workspaceFolders[preferredIndex]!
  const promotedFolders = [
    preferredFolder,
    ...workspaceFolders.filter((_, index) => index !== preferredIndex),
  ]

  const promotedContext = {
    ...projectContext,
    rootPath: preferredFolder.path,
    directories: promotedFolders.map((folder) => folder.path),
    workspaceFolders: promotedFolders,
  }
  return promotedContext
}

export interface RegisteredWorkspaceFolder {
  uri: string
  path: string
  name: string
}

export interface WorkspaceRegistrationInput {
  instanceId: string
  workspaceKey: string
  folders: RegisteredWorkspaceFolder[]
}

export interface WorkspaceSelectionInput {
  composerId: string
  workspaceKey: string
  folderUri: string
}

export interface WorkspacePreferenceRecord {
  composerId: string
  workspaceKey: string
  folderUri: string
  folderPath: string
  updatedAt: number
}

export interface WorkspacePreferenceRepository {
  get(composerId: string): WorkspacePreferenceRecord | undefined
  upsert(record: WorkspacePreferenceRecord): void
}

export type WorkspacePickerState =
  | {
      kind: "ready"
      workspaceKey: string
      folders: RegisteredWorkspaceFolder[]
      selectedFolderUri: string | undefined
      selectedFolderAvailable: boolean
    }
  | {
      kind: "ambiguous" | "unavailable"
      selectedFolderUri: string | undefined
    }

type WorkspaceRegistration = WorkspaceRegistrationInput & {
  tokenHash: string
  expiresAt: number
  updatedAt: number
}

export interface WorkspacePreferenceRegistryOptions {
  now?: () => number
  registrationTtlMs?: number
}

const DEFAULT_REGISTRATION_TTL_MS = 60_000

function hashControlToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function normalizeRegistrationFolders(
  folders: RegisteredWorkspaceFolder[]
): RegisteredWorkspaceFolder[] | null {
  const normalized: RegisteredWorkspaceFolder[] = []
  const seenUris = new Set<string>()

  for (const folder of folders) {
    const uri = folder.uri.trim()
    const path = folder.path.trim()
    const name = folder.name.trim()
    if (!uri || !path || !name) return null
    if (seenUris.has(uri)) continue
    seenUris.add(uri)
    normalized.push({ uri, path, name })
  }

  return normalized
}

export class WorkspacePreferenceRegistry {
  private readonly registrations = new Map<string, WorkspaceRegistration>()
  private readonly now: () => number
  private readonly registrationTtlMs: number

  constructor(
    private readonly repository: WorkspacePreferenceRepository,
    options: WorkspacePreferenceRegistryOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.registrationTtlMs =
      options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS
  }

  synchronizeWorkspace(
    controlToken: string,
    input: WorkspaceRegistrationInput
  ): boolean {
    const token = controlToken.trim()
    const instanceId = input.instanceId.trim()
    const workspaceKey = input.workspaceKey.trim()
    const folders = normalizeRegistrationFolders(input.folders)
    if (!token || !instanceId || !workspaceKey || !folders) return false

    const tokenHash = hashControlToken(token)
    const existing = this.registrations.get(instanceId)
    if (existing && existing.tokenHash !== tokenHash) return false

    const updatedAt = this.now()
    this.registrations.set(instanceId, {
      instanceId,
      workspaceKey,
      folders,
      tokenHash,
      updatedAt,
      expiresAt: updatedAt + this.registrationTtlMs,
    })
    return true
  }

  removeWorkspace(controlToken: string, instanceId: string): boolean {
    const registration = this.registrations.get(instanceId)
    if (!registration) return true
    if (registration.tokenHash !== hashControlToken(controlToken.trim())) {
      return false
    }
    this.registrations.delete(instanceId)
    return true
  }

  getPickerState(
    controlToken: string,
    composerId: string
  ): WorkspacePickerState {
    const preference = this.repository.get(composerId)
    const registrations = this.getActiveRegistrations(controlToken)
    const workspaceKeys = new Set(
      registrations.map((registration) => registration.workspaceKey)
    )

    let workspaceKey = preference?.workspaceKey
    if (!workspaceKey) {
      if (workspaceKeys.size === 0) {
        return { kind: "unavailable", selectedFolderUri: undefined }
      }
      if (workspaceKeys.size > 1) {
        return { kind: "ambiguous", selectedFolderUri: undefined }
      }
      workspaceKey = registrations[0]!.workspaceKey
    }

    const registration = registrations
      .filter((candidate) => candidate.workspaceKey === workspaceKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!registration) {
      return {
        kind: "unavailable",
        selectedFolderUri: preference?.folderUri,
      }
    }

    return {
      kind: "ready",
      workspaceKey,
      folders: registration.folders.map((folder) => ({ ...folder })),
      selectedFolderUri: preference?.folderUri,
      selectedFolderAvailable: preference
        ? registration.folders.some(
            (folder) => folder.uri === preference.folderUri
          )
        : true,
    }
  }

  selectWorkspace(
    controlToken: string,
    input: WorkspaceSelectionInput
  ): boolean {
    const registration = this.getActiveRegistrations(controlToken)
      .filter((candidate) => candidate.workspaceKey === input.workspaceKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!registration) return false

    const folder = registration.folders.find(
      (candidate) => candidate.uri === input.folderUri
    )
    if (!folder) return false

    const composerId = input.composerId.trim()
    if (!composerId) return false
    this.repository.upsert({
      composerId,
      workspaceKey: registration.workspaceKey,
      folderUri: folder.uri,
      folderPath: folder.path,
      updatedAt: this.now(),
    })
    return true
  }

  /**
   * Resolve the workspace folder that a composer's chat is currently scoped
   * to, applying the same selection rules the project picker renders with:
   * the stored preference when its folder is still registered, otherwise the
   * primary registered folder. Returns null when no project can be resolved.
   */
  resolveSelectedFolder(
    controlToken: string,
    composerId: string
  ): RegisteredWorkspaceFolder | null {
    const state = this.getPickerState(controlToken, composerId)
    if (state.kind !== "ready" || state.folders.length === 0) return null

    const selected =
      state.selectedFolderAvailable && state.selectedFolderUri
        ? state.folders.find((folder) => folder.uri === state.selectedFolderUri)
        : undefined
    return selected ?? state.folders[0]!
  }

  applyToRequest<T extends Pick<ParsedCursorRequest, "projectContext">>(
    conversationId: string,
    request: T
  ): T {
    const preference = this.repository.get(conversationId)
    if (!preference || !request.projectContext) return request

    const promoted = promoteWorkspaceRoot(
      request.projectContext,
      preference.folderPath
    )
    if (!promoted) return request
    return { ...request, projectContext: promoted }
  }

  private getActiveRegistrations(
    controlToken: string
  ): WorkspaceRegistration[] {
    const now = this.now()
    const tokenHash = hashControlToken(controlToken.trim())
    const registrations: WorkspaceRegistration[] = []

    for (const [instanceId, registration] of this.registrations) {
      if (registration.expiresAt <= now) {
        this.registrations.delete(instanceId)
        continue
      }
      if (registration.tokenHash === tokenHash) {
        registrations.push(registration)
      }
    }

    return registrations
  }
}
