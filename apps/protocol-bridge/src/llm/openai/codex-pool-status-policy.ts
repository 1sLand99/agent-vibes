import {
  isAccountDisabled,
  type CooldownableAccount,
} from "../shared/account-cooldown"
import type {
  BackendPoolEntryState,
  BackendPoolModelCooldownStatus,
  CodexRateLimitSnapshot,
  CodexRateLimitSource,
} from "../shared/backend-pool-status"
import {
  getCodexRateLimitQuotaCooldownUntil,
  getEffectiveCodexRateLimitSnapshot,
} from "./codex-rate-limit-policy"

export interface CodexPoolStatusAccount extends CooldownableAccount {
  rateLimitSnapshots: Map<
    string,
    Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  >
}

export function getActiveCodexModelCooldowns(
  account: Pick<CooldownableAccount, "modelStates">,
  now: number
): BackendPoolModelCooldownStatus[] {
  return Array.from(account.modelStates.entries())
    .filter(([, state]) => state.cooldownUntil > now)
    .map(([model, state]) => ({
      model,
      cooldownUntil: state.cooldownUntil,
      quotaExhausted: state.quotaExhausted,
      backoffLevel: state.backoffLevel,
    }))
    .sort((left, right) => left.cooldownUntil - right.cooldownUntil)
}

export function resolveCodexPoolEntryState(
  account: CodexPoolStatusAccount,
  modelCooldowns: readonly BackendPoolModelCooldownStatus[],
  now: number
): BackendPoolEntryState {
  if (isAccountDisabled(account)) {
    return "disabled"
  }

  const activeQuotaCooldowns = Array.from(account.rateLimitSnapshots.values())
    .map((snapshots) =>
      getCodexRateLimitQuotaCooldownUntil(
        getEffectiveCodexRateLimitSnapshot(snapshots),
        now
      )
    )
    .filter((cooldownUntil) => cooldownUntil > now)

  if (activeQuotaCooldowns.length > 0) {
    account.cooldownUntil = Math.max(
      account.cooldownUntil,
      ...activeQuotaCooldowns
    )
  }

  if (account.cooldownUntil > now) {
    return "cooldown"
  }
  if (modelCooldowns.length > 0) {
    return "model_cooldown"
  }
  return "ready"
}
