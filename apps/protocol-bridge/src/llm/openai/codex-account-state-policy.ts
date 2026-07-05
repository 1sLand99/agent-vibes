import type { CooldownableAccount } from "../shared/account-cooldown"
import { isAccountDisabled } from "../shared/account-cooldown"
import type { PersistedBackendAccountState } from "../shared/backend-account-state-store"
import { hashCodexIdentityPart } from "./codex-slot-identity"

export interface CodexAccountStateSlot extends CooldownableAccount {
  stateKey: string
  label?: string
  email?: string
  apiKey?: string
  refreshToken?: string
}

export interface RestoreCodexPersistedAccountStatesResult<
  TSlot extends CodexAccountStateSlot,
> {
  restored: Array<{ slot: TSlot; state: PersistedBackendAccountState }>
  stale: Array<{ slot: TSlot; state: PersistedBackendAccountState }>
}

export function getCodexCredentialFingerprint(
  account: Pick<CodexAccountStateSlot, "apiKey" | "refreshToken">
): string {
  const material = account.refreshToken?.trim() || account.apiKey?.trim() || ""
  return material ? hashCodexIdentityPart(material) : ""
}

export function restoreCodexPersistedAccountStates<
  TSlot extends CodexAccountStateSlot,
>(
  slots: readonly TSlot[],
  persistedStates: ReadonlyMap<string, PersistedBackendAccountState>
): RestoreCodexPersistedAccountStatesResult<TSlot> {
  const result: RestoreCodexPersistedAccountStatesResult<TSlot> = {
    restored: [],
    stale: [],
  }

  for (const slot of slots) {
    const state = persistedStates.get(slot.stateKey)
    if (!isPersistedDisabledState(state)) {
      continue
    }

    const currentFingerprint = getCodexCredentialFingerprint(slot)
    if (
      state.credentialFingerprint &&
      currentFingerprint &&
      state.credentialFingerprint !== currentFingerprint
    ) {
      result.stale.push({ slot, state })
      continue
    }

    slot.disabledAt = state.disabledAt
    slot.disabledReason = state.disabledReason
    slot.disabledStatusCode = state.disabledStatusCode
    slot.disabledMessage = state.disabledMessage
    slot.cooldownUntil = 0
    slot.modelStates.clear()
    result.restored.push({ slot, state })
  }

  return result
}

export function createCodexPersistedAccountStates<
  TSlot extends CodexAccountStateSlot,
>(slots: readonly TSlot[], now: number): PersistedBackendAccountState[] {
  return slots
    .filter((slot) => isAccountDisabled(slot))
    .map((slot) => ({
      stateKey: slot.stateKey,
      label: slot.label || slot.email,
      disabledAt: slot.disabledAt,
      disabledReason: slot.disabledReason,
      disabledStatusCode: slot.disabledStatusCode,
      disabledMessage: slot.disabledMessage,
      credentialFingerprint: getCodexCredentialFingerprint(slot),
      updatedAt: now,
    }))
}

export function shouldClearCodexDisablementForCredentialChange(
  slot: CodexAccountStateSlot,
  wasDisabled: boolean,
  previousFingerprint: string
): boolean {
  if (!wasDisabled) {
    return false
  }

  const currentFingerprint = getCodexCredentialFingerprint(slot)
  return !!currentFingerprint && currentFingerprint !== previousFingerprint
}

function isPersistedDisabledState(
  state: PersistedBackendAccountState | undefined
): state is PersistedBackendAccountState & { disabledAt: number } {
  return typeof state?.disabledAt === "number" && state.disabledAt > 0
}
