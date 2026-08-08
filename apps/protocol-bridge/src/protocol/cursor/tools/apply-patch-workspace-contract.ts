import type { WorkspaceTarget } from "../session/workspace-scope"
import { WorkspaceScope, WorkspaceScopeError } from "../session/workspace-scope"

const BEGIN_PATCH_MARKER = "*** Begin Patch"
const END_PATCH_MARKER = "*** End Patch"
const ENVIRONMENT_ID_MARKER = "*** Environment ID:"
const ADD_FILE_MARKER = "*** Add File: "
const DELETE_FILE_MARKER = "*** Delete File: "
const UPDATE_FILE_MARKER = "*** Update File: "
const MOVE_TO_MARKER = "*** Move to: "

export type ApplyPatchWorkspaceOperation = "add" | "delete" | "update" | "move"

export interface ApplyPatchWorkspaceTarget {
  readonly operation: ApplyPatchWorkspaceOperation
  readonly declaredPath: string
  readonly target: WorkspaceTarget
}

export interface ApplyPatchWorkspaceContract {
  /** Canonical patch body whose mutation headers name admitted absolute paths. */
  readonly executionPatch: string
  readonly cwd: string
  readonly targets: readonly ApplyPatchWorkspaceTarget[]
}

export class ApplyPatchWorkspaceContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApplyPatchWorkspaceContractError"
  }
}

type ParserMode =
  | "not_started"
  | "started"
  | "add"
  | "delete"
  | "update"
  | "ended"

interface MutationHeader {
  readonly operation: Exclude<ApplyPatchWorkspaceOperation, "move">
  readonly declaredPath: string
}

/**
 * Compile the complete filesystem authority required by one native Codex
 * apply_patch invocation. This parser owns the mutation-header grammar; the
 * apply_patch executable remains responsible for validating and applying
 * hunk contents.
 */
export function compileApplyPatchWorkspaceContract(
  patch: string,
  workspaceScope: WorkspaceScope
): ApplyPatchWorkspaceContract {
  if (typeof patch !== "string" || patch.trim() === "") {
    throw new ApplyPatchWorkspaceContractError(
      "apply_patch payload must be non-empty"
    )
  }
  if (patch.includes("\u0000")) {
    throw new ApplyPatchWorkspaceContractError(
      "apply_patch payload must not contain NUL bytes"
    )
  }

  const lines = patch.trim().split(/\r?\n/)
  const executionLines = [...lines]
  const targets: ApplyPatchWorkspaceTarget[] = []
  let mode: ParserMode = "not_started"
  let environmentSeen = false
  let updateMoveSeen = false
  let updateBodySeen = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const lineNumber = index + 1

    if (mode === "not_started") {
      if (line.trim() !== BEGIN_PATCH_MARKER) {
        throw contractError(
          lineNumber,
          `first line must be '${BEGIN_PATCH_MARKER}'`
        )
      }
      mode = "started"
      continue
    }

    if (mode === "ended") {
      if (line.trim() !== "") {
        throw contractError(
          lineNumber,
          `no content is allowed after '${END_PATCH_MARKER}'`
        )
      }
      continue
    }

    const controlLine = mode === "update" ? line.trimEnd() : line.trim()
    if (controlLine === END_PATCH_MARKER) {
      mode = "ended"
      continue
    }

    if (mode === "started" && controlLine.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (environmentSeen) {
        throw contractError(
          lineNumber,
          "apply_patch environment ID must not be repeated"
        )
      }
      if (controlLine.slice(ENVIRONMENT_ID_MARKER.length).trim() === "") {
        throw contractError(
          lineNumber,
          "apply_patch environment ID must be non-empty"
        )
      }
      environmentSeen = true
      continue
    }

    const mutationHeader = parseMutationHeader(controlLine)
    if (mutationHeader) {
      const target = resolveDeclaredTarget(
        workspaceScope,
        mutationHeader.operation,
        mutationHeader.declaredPath,
        lineNumber
      )
      targets.push(target)
      executionLines[index] =
        mutationMarker(mutationHeader.operation) + target.target.absolutePath
      mode = mutationHeader.operation
      updateMoveSeen = false
      updateBodySeen = false
      continue
    }

    if (mode === "update") {
      const movePath = controlLine.startsWith(MOVE_TO_MARKER)
        ? controlLine.slice(MOVE_TO_MARKER.length)
        : null
      if (movePath !== null) {
        if (updateMoveSeen || updateBodySeen) {
          throw contractError(
            lineNumber,
            "move destination must immediately follow its update header"
          )
        }
        const target = resolveDeclaredTarget(
          workspaceScope,
          "move",
          movePath,
          lineNumber
        )
        targets.push(target)
        executionLines[index] = MOVE_TO_MARKER + target.target.absolutePath
        updateMoveSeen = true
        continue
      }
      updateBodySeen = true
      continue
    }

    if (mode === "add" && line.startsWith("+")) {
      continue
    }

    throw contractError(
      lineNumber,
      "line is not valid in the apply_patch mutation-header grammar"
    )
  }

  if (mode !== "ended") {
    throw new ApplyPatchWorkspaceContractError(
      `apply_patch payload must end with '${END_PATCH_MARKER}'`
    )
  }
  if (targets.length === 0) {
    throw new ApplyPatchWorkspaceContractError(
      "apply_patch payload must declare at least one file mutation"
    )
  }

  return Object.freeze({
    executionPatch: executionLines.join("\n"),
    cwd: workspaceScope.primaryRoot,
    targets: Object.freeze(targets),
  })
}

function mutationMarker(
  operation: Exclude<ApplyPatchWorkspaceOperation, "move">
): string {
  switch (operation) {
    case "add":
      return ADD_FILE_MARKER
    case "delete":
      return DELETE_FILE_MARKER
    case "update":
      return UPDATE_FILE_MARKER
  }
}

function parseMutationHeader(controlLine: string): MutationHeader | null {
  const markers: readonly [
    marker: string,
    operation: Exclude<ApplyPatchWorkspaceOperation, "move">,
  ][] = [
    [ADD_FILE_MARKER, "add"],
    [DELETE_FILE_MARKER, "delete"],
    [UPDATE_FILE_MARKER, "update"],
  ]
  for (const [marker, operation] of markers) {
    if (controlLine.startsWith(marker)) {
      return {
        operation,
        declaredPath: controlLine.slice(marker.length),
      }
    }
  }
  return null
}

function resolveDeclaredTarget(
  workspaceScope: WorkspaceScope,
  operation: ApplyPatchWorkspaceOperation,
  declaredPath: string,
  lineNumber: number
): ApplyPatchWorkspaceTarget {
  if (declaredPath === "") {
    throw contractError(lineNumber, `${operation} path must be non-empty`)
  }
  try {
    return Object.freeze({
      operation,
      declaredPath,
      target: workspaceScope.resolveTarget(declaredPath),
    })
  } catch (error) {
    if (error instanceof WorkspaceScopeError) {
      throw contractError(
        lineNumber,
        `${operation} path is outside the workspace scope: ${declaredPath}`
      )
    }
    throw error
  }
}

function contractError(
  lineNumber: number,
  message: string
): ApplyPatchWorkspaceContractError {
  return new ApplyPatchWorkspaceContractError(
    `invalid apply_patch contract at line ${lineNumber}: ${message}`
  )
}
