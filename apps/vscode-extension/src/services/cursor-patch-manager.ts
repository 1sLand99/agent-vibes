import * as fs from "fs"
import * as path from "path"
import { CursorChecksumsService } from "./cursor-checksums"
import {
  CursorPatchService,
  type CursorBridgeEndpointPatchStatus,
} from "./cursor-patch"
import {
  CursorPatchBaselineService,
  type CursorPatchResetResult,
} from "./cursor-patch-baseline"
import {
  ensureDir,
  getCursorAppRootPath,
  getCursorInstallFingerprint,
  getCursorInstallVersion,
  getDefaultDataDir,
} from "../utils/platform"

export interface CursorPatchResetState {
  canReset: boolean
  hint: string
  managedFileCount: number
  hasUnmanagedAppliedPatches: boolean
}

type CursorBridgeEndpointPatchManifest = {
  version: 1
  patchedAt: string
  appRootPath: string | null
  installVersion: string | null
  installFingerprint: string | null
  endpointUrl: string
}

export type CursorBridgeEndpointLifecycleKind =
  | "untracked"
  | "active"
  | "missing"
  | "stale_after_cursor_update"
  | "unsupported_cursor_update"
  | "manifest_error"

export interface CursorBridgeEndpointLifecycleState {
  state: CursorBridgeEndpointLifecycleKind
  canReapply: boolean
  installChanged: boolean
  currentInstallVersion: string | null
  lastInstallVersion: string | null
  lastPatchedAt: string | null
  lastEndpointUrl: string | null
  hint: string
}

export class CursorPatchManagerService {
  private readonly baseline = new CursorPatchBaselineService()
  private readonly checksums = new CursorChecksumsService()

  getResetState(): CursorPatchResetState {
    const baselineStatus = this.baseline.getStatus()
    const checksumsStatus = this.checksums.getStatus()
    const checksumPatched = checksumsStatus.differsFromBaseline === true
    const hasUnmanagedAppliedPatches =
      checksumPatched && !checksumsStatus.hasBaseline
    const managedFileCount = baselineStatus.trackedFiles.length
    const canReset =
      baselineStatus.manifestExists &&
      managedFileCount > 0 &&
      !hasUnmanagedAppliedPatches

    const hint = !baselineStatus.manifestExists
      ? "No original baseline has been captured yet. Apply a Cursor repair through Agent Vibes first."
      : hasUnmanagedAppliedPatches
        ? "Some active checksum changes were applied before Agent Vibes captured the original baseline, so one-click reset is currently unsafe."
        : `Restore ${managedFileCount} managed Cursor file(s) to the captured original baseline, then re-apply the repairs you still want.`

    return {
      canReset,
      hint,
      managedFileCount,
      hasUnmanagedAppliedPatches,
    }
  }

  recordBridgeEndpointPatchSuccess(
    status: Pick<CursorBridgeEndpointPatchStatus, "endpointUrl">
  ): void {
    const manifest: CursorBridgeEndpointPatchManifest = {
      version: 1,
      patchedAt: new Date().toISOString(),
      appRootPath: getCursorAppRootPath(),
      installVersion: getCursorInstallVersion(),
      installFingerprint: getCursorInstallFingerprint(),
      endpointUrl: status.endpointUrl,
    }

    const manifestPath = this.getBridgeEndpointManifestPath()
    ensureDir(path.dirname(manifestPath))
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  }

  ensureBridgeEndpointPatchTracked(
    status: Pick<
      CursorBridgeEndpointPatchStatus,
      "applied" | "endpointUrl" | "requiresPortUpdate"
    >
  ): void {
    if (!status.applied || status.requiresPortUpdate) return
    const manifestResult = this.readBridgeEndpointManifest()
    if (manifestResult.manifest || manifestResult.error) return
    this.recordBridgeEndpointPatchSuccess(status)
  }

