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
  getEffectiveCodexRateLimitSnapshot,
  getCodexWeeklyRateLimitCooldownUntil,
} from "./codex-rate-limit-policy"

export interface CodexPoolStatusAccount extends CooldownableAccount {
  rateLimitSnapshots: Map<
    string,
    Partial<Record<CodexRateLimitSource, CodexRateLimitSnapshot>>
  >
}

export function getActiveCodexModelCooldowns(
  account: CodexPoolStatusAccount,
  now: number
): BackendPoolModelCooldownStatus[] {
  const cooldowns = new Map<string, BackendPoolModelCooldownStatus>()

  for (const [model, state] of account.modelStates) {
    if (state.cooldownUntil <= now) {
      continue
    }
    cooldowns.set(model, {
      model,
      cooldownUntil: state.cooldownUntil,
      quotaExhausted: state.quotaExhausted,
      reason: state.quotaExhausted ? "rate_limited" : "transient",
      backoffLevel: state.backoffLevel,
    })
  }

  // Rate-limit headers describe the quota bucket observed for the model that
  // produced them. Project an exhausted bucket as a per-model status instead
  // of promoting it to the account-wide cooldown used for transport/auth
  // failures. Other models (for example Spark) may use a different bucket.
  for (const [model, snapshots] of account.rateLimitSnapshots) {
    const cooldownUntil = getCodexWeeklyRateLimitCooldownUntil(
      getEffectiveCodexRateLimitSnapshot(snapshots),
      now
    )
    if (cooldownUntil <= now) {
      continue
    }

    const existing = cooldowns.get(model)
    cooldowns.set(model, {
      model,
      cooldownUntil: Math.max(existing?.cooldownUntil || 0, cooldownUntil),
      quotaExhausted: true,
      reason: "quota_exhausted",
      ...(existing?.backoffLevel !== undefined
        ? { backoffLevel: existing.backoffLevel }
        : {}),
    })
  }

  return Array.from(cooldowns.values()).sort(
    (left, right) => left.cooldownUntil - right.cooldownUntil
  )
}

export function resolveCodexPoolEntryState(
  account: CodexPoolStatusAccount,
  modelCooldowns: readonly BackendPoolModelCooldownStatus[],
  now: number
): BackendPoolEntryState {
  if (isAccountDisabled(account)) {
    return "disabled"
  }

  if (account.cooldownUntil > now) {
    return "cooldown"
  }
  if (modelCooldowns.length > 0) {
    return "model_cooldown"
  }
  return "ready"
}
