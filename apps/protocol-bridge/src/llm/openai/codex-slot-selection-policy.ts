export type CodexSlotSelectionKind =
  | "sticky"
  | "warm_pool"
  | "next_available"
  | "none"

export type CodexSlotSelectionResult<TSlot> =
  | {
      kind: Exclude<CodexSlotSelectionKind, "none">
      slot: TSlot
    }
  | {
      kind: "none"
    }

export interface ResolveCodexSlotSelectionOptions<TSlot> {
  getStickySlot?: () => TSlot | null
  getWarmPoolSlot?: () => TSlot | null
  getNextAvailableSlot: () => TSlot | null
  preferWarmPool?: boolean
}

export function resolveCodexSlotSelection<TSlot>(
  options: ResolveCodexSlotSelectionOptions<TSlot>
): CodexSlotSelectionResult<TSlot> {
  const stickySlot = options.getStickySlot?.() ?? null
  if (stickySlot) {
    return {
      kind: "sticky",
      slot: stickySlot,
    }
  }

  if (options.preferWarmPool) {
    const warmPoolSlot = options.getWarmPoolSlot?.() ?? null
    if (warmPoolSlot) {
      return {
        kind: "warm_pool",
        slot: warmPoolSlot,
      }
    }
  }

  const nextAvailableSlot = options.getNextAvailableSlot()
  if (nextAvailableSlot) {
    return {
      kind: "next_available",
      slot: nextAvailableSlot,
    }
  }

  return {
    kind: "none",
  }
}
