import type {
  BackendPoolEntryStatus,
  BackendPoolStatus,
} from "./backend-pool-status"

export interface BuildBackendPoolStatusInput {
  backend: string
  kind: BackendPoolStatus["kind"]
  entries: BackendPoolEntryStatus[]
  configured?: boolean
  configPath?: string | null
  statePath?: string | null
}

const AVAILABLE_ENTRY_STATES = new Set<BackendPoolEntryStatus["state"]>([
  "ready",
  "degraded",
  "model_cooldown",
])

export function buildBackendPoolStatus(
  input: BuildBackendPoolStatusInput
): BackendPoolStatus {
  return {
    backend: input.backend,
    kind: input.kind,
    configured: input.configured ?? input.entries.length > 0,
    total: input.entries.length,
    available: input.entries.filter((entry) =>
      AVAILABLE_ENTRY_STATES.has(entry.state)
    ).length,
    ready: input.entries.filter((entry) => entry.state === "ready").length,
    degraded: input.entries.filter((entry) => entry.state === "degraded")
      .length,
    modelCooldown: input.entries.filter(
      (entry) => entry.state === "model_cooldown"
    ).length,
    cooling: input.entries.filter((entry) => entry.state === "cooldown").length,
    disabled: input.entries.filter((entry) => entry.state === "disabled")
      .length,
    unavailable: input.entries.filter((entry) => entry.state === "unavailable")
      .length,
    configPath: input.configPath,
    statePath: input.statePath,
    entries: input.entries,
  }
}
