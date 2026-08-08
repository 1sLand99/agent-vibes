/**
 * Tool defer-loading policy.
 *
 * Decides which Cursor tools are sent to the upstream with their full
 * `description` + `input_schema` payload (the **core surface**) and which
 * are downgraded to a one-line entry in the system prompt catalog (the
 * **deferred surface**).  Deferred tools are not advertised to the model
 * as callable; the model must first call `discover_tool({ tool_name })`
 * to retrieve the full schema, after which the bridge promotes the tool
 * back into the core surface for subsequent turns of the same session.
 *
 * Why this lives in the cursor protocol layer (and not a per-backend
 * translator):
 *   - Every upstream — kiro / anthropic / google-claude / codex /
 *     openai-compat / claude-api — sees the same already-trimmed tool
 *     list.  Down-stream translators are unchanged; they keep formatting
 *     "the N tools handed to them" into their target wire shape.
 *   - The `discover_tool` mechanism is fully bridge-internal: the
 *     upstream models see it as just another tool whose result is some
 *     JSON schema text.  No protocol extension is required on any
 *     upstream.
 *
 * Backend-specific tuning lives in `pickStrategy()` so we can be more
 * aggressive on backends that do not support prompt-cache hits (kiro,
 * google-claude) and more conservative on backends that do (anthropic
 * firstParty's own cache mechanism is more efficient than defer when it
 * actually serves cache_read).
 */

import type { BackendType } from "../../../llm/shared/model-router.service"

/**
 * Bridge-internal tool name. Always sent as core (never deferred). The
 * model calls it to fetch the full schema of a deferred tool.
 *
 * Defined as a constant (not imported from `discover-tool-handler`) to
 * avoid a circular dependency between policy and handler.
 */
export const DISCOVER_TOOL_NAME = "discover_tool"
export const CODEX_TOOL_SEARCH_NAME = "tool_search"

export function isBridgeInternalToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase()
  if (!normalized) return false
  const compact = normalized.replace(/[^a-z0-9]/g, "")
  const discoverCompact = DISCOVER_TOOL_NAME.replace(/[^a-z0-9]/g, "")
  const toolSearchCompact = CODEX_TOOL_SEARCH_NAME.replace(/[^a-z0-9]/g, "")
  return (
    normalized === DISCOVER_TOOL_NAME ||
    compact === discoverCompact ||
    normalized === CODEX_TOOL_SEARCH_NAME ||
    compact === toolSearchCompact
  )
}

/**
 * Curated set of always-loaded tools.  Mirrors claude-code's `CORE_TOOLS`
 * intent: file read/write/search, shell, plan/todo, sub-agent, basic
 * web — the operations a model will reach for in the *first* response
 * of almost every coding task.
 *
 * Selection criteria:
 *   - High call frequency across realistic agent traces (≥ 5% of turns).
 *   - Cheap to keep (description + schema < ~500 tokens).
 *   - Required for the model's first plan-step (e.g. `read_file`,
 *     `grep_search`) so the model does not get stuck doing a pointless
 *     `discover_tool` round-trip on its very first action.
 *
 * Tools NOT in this set are eligible for deferral.  A few notable
 * exclusions and the reason:
 *   - `task` / `task_v2` / `await_task` — kept here because the
 *     description carries the dynamically-built sub-agent registry;
 *     deferring would force the model to discover before it knows what
 *     `subagent_type` values are even possible.
 *   - `web_search` / `web_fetch` — kept; described as a single sentence
 *     each and used in nontrivial fraction of debugging turns.
 *
 * Names here are the post-translation user-facing names returned by
 * `cursor-tool-mapper.ts`'s `CURSOR_TOOL_DEFINITIONS[*].name`, NOT the
 * `CLIENT_SIDE_TOOL_V2_*` proto identifiers.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // ── File I/O ──────────────────────────────────────────────
  "read_file",
  "list_directory",
  "edit_file",
  "edit_file_v2",
  "delete_file",
  "file_search",
  "glob_search",
  "grep_search",
  // ── Shell / execution ─────────────────────────────────────
  "run_terminal_command",
  "exec_command",
  "background_shell_spawn",
  "write_shell_stdin",
  "write_stdin",
  "apply_patch",
  // ── Planning / todos ──────────────────────────────────────
  "create_plan",
  "update_plan",
  "create_goal",
  "update_goal",
  "read_todos",
  "update_todos",
  // ── User interaction ──────────────────────────────────────
  "ask_question",
  // ── Sub-agent / await ─────────────────────────────────────
  "task",
  "await_task",
  "kill_agent",
  // ── Lightweight web ───────────────────────────────────────
  "web_search",
  "web_fetch",
  // ── Bridge-internal tool (always present when defer is on)
  DISCOVER_TOOL_NAME,
  // ── Codex-native dynamic tool discovery
  CODEX_TOOL_SEARCH_NAME,
])

/**
 * Defer policy strategies.  The level controls which non-core tools are
 * downgraded to deferred-catalog entries:
 *   - "off"        — every tool keeps its full schema (no defer).
 *   - "mcp-only"   — only MCP tools (anything that didn't come from the
 *                    static `CURSOR_TOOL_DEFINITIONS` table) are deferred.
 *                    This is the safest non-zero level: the user opted in
 *                    to those MCP servers, so they *might* be called, but
 *                    we don't know which ones for a given turn.
 *   - "aggressive" — everything outside CORE_TOOL_NAMES is deferred.
 *                    Maximum savings, mild risk that the model needs an
 *                    extra `discover_tool` round-trip for less common
 *                    built-ins (e.g. `search_symbols`, `fetch_rules`).
 */
