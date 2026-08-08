/**
 * Canonical identities for runtime built-in sub-agents.
 *
 * A runtime identity is not the same thing as an agent.v1 `SubagentType`
 * oneof field name.  Every built-in is declared here once, together with its
 * exact Cursor wire projection.  Unknown names are custom identities; this
 * module intentionally performs no spelling, casing, or separator aliases.
 */

import { create } from "@bufbuild/protobuf"
import {
  SubagentTypeBashSchema,
  SubagentTypeBrowserUseSchema,
  SubagentTypeCustomSchema,
  SubagentTypeExploreSchema,
  SubagentTypeSchema,
  SubagentTypeUnspecifiedSchema,
} from "../../../gen/agent/v1_pb"
import { OFFICIAL_ANTIGRAVITY_BROWSER_SUBAGENT_TYPE } from "../../../shared/official-antigravity-tools"

export type BuiltInSubagentProtoCase =
  | "unspecified"
  | "explore"
  | "browserUse"
  | "bash"
  | "custom"

export interface BuiltInSubagentIdentity {
  agentType: string
  protoCase: BuiltInSubagentProtoCase
}

/**
 * The sole built-in runtime-identity to Cursor-proto mapping.  Add a new
 * entry only together with an executable built-in definition; a proto case
 * alone never creates a runtime sub-agent.
 */
export const BUILTIN_SUBAGENT_IDENTITIES = {
  GENERAL_PURPOSE: {
    agentType: "general-purpose",
    protoCase: "unspecified",
  },
  EXPLORE: { agentType: "explore", protoCase: "explore" },
  BROWSER: {
    agentType: OFFICIAL_ANTIGRAVITY_BROWSER_SUBAGENT_TYPE,
    protoCase: "browserUse",
  },
  BUGBOT: { agentType: "bugbot", protoCase: "custom" },
  BASH: { agentType: "bash", protoCase: "bash" },
} as const satisfies Record<string, BuiltInSubagentIdentity>

export type BuiltInSubagentType =
  (typeof BUILTIN_SUBAGENT_IDENTITIES)[keyof typeof BUILTIN_SUBAGENT_IDENTITIES]["agentType"]

const BUILTIN_IDENTITY_BY_AGENT_TYPE = new Map<string, BuiltInSubagentIdentity>(
  Object.values(BUILTIN_SUBAGENT_IDENTITIES).map((identity) => [
    identity.agentType,
    identity,
  ])
)

/** Resolve an exact runtime built-in identity. No aliases are accepted. */
export function resolveBuiltInSubagentIdentity(
  agentType: string
): BuiltInSubagentIdentity | undefined {
  return BUILTIN_IDENTITY_BY_AGENT_TYPE.get(agentType)
}

/**
 * Project an exact runtime built-in identity into the Cursor `SubagentType`
 * message.  `undefined` deliberately means the caller must emit `custom`;
 * it must not infer a runtime owner from an unrelated protocol field name.
 */
export function projectBuiltInSubagentIdentityToProto(agentType: string) {
  const identity = resolveBuiltInSubagentIdentity(agentType)
  if (!identity) return undefined

  switch (identity.protoCase) {
    case "unspecified":
      return create(SubagentTypeSchema, {
        type: {
          case: "unspecified" as const,
          value: create(SubagentTypeUnspecifiedSchema, {}),
        },
      })
    case "explore":
      return create(SubagentTypeSchema, {
        type: {
          case: "explore" as const,
          value: create(SubagentTypeExploreSchema, {}),
        },
      })
    case "browserUse":
      return create(SubagentTypeSchema, {
        type: {
          case: "browserUse" as const,
          value: create(SubagentTypeBrowserUseSchema, {}),
        },
      })
    case "bash":
      return create(SubagentTypeSchema, {
        type: {
          case: "bash" as const,
          value: create(SubagentTypeBashSchema, {}),
        },
      })
    case "custom":
      return create(SubagentTypeSchema, {
        type: {
          case: "custom" as const,
          value: create(SubagentTypeCustomSchema, {
            name: identity.agentType,
          }),
        },
      })
    default: {
      const _exhaustive: never = identity.protoCase
      throw new Error(
        `Unsupported built-in sub-agent proto case: ${String(_exhaustive)}`
      )
    }
  }
}
