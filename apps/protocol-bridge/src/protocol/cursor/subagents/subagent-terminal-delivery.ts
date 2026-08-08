import type { TerminalizeSubagentRunInput } from "../session/subagent-run-store.service"

/**
 * Exact graph route that delivers one durable sub-agent terminal outcome.
 *
 * The route is explicit because run mode alone is insufficient: a detached
 * worker can fail before its initial parent task acknowledgement is durable,
 * while a normal detached completion is delivered later by await_task or a
 * Cursor control notification.
 */
export type SubagentTerminalDeliveryCommit =
  | {
      agentId: string
      route: "parent_task_result"
      sourceToolUseId: string
    }
  | {
      agentId: string
      route: "await_task_result"
      sourceToolUseId: string
    }
  | {
      agentId: string
      route: "control_notification"
      parentToolCallId: string
    }

/**
 * Complete terminal graph mutation accepted by ContextState. A caller may
 * supply terminal facts only when this same graph transaction owns the state
 * transition; delivery is always mandatory and is claimed in that transaction.
 */
export interface SubagentTerminalGraphCommit {
  delivery: SubagentTerminalDeliveryCommit
  outcome?: TerminalizeSubagentRunInput
}

/** Decode persisted control metadata without accepting aliases or extra data. */
export function decodeSubagentTerminalDeliveries(
  value: unknown
): SubagentTerminalDeliveryCommit[] {
  if (!Array.isArray(value)) {
    throw new Error("sub-agent terminal deliveries must be an array")
  }
  const deliveries: SubagentTerminalDeliveryCommit[] = []
  const seenAgentIds = new Set<string>()
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("sub-agent terminal delivery must be an object")
    }
    const record = candidate as Record<string, unknown>
    if (Object.keys(record).length !== 3) {
      throw new Error("sub-agent terminal delivery has unsupported fields")
    }
    const agentId = requireExactIdentifier(record.agentId, "agentId")
    if (seenAgentIds.has(agentId)) {
      throw new Error(`duplicate sub-agent terminal delivery: ${agentId}`)
    }
    seenAgentIds.add(agentId)
    if (record.route === "control_notification") {
      deliveries.push({
        agentId,
        route: record.route,
        parentToolCallId: requireExactIdentifier(
          record.parentToolCallId,
          "parentToolCallId"
        ),
      })
      continue
    }
    if (
      record.route === "parent_task_result" ||
      record.route === "await_task_result"
    ) {
      deliveries.push({
        agentId,
        route: record.route,
        sourceToolUseId: requireExactIdentifier(
          record.sourceToolUseId,
          "sourceToolUseId"
        ),
      })
      continue
    }
    throw new Error("sub-agent terminal delivery has an unsupported route")
  }
  return deliveries
}

function requireExactIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(`sub-agent terminal delivery ${field} is invalid`)
  }
  return value
}
