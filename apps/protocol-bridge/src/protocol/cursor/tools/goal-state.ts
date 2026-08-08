import { create } from "@bufbuild/protobuf"
import { randomUUID } from "node:crypto"

import {
  GoalStateSchema,
  GoalStatus,
  type GoalState,
} from "../../../gen/agent/v1_pb"

export interface BridgeGoalState {
  conversationId: string
  goalId: string
  objective: string
  status: GoalStatus
  idleContinuationsWithoutToolCalls: number
  activeDurationMs?: bigint
  lastAccruedAtMs?: bigint
  continuationCount: number
  agentSessionId?: string
}

/** JSON-safe shape persisted in sessions.config_json. */
export interface SerializedBridgeGoalState {
  conversationId: string
  goalId: string
  objective: string
  status: GoalStatus
  idleContinuationsWithoutToolCalls: number
  activeDurationMs?: string
  lastAccruedAtMs?: string
  continuationCount: number
  agentSessionId?: string
}

export function parseGoalStatus(value: unknown): GoalStatus {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value in GoalStatus) return value as GoalStatus
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    switch (normalized) {
      case "active":
      case "goal_status_active":
        return GoalStatus.ACTIVE
      case "paused":
      case "goal_status_paused":
        return GoalStatus.PAUSED
      case "complete":
      case "completed":
      case "goal_status_complete":
        return GoalStatus.COMPLETE
      case "cleared":
      case "goal_status_cleared":
        return GoalStatus.CLEARED
      default:
        break
    }
  }
  throw new Error(`Unsupported GoalStatus value: ${String(value)}`)
}

export function applyCreateGoal(input: {
  conversationId: string
  objective: string
  agentSessionId?: string
  goalId?: string
  nowMs?: number
}): BridgeGoalState {
  const objective = input.objective.trim()
  if (!objective) {
    throw new Error("create_goal requires a non-empty objective")
  }
  const conversationId = input.conversationId.trim()
  if (!conversationId) {
    throw new Error("create_goal requires a conversation id")
  }
  const nowMs = input.nowMs ?? Date.now()
  return {
    conversationId,
    goalId: (input.goalId || randomUUID()).trim(),
    objective,
    status: GoalStatus.ACTIVE,
    idleContinuationsWithoutToolCalls: 0,
    activeDurationMs: 0n,
    lastAccruedAtMs: BigInt(nowMs),
    continuationCount: 0,
    agentSessionId: input.agentSessionId?.trim() || undefined,
  }
}

export function applyUpdateGoal(
  current: BridgeGoalState,
  status: GoalStatus,
  nowMs: number = Date.now()
): BridgeGoalState {
  if (status === GoalStatus.UNSPECIFIED) {
    throw new Error("update_goal requires an explicit GoalStatus")
  }
  return {
    ...current,
    status,
    lastAccruedAtMs: BigInt(nowMs),
  }
}

export function accrueGoalContinuation(
  current: BridgeGoalState,
  input?: { hadToolCalls?: boolean; nowMs?: number }
): BridgeGoalState {
  const nowMs = input?.nowMs ?? Date.now()
  const hadToolCalls = input?.hadToolCalls === true
  return {
    ...current,
    continuationCount: current.continuationCount + 1,
    idleContinuationsWithoutToolCalls: hadToolCalls
      ? 0
      : current.idleContinuationsWithoutToolCalls + 1,
    lastAccruedAtMs: BigInt(nowMs),
  }
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function parseOptionalUint64String(
  value: unknown,
  label: string
): bigint | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`)
  }
  return BigInt(value)
}

export function serializeBridgeGoalState(
  goal: BridgeGoalState
): SerializedBridgeGoalState {
  return {
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    idleContinuationsWithoutToolCalls: goal.idleContinuationsWithoutToolCalls,
    continuationCount: goal.continuationCount,
    ...(goal.activeDurationMs !== undefined
      ? { activeDurationMs: goal.activeDurationMs.toString() }
      : {}),
    ...(goal.lastAccruedAtMs !== undefined
      ? { lastAccruedAtMs: goal.lastAccruedAtMs.toString() }
      : {}),
    ...(goal.agentSessionId ? { agentSessionId: goal.agentSessionId } : {}),
  }
}

export function deserializeBridgeGoalState(
  value: unknown,
  label = "goalState"
): BridgeGoalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const conversationId =
    typeof record.conversationId === "string"
      ? record.conversationId.trim()
      : ""
  const goalId = typeof record.goalId === "string" ? record.goalId.trim() : ""
  const objective =
    typeof record.objective === "string" ? record.objective.trim() : ""
  if (!conversationId) throw new Error(`${label}.conversationId is required`)
  if (!goalId) throw new Error(`${label}.goalId is required`)
  if (!objective) throw new Error(`${label}.objective is required`)

  const status = parseGoalStatus(record.status)
  if (status === GoalStatus.UNSPECIFIED) {
    throw new Error(`${label}.status must be a concrete GoalStatus`)
  }

  const agentSessionId =
    typeof record.agentSessionId === "string" && record.agentSessionId.trim()
      ? record.agentSessionId.trim()
      : undefined

  return {
    conversationId,
    goalId,
    objective,
    status,
    idleContinuationsWithoutToolCalls: requireNonNegativeSafeInteger(
      record.idleContinuationsWithoutToolCalls,
      `${label}.idleContinuationsWithoutToolCalls`
    ),
    continuationCount: requireNonNegativeSafeInteger(
      record.continuationCount,
      `${label}.continuationCount`
    ),
    activeDurationMs: parseOptionalUint64String(
      record.activeDurationMs,
      `${label}.activeDurationMs`
    ),
    lastAccruedAtMs: parseOptionalUint64String(
      record.lastAccruedAtMs,
      `${label}.lastAccruedAtMs`
    ),
    agentSessionId,
  }
}

export function toProtoGoalState(goal: BridgeGoalState): GoalState {
  return create(GoalStateSchema, {
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    idleContinuationsWithoutToolCalls: goal.idleContinuationsWithoutToolCalls,
    continuationCount: goal.continuationCount,
    ...(goal.activeDurationMs !== undefined
      ? { activeDurationMs: goal.activeDurationMs }
      : {}),
    ...(goal.lastAccruedAtMs !== undefined
      ? { lastAccruedAtMs: goal.lastAccruedAtMs }
      : {}),
    ...(goal.agentSessionId ? { agentSessionId: goal.agentSessionId } : {}),
  })
}

export function fromProtoGoalState(goal: GoalState): BridgeGoalState {
  return {
    conversationId: goal.conversationId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    idleContinuationsWithoutToolCalls: goal.idleContinuationsWithoutToolCalls,
    continuationCount: goal.continuationCount,
    activeDurationMs: goal.activeDurationMs,
    lastAccruedAtMs: goal.lastAccruedAtMs,
    agentSessionId: goal.agentSessionId || undefined,
  }
}