  getBridgeEndpointLifecycleState(
    status: CursorBridgeEndpointPatchStatus
  ): CursorBridgeEndpointLifecycleState {
    const currentInstallVersion = getCursorInstallVersion()
    const currentAppRootPath = getCursorAppRootPath()
    const currentInstallFingerprint = getCursorInstallFingerprint()
    const manifestResult = this.readBridgeEndpointManifest()
    const manifest = manifestResult.manifest
    const canReapply =
      status.fileExists &&
      ((status.canApply && !status.applied) || status.requiresPortUpdate)

    if (manifestResult.error) {
      return {
        state: "manifest_error",
        canReapply: false,
        installChanged: false,
        currentInstallVersion,
        lastInstallVersion: null,
        lastPatchedAt: null,
        lastEndpointUrl: null,
        hint: manifestResult.error,
      }
    }

    const installChanged = manifest
      ? this.hasCursorInstallChanged(manifest, {
          appRootPath: currentAppRootPath,
          installVersion: currentInstallVersion,
          installFingerprint: currentInstallFingerprint,
        })
      : false

    const base = {
      canReapply,
      installChanged,
      currentInstallVersion,
      lastInstallVersion: manifest?.installVersion ?? null,
      lastPatchedAt: manifest?.patchedAt ?? null,
      lastEndpointUrl: manifest?.endpointUrl ?? null,
    }

    if (status.applied && !status.requiresPortUpdate) {
      return {
        ...base,
        state: "active",
        hint: "Cursor direct connection patch is active for the current files.",
      }
    }

    if (!manifest) {
      return {
        ...base,
        state: "untracked",
        hint: "No previous Cursor direct connection patch record was found.",
      }
    }

    if (installChanged) {
      if (canReapply) {
        return {
          ...base,
          state: "stale_after_cursor_update",
          hint: "Cursor was updated after the last successful patch. Re-apply the direct connection patch for this Cursor build.",
        }
      }

      return {
        ...base,
        state: "unsupported_cursor_update",
        hint: "Cursor was updated after the last successful patch, but this Cursor build does not expose a safe patch target.",
      }
    }

    return {
      ...base,
      state: "missing",
      hint: "The previous Cursor direct connection patch is no longer active.",
    }
  }

  resetAllPatches(): CursorPatchResetResult {
    CursorPatchService.invalidateStatusCache()

    const resetState = this.getResetState()
    if (!resetState.canReset) {
      return {
        success: false,
        restored: 0,
        errors: [resetState.hint],
      }
    }

    return this.baseline.resetAll()
  }

  private getBridgeEndpointManifestPath(): string {
    return path.join(
      getDefaultDataDir(),
      "cursor-patch-state",
      "bridge-endpoint.json"
    )
  }

  private readBridgeEndpointManifest(): {
    manifest: CursorBridgeEndpointPatchManifest | null
    error: string | null
  } {
    const manifestPath = this.getBridgeEndpointManifestPath()
    if (!fs.existsSync(manifestPath)) {
      return { manifest: null, error: null }
    }

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8")
      const parsed = JSON.parse(
        raw
      ) as Partial<CursorBridgeEndpointPatchManifest>
      if (
        parsed.version !== 1 ||
        typeof parsed.patchedAt !== "string" ||
        !(
          parsed.appRootPath === null || typeof parsed.appRootPath === "string"
        ) ||
        !(
          parsed.installVersion === null ||
          typeof parsed.installVersion === "string"
        ) ||
        !(
          parsed.installFingerprint === null ||
          typeof parsed.installFingerprint === "string"
        ) ||
        typeof parsed.endpointUrl !== "string"
      ) {
        return {
          manifest: null,
          error: `Invalid Cursor direct patch manifest: ${manifestPath}`,
        }
      }

      return {
        manifest: parsed as CursorBridgeEndpointPatchManifest,
        error: null,
      }
    } catch (error) {
      return {
        manifest: null,
        error: `Failed to read Cursor direct patch manifest: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private hasCursorInstallChanged(
    manifest: CursorBridgeEndpointPatchManifest,
    current: {
      appRootPath: string | null
      installVersion: string | null
      installFingerprint: string | null
    }
  ): boolean {
    if (
      manifest.appRootPath &&
      current.appRootPath &&
      manifest.appRootPath !== current.appRootPath
    ) {
      return true
    }

    if (
      manifest.installFingerprint &&
      current.installFingerprint &&
      manifest.installFingerprint !== current.installFingerprint
    ) {
      return true
    }

    return Boolean(
      !manifest.installFingerprint &&
      !current.installFingerprint &&
      manifest.installVersion &&
      current.installVersion &&
      manifest.installVersion !== current.installVersion
    )
  }
}
