/**
 * Subagent definition types for the Cursor protocol bridge.
 *
 * Mirrors claude-code's `AgentDefinition` model (packages/builtin-tools/src/
 * tools/AgentTool/loadAgentsDir.ts) so the subagent surface mirrors what
 * Cursor / claude-code users already understand: built-in agents declared
 * in code, custom agents declared as `.cursor/agents/*.md` markdown files
 * with YAML frontmatter, plus an explicit tool allowlist / denylist that
 * is resolved at spawn time.
 *
 * Why we mirror claude-code rather than invent our own model:
 *   - The frontmatter shape (`name`, `description`, `tools`,
 *     `disallowedTools`, `model`, `maxTurns`) is what Cursor users already
 *     write today. Re-using the same fields means an `~/.cursor/agents/*.md`
 *     file works whether the user is on plain Cursor or through the bridge.
 *   - Resolving tools per-agent at spawn time (instead of a hard-coded list
 *     applied to every sub-agent) is what enables a `read-only research`
 *     agent and a `code-mod` agent to differ — claude-code's
 *     `resolveAgentTools()` is exactly this mechanism.
 *
 * The bridge distinguishes foreground and detached execution. Foreground
 * sub-agents can use the Exec bridge where the IDE owns the result path;
 * detached workers receive only tools whose complete execution is owned by
 * the bridge itself. The mode-specific decision is centralized in
 * `subagent-tool-resolver.ts`, not inferred from an agent name.
 */

import type { BuiltInSubagentType } from "./subagent-identity"

export type SubagentSource = "built-in" | "user" | "project"

export interface BaseSubagentDefinition {
  /** Stable identifier the model uses as `subagent_type` in `task` calls. */
  agentType: string

  /** Short human-friendly description shown in the `task` tool prompt to
   * help the model choose the right subagent. Mirrors claude-code's
   * `whenToUse` field. */
  whenToUse: string

  /** Optional allowlist of user-facing tool names (e.g. "semantic_search",
   * "web_fetch"). When omitted or set to ["*"], the sub-agent gets every
   * tool the bridge marks as `subagent-safe` (see
   * `subagent-tool-resolver.ts`). */
  tools?: string[]

  /** Optional denylist applied AFTER the allowlist. Use this to subtract a
   * tool from a wildcard surface ("*" minus "web_fetch" for an offline
   * agent, for example). */
  disallowedTools?: string[]

  /** Parent-mounted MCP servers whose concrete tools may be inherited when
   * `tools` contains `mcp_tool`. Omitted means every mounted MCP server, which
   * matches Claude Code's normal parent-tool inheritance. Cursor built-ins
   * with a protocol-defined capability boundary use an exact server allowlist
   * so unrelated MCP tools cannot enter the child contract. */
  inheritedMcpServers?: string[]

  /** MCP server name patterns that must be mounted for this agent to be
   * advertised. Every pattern must match at least one mounted server name,
   * case-insensitively, matching Claude Code's `requiredMcpServers` field. */
  requiredMcpServers?: string[]

  /** Optional per-agent max turn override. When omitted the agent remains
   * unbounded until it reaches a normal terminal state or is cancelled. */
  maxTurns?: number

  /** Optional model override. Special value `"inherit"` means use the
   * parent session's model. Anything else is treated as a model id and
   * routed by ModelRouterService like a top-level chat. */
  model?: string

  /** Where the definition came from — used purely for logging / debug. */
  source: SubagentSource
}

export interface BuiltInSubagentDefinition extends BaseSubagentDefinition {
  /** Built-ins may only use an identity declared in subagent-identity.ts. */
  agentType: BuiltInSubagentType
  source: "built-in"
  /** Built-in agents compute their system prompt at spawn time so they can
   * react to runtime configuration (model selection, embedded search tools,
   * etc.) the same way claude-code's built-ins do. */
  getSystemPrompt: () => string
}

export interface CustomSubagentDefinition extends BaseSubagentDefinition {
  source: "user" | "project"
  /** Absolute path of the markdown file the definition was loaded from. */
  filePath: string
  /** Static system prompt taken verbatim from the markdown body. */
  systemPrompt: string
}

export type SubagentDefinition =
  | BuiltInSubagentDefinition
  | CustomSubagentDefinition

export function isBuiltInSubagent(
  definition: SubagentDefinition
): definition is BuiltInSubagentDefinition {
  return definition.source === "built-in"
}

export function isCustomSubagent(
  definition: SubagentDefinition
): definition is CustomSubagentDefinition {
  return definition.source === "user" || definition.source === "project"
}

/**
 * Resolve a subagent's effective system prompt regardless of whether it is
 * built-in (closure-driven) or custom (markdown body). Centralised here so
 * callers don't need to know the source variant.
 */
export function getSubagentSystemPrompt(
  definition: SubagentDefinition
): string {
  if (isBuiltInSubagent(definition)) {
    return definition.getSystemPrompt()
  }
  return definition.systemPrompt
}

/** Match Claude Code's requiredMcpServers availability rule. Requirement
 * entries are case-insensitive server-name patterns; every pattern must match
 * at least one mounted provider or IDE registry name. */
export function hasRequiredSubagentMcpServers(
  definition: Pick<SubagentDefinition, "requiredMcpServers">,
  availableServerNames: readonly string[]
): boolean {
  if (!definition.requiredMcpServers?.length) return true
  const available = availableServerNames.map((name) => name.toLowerCase())
  return definition.requiredMcpServers.every((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase()
    return (
      pattern.length > 0 && available.some((name) => name.includes(pattern))
    )
  })
}
