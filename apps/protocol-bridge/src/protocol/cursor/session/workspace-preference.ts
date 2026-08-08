import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { requireExactDurableIdentifier } from "../../../context/durable-identifier"
import type { ParsedCursorRequest } from "../tools/cursor-request-parser"
import {
  deriveProjectContextPresentation,
  type ParsedWorkspaceDeclaration,
} from "../tools/workspace-declaration"
import {
  canonicalizeAbsoluteLocalPath,
  WorkspaceScope,
} from "./workspace-scope"
import {
  ConversationId,
  type ConversationId as ConversationIdType,
} from "../turn/turn.types"

/**
 * Promote one existing IDE root to primary while preserving the exact same
 * WorkspaceScope root set and grants. Presentation is derived only after the
 * new scope is built, so projectContext can never introduce an authority.
 *
 * Returns null unless the preferred root belongs to the current declaration's
 * IDE root set. In particular, additional grants cannot become primary.
 */
export function promoteWorkspacePrimary(
  declaration: ParsedWorkspaceDeclaration,
  preferredRoot: string
): ParsedWorkspaceDeclaration | null {
  let canonicalPreferred: string
  try {
    canonicalPreferred = canonicalizeAbsoluteLocalPath(
      preferredRoot,
      "workspace preference folderPath"
    )
  } catch {
    return null
  }
  if (!declaration.scope.ideRoots.includes(canonicalPreferred)) return null

  const orderedIdeRoots = [
    canonicalPreferred,
    ...declaration.scope.ideRoots.filter((root) => root !== canonicalPreferred),
  ]
  const foldersByPath = new Map(
    declaration.folders.map((folder) => [folder.path, folder])
  )
  const promotedFolders = orderedIdeRoots.map((root) => foldersByPath.get(root))
  if (promotedFolders.some((folder) => !folder)) return null

  try {
    const scope = WorkspaceScope.create({
      primaryRoot: canonicalPreferred,
      ideRoots: declaration.scope.ideRoots,
      sessionAdditionalRoots: declaration.scope.sessionAdditionalRoots,
      configAdditionalRoots: declaration.scope.configAdditionalRoots,
    })
    return Object.freeze({
      provenance: declaration.provenance,
      scope,
      folders: Object.freeze(
        promotedFolders.map((folder) => Object.freeze({ ...folder! }))
      ),
    })
  } catch {
    return null
  }
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
  composerId: ConversationIdType
  workspaceKey: string
  folderUri: string
  folderPath: string
  updatedAt: number
}

export interface WorkspacePreferenceRepository {
  get(composerId: ConversationIdType): WorkspacePreferenceRecord | undefined
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
    const uri = folder.uri
    const folderPath = folder.path
    // `name` is the IDE's folder presentation, which is normally derived
    // from the filesystem basename. A basename may legally begin or end with
    // a space, so it must stay byte-for-byte aligned with its path/URI rather
    // than being treated like free-form display text.
    const name = folder.name
    if (!uri || !folderPath || !name || name.includes("\u0000")) return null
    let path: string
    try {
      path = canonicalizeAbsoluteLocalPath(
        folderPath,
        "workspace registration folder path"
      )
    } catch {
      return null
    }
    if (folderPath !== path || uri !== pathToFileURL(path).toString()) {
      return null
    }
    // A registration is a protocol declaration, not a best-effort list of
    // display rows. Collapsing duplicate folders would silently change the
    // sender's workspace topology and selection semantics.
    if (seenUris.has(uri)) return null
    seenUris.add(uri)
    normalized.push({ uri, path, name })
  }

  return normalized
}

function requireWorkspacePreferenceRecord(
  preference: WorkspacePreferenceRecord,
  expectedComposerId: ConversationIdType
): WorkspacePreferenceRecord {
  const composerId = ConversationId.of(preference.composerId)
  if (composerId !== expectedComposerId) {
    throw new Error(
      `Workspace preference row identity mismatch: expected ${expectedComposerId}, got ${composerId}`
    )
  }
  return {
    ...preference,
    composerId,
    workspaceKey: requireExactDurableIdentifier(
      preference.workspaceKey,
      "workspace preference workspaceKey"
    ),
  }
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
    let token: string
    let instanceId: string
    let workspaceKey: string
    try {
      token = requireExactDurableIdentifier(
        controlToken,
        "workspace registration control token"
      )
      instanceId = requireExactDurableIdentifier(
        input.instanceId,
        "workspace registration instanceId"
      )
      workspaceKey = requireExactDurableIdentifier(
        input.workspaceKey,
        "workspace registration workspaceKey"
      )
    } catch {
      return false
    }
    const folders = normalizeRegistrationFolders(input.folders)
    if (!folders) return false

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
    let token: string
    let exactInstanceId: string
    try {
      token = requireExactDurableIdentifier(
        controlToken,
        "workspace removal control token"
      )
      exactInstanceId = requireExactDurableIdentifier(
        instanceId,
        "workspace removal instanceId"
      )
    } catch {
      return false
    }
    const registration = this.registrations.get(exactInstanceId)
    if (!registration) return true
    if (registration.tokenHash !== hashControlToken(token)) {
      return false
    }
    this.registrations.delete(exactInstanceId)
    return true
  }

  getPickerState(
    controlToken: string,
    composerId: string
  ): WorkspacePickerState {
    let token: string
    let exactComposerId: ConversationIdType
    try {
      token = requireExactDurableIdentifier(
        controlToken,
        "workspace picker control token"
      )
      exactComposerId = ConversationId.of(composerId)
    } catch {
      return { kind: "unavailable", selectedFolderUri: undefined }
    }
    const storedPreference = this.repository.get(exactComposerId)
    const preference = storedPreference
      ? requireWorkspacePreferenceRecord(storedPreference, exactComposerId)
      : undefined
    const registrations = this.getActiveRegistrations(token)
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
    let token: string
    let composerId: ConversationIdType
    let workspaceKey: string
    try {
      token = requireExactDurableIdentifier(
        controlToken,
        "workspace selection control token"
      )
      composerId = ConversationId.of(input.composerId)
      workspaceKey = requireExactDurableIdentifier(
        input.workspaceKey,
        "workspace selection workspaceKey"
      )
    } catch {
      return false
    }
    const registration = this.getActiveRegistrations(token)
      .filter((candidate) => candidate.workspaceKey === workspaceKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!registration) return false

    const folder = registration.folders.find(
      (candidate) => candidate.uri === input.folderUri
    )
    if (!folder) return false

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

  applyToRequest<
    T extends Pick<
      ParsedCursorRequest,
      "workspaceDeclaration" | "projectContext"
    >,
  >(conversationId: ConversationIdType, request: T): T {
    const exactConversationId = ConversationId.of(conversationId)
    const storedPreference = this.repository.get(exactConversationId)
    const preference = storedPreference
      ? requireWorkspacePreferenceRecord(storedPreference, exactConversationId)
      : undefined
    if (!preference || !request.workspaceDeclaration) return request

    const promoted = promoteWorkspacePrimary(
      request.workspaceDeclaration,
      preference.folderPath
    )
    if (!promoted) return request
    return {
      ...request,
      workspaceDeclaration: promoted,
      projectContext: deriveProjectContextPresentation(promoted),
    }
  }

  private getActiveRegistrations(
    exactControlToken: string
  ): WorkspaceRegistration[] {
    const now = this.now()
    const tokenHash = hashControlToken(exactControlToken)
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
