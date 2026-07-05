import {
  type CooldownableAccount,
  isAccountAvailableForModel,
  isAccountDisabled,
} from "../shared/account-cooldown"

export type CodexQuotaTier = "primary" | "secondary"

export interface CodexSlotAvailabilityOptions<
  TSlot extends CooldownableAccount,
> {
  slot: TSlot
  model: string
  now: number
  isRateLimitExhausted: (slot: TSlot, model: string) => boolean
  getQuotaCooldownUntil: (
    slot: TSlot,
    tier: CodexQuotaTier,
    model: string
  ) => number
}

export interface CodexSlotRecoveryTimeOptions<
  TSlot extends CooldownableAccount,
> {
  slot: TSlot
  model: string
  now: number
  isModelSupported: (slot: TSlot, model: string) => boolean
  getQuotaCooldownUntil: (
    slot: TSlot,
    tier: CodexQuotaTier,
    model: string
  ) => number
}

export function isCodexSlotAvailableForModel<TSlot extends CooldownableAccount>(
  options: CodexSlotAvailabilityOptions<TSlot>
): boolean {
  const { slot, model, now } = options

  if (options.isRateLimitExhausted(slot, model)) {
    return false
  }

  const weeklyQuotaCooldownUntil = options.getQuotaCooldownUntil(
    slot,
    "secondary",
    model
  )
  if (weeklyQuotaCooldownUntil > now) {
    return false
  }

  const primaryQuotaCooldownUntil = options.getQuotaCooldownUntil(
    slot,
    "primary",
    model
  )
  if (primaryQuotaCooldownUntil > now) {
    return false
  }

  return isAccountAvailableForModel(slot, model, now)
}

export function getCodexSlotRecoveryTimeForModel<
  TSlot extends CooldownableAccount,
>(options: CodexSlotRecoveryTimeOptions<TSlot>): number | null {
  const { slot, model, now } = options

  if (isAccountDisabled(slot) || !options.isModelSupported(slot, model)) {
    return null
  }

  const recoveryCandidates: number[] = []

  if (slot.cooldownUntil > now) {
    recoveryCandidates.push(slot.cooldownUntil)
  }

  const modelState = slot.modelStates.get(model)
  if (modelState?.cooldownUntil && modelState.cooldownUntil > now) {
    recoveryCandidates.push(modelState.cooldownUntil)
  }

  const primaryQuotaCooldownUntil = options.getQuotaCooldownUntil(
    slot,
    "primary",
    model
  )
  if (primaryQuotaCooldownUntil > now) {
    recoveryCandidates.push(primaryQuotaCooldownUntil)
  }

  const weeklyQuotaCooldownUntil = options.getQuotaCooldownUntil(
    slot,
    "secondary",
    model
  )
  if (weeklyQuotaCooldownUntil > now) {
    recoveryCandidates.push(weeklyQuotaCooldownUntil)
  }

  return recoveryCandidates.length > 0 ? Math.max(...recoveryCandidates) : null
}