export type DeferStrategy = "off" | "mcp-only" | "aggressive"

/**
 * Pick a defer strategy for the given backend.
 *
 * Rationale:
 *   - kiro: no observable prompt cache (we verified empirically that
 *     `cacheReadInputTokens` is never returned).  Aggressive defer is
 *     pure win.
 *   - google-claude: similar — no Anthropic-style cache passthrough.
 *   - codex / openai-compat: smaller context windows, defer harder.
 *   - claude-api (firstParty Anthropic): real prompt cache exists; we
 *     rely on `applyPromptCachingOptimizations()` to keep prefix stable
 *     and reuse cache.  Defer would *invalidate* the cache by changing
 *     the tools array between turns as the model discovers more tools.
 *     Stay off here.
 *   - google: not Claude, but Gemini still benefits from smaller prompts.
 *     Use mcp-only as a moderate default.
 */
export function pickStrategy(backend: BackendType): DeferStrategy {
  switch (backend) {
    case "kiro":
    case "google-claude":
      return "aggressive"
    case "codex":
    case "openai-compat":
      return "aggressive"
    case "google":
      return "mcp-only"
    case "claude-api":
      // Anthropic firstParty has a real prompt cache; defer would churn
      // the prefix as the model discovers tools. Better to keep tools
      // stable and let applyPromptCachingOptimizations() do its job.
      return "off"
    default:
      return "mcp-only"
  }
}

/**
 * Decision input: a tool definition we are about to send to the upstream.
 * We only need the user-facing name and a flag telling us whether it came
 * from the static built-in table or from MCP discovery.
 */
export interface DeferDecisionInput {
  name: string
  /**
   * True when this tool came from the fixed `CURSOR_TOOL_DEFINITIONS`
   * table (i.e. a Cursor built-in).  False when it came from MCP server
   * discovery.  The cursor-tool-mapper exposes both kinds in the same
   * `ToolDefinition[]` so we need a flag.
   */
  isBuiltIn: boolean
}

/**
 * Should this tool be deferred (downgraded to a catalog entry) under the
 * given strategy?  Tools whose name appears in `discoveredTools` are
 * always restored to core, regardless of strategy.
 */
export function shouldDeferTool(
  tool: DeferDecisionInput,
  strategy: DeferStrategy,
  discoveredTools: ReadonlySet<string>
): boolean {
  if (strategy === "off") return false
  if (CORE_TOOL_NAMES.has(tool.name)) return false
  if (discoveredTools.has(tool.name)) return false
  if (strategy === "mcp-only") {
    return !tool.isBuiltIn
  }
  // aggressive
  return true
}
