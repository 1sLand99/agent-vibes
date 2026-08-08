/**
 * An immutable skill-state transition prepared by a tool invocation. The
 * transition is stored with the durable tool_use and becomes visible only
 * when its matching tool_result graph append succeeds.
 */
export interface CursorSkillActivationReceipt {
  readonly skillName: string
  readonly reason: string
}

/** Durable assistant metadata shape keyed by the source tool_use id. */
export interface DurableToolSkillActivationMetadata {
  readonly toolCallId: string
  readonly receipts: readonly CursorSkillActivationReceipt[]
}

export const CURSOR_SKILL_ACTIVATION_RECEIPTS_METADATA_KEY =
  "cursor_skill_activation_receipts"
