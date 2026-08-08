/**
 * Cursor Tool Definition Mapper
 * Maps Cursor's CLIENT_SIDE_TOOL_V2_* tools to Anthropic tool format
 * for sending to backend API, and handles tool call responses
 */

import { DISCOVER_TOOL_DEFINITION } from "./discover-tool-handler"
import { SNIP_MESSAGES_TOOL_DEFINITION } from "./snip-tool-handler"
import { CODEX_TOOL_SEARCH_NAME, shouldDeferTool } from "./tool-defer-policy"
import type { ProjectionProvider } from "../session/projection-owner"
import { normalizeMcpToolInputSchema } from "./mcp-call-contract"
import { CURSOR_MODEL_CALLABLE_DEFINITION_KEYS } from "./cursor-tool-runtime-contract"

// Tool definition in Anthropic format
export interface AnthropicTool {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    oneOf?: Array<Record<string, unknown>>
    additionalProperties?: boolean
  }
}

/** Exact agent.v1.GrepArgs surface for regular Cursor grep execution. */
const CURSOR_GREP_INPUT_SCHEMA: AnthropicTool["input_schema"] = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Ripgrep pattern. Regex semantics are preserved by Cursor.",
    },
    path: { type: "string", description: "Optional search root." },
    glob: { type: "string", description: "Optional ripgrep glob filter." },
    output_mode: {
      type: "string",
      description:
        "Cursor output mode, for example content, files_with_matches, or count.",
    },
    context_before: { type: "number", description: "Lines before each match." },
    context_after: { type: "number", description: "Lines after each match." },
    context: {
      type: "number",
      description: "Lines before and after each match.",
    },
    case_insensitive: {
      type: "boolean",
      description: "Enable case-insensitive matching.",
    },
    type: { type: "string", description: "Optional ripgrep file type." },
    head_limit: { type: "number", description: "Maximum result count." },
    multiline: { type: "boolean", description: "Enable multiline matching." },
    sort: { type: "string", description: "Optional Cursor/ripgrep sort key." },
    sort_ascending: {
      type: "boolean",
      description: "Sort ascending when a sort key is supplied.",
    },
    offset: {
      type: "number",
      description: "Number of results to skip before returning results.",
    },
    sandbox_policy: {
      type: "object",
      description:
        "Optional Cursor SandboxPolicy forwarded to the official GrepArgs envelope.",
    },
  },
  required: ["pattern"],
}

/**
 * `task` and `task_v2` have the same detached-execution semantics. Keep the
 * input contract in one place so one protocol generation cannot drift into a
 * different background capability claim.
 */
const BACKGROUND_TASK_INPUT_DESCRIPTION =
  "When true, the sub-agent runs asynchronously: the tool call returns " +
  "immediately with an `agentId` and the user can keep chatting while the " +
  "sub-agent works. Use `await_task` with that agentId to read the durable " +
  "terminal result. Background execution receives only the detached tool " +
  "surface listed for the selected `subagent_type` in this tool's " +
  "description; do not assume foreground-only tools carry over. Default " +
  "false (foreground, blocks until the sub-agent finishes and returns its " +
  "result inline)."

// Mapping of Cursor tool names to Anthropic tool definitions
const CURSOR_TOOL_DEFINITIONS: Record<string, AnthropicTool> = {
  CLIENT_SIDE_TOOL_V2_READ_FILE: {
    name: "read_file",
    description:
      "Read the contents of a file at the specified path. Prefer this tool over run_terminal_command for file inspection. Do not use cat, sed, head, tail, or similar shell commands when read_file can express the request. CRITICAL: This tool ONLY works on files. If the path is a directory, using this tool will cause a crash. Use list_directory for directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path to the file to read (MUST be a file, not a directory)",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_FILE_V2: {
    name: "read_file",
    description:
      "Read the contents of a file at the specified path. Prefer this tool over run_terminal_command for file inspection. Do not use cat, sed, head, tail, or similar shell commands when read_file can express the request. CRITICAL: This tool ONLY works on files. If the path is a directory, using this tool will cause a crash. Use list_directory for directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path to the file to read (MUST be a file, not a directory)",
        },
        start_line: { type: "number", description: "Start line (1-indexed)" },
        end_line: { type: "number", description: "End line (1-indexed)" },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_DIR: {
    name: "list_directory",
    description:
      "List the contents of a directory. Prefer this tool over run_terminal_command with ls, find, or similar shell commands when you need workspace file/directory discovery.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: {
    name: "list_directory",
    description:
      "List the contents of a directory. Prefer this tool over run_terminal_command with ls, find, or similar shell commands when you need workspace file/directory discovery.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the directory to list",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively",
        },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EDIT_FILE: {
    name: "edit_file",
    description:
      "Edit a file by applying changes. Before editing, read the file in the current conversation. Copy the existing text verbatim from read_file output, excluding any display-only line number prefixes. Prefer a small unique old_text snippet instead of large blocks of surrounding context.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to edit" },
        old_text: { type: "string", description: "The text to replace" },
        new_text: { type: "string", description: "The replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },

  CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: {
    name: "edit_file_v2",
    description:
      "Edit a file with exact search and replace. Before editing an existing file, read the file in the current conversation. Prefer a small unique search snippet copied verbatim from read_file output. To create a new file, set search to an empty string and replace to the full file content. If read_file output includes display-only line number prefixes, do not include those prefixes in search or replace. Prefer this tool over run_terminal_command with cat heredoc, tee, echo redirection, sed, perl, python, or shell patching for normal file creation or edits — those still work for ephemeral paths or scripted setup, but edit_file_v2 keeps the diff reviewable in the IDE. The edit FAILS if `search` matches more than once in the file: either provide a larger snippet with surrounding context to make it unique, or set `replace_all: true` to change every occurrence (useful for variable renames or batch alias updates). Treat consecutive edits to the same file as dependent: chain them sequentially (waiting for each result before the next call) instead of emitting parallel `edit_file_v2` calls against the same path, since each edit's `search` snippet must match the post-edit state of the file. Edits to different files remain safe to run in parallel. Efficiency — avoid over-cautious churn: a successful edit already confirms the file's new state, so do NOT re-read (read_file) or re-search (grep_search) the same file just to re-verify before your next edit; trust the result and proceed. Plan all changes to a file from a single read and apply them as one sequential pass of edits. To remove a large contiguous block, delete it in ONE edit (the whole block as search, empty replace) rather than many small chunked deletions. Re-read or re-grep a file only when an edit actually fails (search no longer matches) or the file changed outside this turn.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to edit" },
        search: { type: "string", description: "The text to search for" },
        replace: { type: "string", description: "The replacement text" },
        replace_all: {
          type: "boolean",
          description:
            "When true, replaces every occurrence of `search` instead of failing on multi-match. Default false. Use for variable renames or batch alias updates.",
        },
      },
      required: ["path", "search", "replace"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FILE_SEARCH: {
    name: "file_search",
    description:
      "Search for files by name pattern. Prefer this tool over run_terminal_command with find or ls for file discovery when the task is to locate files rather than execute shell logic.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query or pattern" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: {
    name: "glob_search",
    description:
      "Search for files using glob patterns. Prefer this tool over run_terminal_command with find or ls for file discovery when glob matching is sufficient.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match" },
      },
      required: ["pattern"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: {
    name: "grep_search",
    description:
      "Search repository contents through Cursor's regular GrepArgs protocol. Preserve the requested ripgrep pattern, filtering, context, ordering and pagination fields exactly.",
    input_schema: CURSOR_GREP_INPUT_SCHEMA,
  },

  CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: {
    name: "grep_search",
    description:
      "Search repository contents through Cursor's regular GrepArgs protocol. Preserve the requested ripgrep pattern, filtering, context, ordering and pagination fields exactly.",
    input_schema: CURSOR_GREP_INPUT_SCHEMA,
  },

  CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: {
    name: "semantic_search",
    description:
      "Find code by intent across the indexed codebase. Use for content " +
      "questions ('where is heartbeat handled?'). Returns candidate file " +
      "paths and snippets — pair with read_semsearch_files to read full " +
      "context for the most promising candidates. For exact-text or path " +
      "patterns prefer grep_search / glob_search instead.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The semantic search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: {
    name: "run_terminal_command",
    description:
      "Run a command in the terminal. Prefer dedicated tools (grep_search, read_file, list_directory, edit_file_v2, etc.) when one fits the task — they keep output structured and reviewable. Use run_terminal_command for build/test execution, system commands, scripts that compute or verify something, or work that no structured tool can express. Shell file writes whose targets land inside the workspace are blocked by the bridge; ephemeral paths (/tmp, smoke fixtures, OS temp dirs) and read-only commands run normally.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        cwd: {
          type: "string",
          description: "Working directory for the command",
        },
      },
      required: ["command"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DELETE_FILE: {
    name: "delete_file",
    description: "Delete a file at the specified path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path to the file to delete" },
      },
      required: ["path"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WEB_SEARCH: {
    name: "web_search",
    description:
      "Search the web for information. The bridge picks one adapter " +
      "per session (build-time selection) based on the active backend: " +
      "Google grounding for Gemini sessions, the Anthropic " +
      "`web_search_20250305` server tool for Claude API sessions, " +
      "OpenAI Responses API web_search for official Codex sessions, " +
      "Exa MCP for OpenAI-compatible/reverse endpoints, " +
      "and a keyless chain (Brave LLM Context if API key configured, " +
      "else Exa MCP, else DuckDuckGo HTML scrape) for backends without " +
      "first-party search. There is no error-time fallback — if the " +
      "selected adapter fails, the tool fails and the agent decides " +
      "whether to retry, switch to web_fetch, or give up. Set the " +
      "`WEB_SEARCH_ADAPTER` env to override selection " +
      "(google-grounding | anthropic-server-tool | codex-server-tool " +
      "| exa-mcp | brave-llm | duckduckgo-html).",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query.",
        },
        domain: {
          type: "string",
          description:
            "Optional domain restriction; folded into the query as a " +
            "`site:` filter when present.",
        },
        allowed_domains: {
          type: "array",
          items: { type: "string" },
          description:
            "Only include search results from these domains. Mutually " +
            "exclusive with `blocked_domains`. Each entry is matched " +
            "against the result hostname as either an exact match or a " +
            "suffix match (`example.com` matches `foo.example.com`).",
        },
        blocked_domains: {
          type: "array",
          items: { type: "string" },
          description:
            "Never include search results from these domains. Mutually " +
            "exclusive with `allowed_domains`. Same matching rules as " +
            "`allowed_domains`.",
        },
        num_results: {
          type: "number",
          description:
            "Number of search results to return. Default 8. Adapters " +
            "treat this as a soft cap — they may return fewer if the " +
            "upstream returned fewer hits.",
        },
        livecrawl: {
          type: "string",
          enum: ["fallback", "preferred"],
          description:
            "Live-crawl mode for adapters that support cached vs live " +
            "results (Exa, Brave). `fallback` (default) uses cached " +
            "content unless missing; `preferred` always live-crawls.",
        },
        search_type: {
          type: "string",
          enum: ["auto", "fast", "deep"],
          description:
            "Search depth hint for adapters that support multiple " +
            "modes (Exa). `auto` (default) is balanced, `fast` " +
            "prioritizes latency, `deep` prioritizes coverage.",
        },
        context_max_characters: {
          type: "number",
          description:
            "Soft cap on the LLM-context character budget. Adapters " +
            "use this to size per-result snippet budgets. Default " +
            "10000.",
        },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WEB_FETCH: {
    name: "web_fetch",
    description: "Fetch and summarize content from a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CREATE_PLAN: {
    name: "create_plan",
    description:
      "Create a persisted implementation-plan document in Cursor. " +
      "Use this only when the user explicitly asks to create or open " +
      "a plan document; do not call it by default for ordinary task " +
      "tracking, internal planning, or TODO status updates because it " +
      "opens a dedicated plan view in the IDE. Maps to Cursor's " +
      "`agent.v1.CreatePlanArgs` proto message. The plan can be a " +
      "simple linear list (use `steps`) or a richer document with a " +
      "narrative body (`plan`), an `overview`, scoped `todos`, and " +
      "named `phases` that group related todos. The IDE persists the " +
      "result to a `plan_uri` in `~/.cursor/`.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Plan title (also used as the proto `name` field — it is " +
            "what the IDE shows in the plan sidebar and uses to name " +
            "the persisted plan file).",
        },
        name: {
          type: "string",
          description:
            "Optional explicit plan name. Falls back to `title` when " +
            "omitted; usually you only want to set one of them.",
        },
        steps: {
          type: "array",
          description:
            "Linear list of step strings. The bridge converts each " +
            "string into a TodoItem with status=pending. Use `todos` " +
            "instead when you need explicit ids, dependencies, or " +
            "non-pending initial status.",
          items: { type: "string" },
        },
        plan: {
          type: "string",
          description:
            "Optional plan body in Markdown. Renders as the main plan " +
            "document the user reads in the IDE. Leave empty to fall " +
            "back to `overview` or `title`.",
        },
        overview: {
          type: "string",
          description:
            "Short one-paragraph plan overview surfaced near the top " +
            "of the plan view.",
        },
        is_project: {
          type: "boolean",
          description:
            "When true, the plan is registered as a project-level " +
            "plan (persisted to the workspace's plan registry). " +
            "Default false (ephemeral / smoke / tooling plans).",
        },
        todos: {
          type: "array",
          description:
            "Optional explicit TodoItem list. Each item supports the " +
            "same shape as `update_todos` (id / content / status / " +
            "dependencies / createdAt / updatedAt). When provided, " +
            "this fully replaces what would have been generated from " +
            "`steps`. Status enum: pending / in_progress / completed " +
            "/ cancelled.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable todo id." },
              content: {
                type: "string",
                description: "Human-readable todo text.",
              },
              status: {
                type: "string",
                description:
                  "Todo status enum (pending / in_progress / " +
                  "completed / cancelled).",
              },
              dependencies: {
                type: "array",
                description: "Optional upstream todo ids this depends on.",
                items: { type: "string" },
              },
              createdAt: {
                type: "string",
                description: "Optional creation timestamp (unix ms).",
              },
              updatedAt: {
                type: "string",
                description: "Optional update timestamp (unix ms).",
              },
            },
            required: ["id", "content", "status"],
          },
        },
        phases: {
          type: "array",
          description:
            "Optional list of phases. Each phase has a `name` and " +
            "its own scoped `todos[]` (same TodoItem shape as the " +
            "top-level `todos`). Use phases when the plan splits " +
            "into clear stages (e.g. `Discovery` / `Implementation` " +
            "/ `Verification`); the IDE renders each phase as a " +
            "separate section.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Phase name." },
              todos: {
                type: "array",
                description: "Todos scoped to this phase.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string" },
                    dependencies: {
                      type: "array",
                      items: { type: "string" },
                    },
                    createdAt: { type: "string" },
                    updatedAt: { type: "string" },
                  },
                  required: ["id", "content", "status"],
                },
              },
            },
            required: ["name"],
          },
        },
      },
      required: ["title"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TASK: {
    name: "task",
    description:
      "Delegate a focused sub-task to a specialised sub-agent that runs " +
      "in its own isolated context. The sub-agent returns a single final " +
      "message; you must relay a concise summary to the user since the " +
      "sub-agent's intermediate output is not visible to them.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "3-5 word label shown in the UI bubble while the sub-agent runs.",
        },
        prompt: {
          type: "string",
          description:
            "The detailed brief you give the sub-agent. Treat the " +
            "sub-agent like a colleague with no prior context: state the " +
            "goal, what's already known/ruled out, and the deliverable. " +
            "Avoid one-liner prompts — they produce shallow output.",
        },
        model: {
          type: "string",
          description:
            "Optional Cursor-approved model override. Omit to inherit the " +
            "configured parent/sub-agent model. Never invent a model id.",
        },
        subagent_type: {
          type: "string",
          description:
            "Pick from the available `subagent_type` values listed in " +
            "this tool's description. Omit to use 'general-purpose'. " +
            "If provided, it must match one listed value exactly.",
        },
        run_in_background: {
          type: "boolean",
          description: BACKGROUND_TASK_INPUT_DESCRIPTION,
        },
      },
      required: ["description", "prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TASK_V2: {
    name: "task",
    description:
      "Delegate a focused sub-task to a specialised sub-agent that runs " +
      "in its own isolated context. The sub-agent returns a single final " +
      "message; you must relay a concise summary to the user since the " +
      "sub-agent's intermediate output is not visible to them.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "3-5 word label shown in the UI bubble while the sub-agent runs.",
        },
        prompt: {
          type: "string",
          description:
            "The detailed brief you give the sub-agent. Treat the " +
            "sub-agent like a colleague with no prior context: state the " +
            "goal, what's already known/ruled out, and the deliverable. " +
            "Avoid one-liner prompts — they produce shallow output.",
        },
        model: {
          type: "string",
          description:
            "Optional Cursor-approved model override. Omit to inherit the " +
            "configured parent/sub-agent model. Never invent a model id.",
        },
        subagent_type: {
          type: "string",
          description:
            "Pick from the available `subagent_type` values listed in " +
            "this tool's description. Omit to use 'general-purpose'. " +
            "If provided, it must match one listed value exactly.",
        },
        run_in_background: {
          type: "boolean",
          description: BACKGROUND_TASK_INPUT_DESCRIPTION,
        },
      },
      required: ["description", "prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_TODO_READ: {
    name: "read_todos",
    description: "Read current todo items and optional filtered subsets",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "array",
          description:
            "Optional todo status filter (pending/in_progress/completed/cancelled)",
          items: { type: "string" },
        },
        id_filter: {
          type: "array",
          description: "Optional todo id filter",
          items: { type: "string" },
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_TODO_WRITE: {
    name: "update_todos",
    description: "Update todo items, optionally merging into current list",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Todo objects to write",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable todo id",
              },
              content: {
                type: "string",
                description: "Human-readable todo text",
              },
              status: {
                type: "string",
                description:
                  "Todo status enum (TODO_STATUS_PENDING/IN_PROGRESS/COMPLETED/CANCELLED)",
              },
              dependencies: {
                type: "array",
                description: "Optional upstream todo ids",
                items: { type: "string" },
              },
              createdAt: {
                type: "string",
                description: "Optional creation timestamp (unix ms)",
              },
              updatedAt: {
                type: "string",
                description: "Optional update timestamp (unix ms)",
              },
            },
            required: ["id", "content", "status"],
          },
        },
        merge: {
          type: "boolean",
          description: "Whether to merge with existing todos",
        },
      },
      required: ["todos"],
    },
  },

  CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: {
    name: "deep_search",
    description:
      "Like semantic_search but spends more compute on harder queries. " +
      "Returns candidate file paths and snippets — pair with " +
      "read_semsearch_files for full content. Prefer semantic_search for " +
      "first-pass exploration; use deep_search only when semantic_search " +
      "comes back empty or too noisy.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The deep search query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: {
    name: "read_semsearch_files",
    description:
      "Read full context for files returned by semantic_search or " +
      "deep_search. Pass the candidate paths from those calls (not " +
      "arbitrary paths) so the indexer can stream cached snippets " +
      "efficiently. For arbitrary file paths use read_file instead.",
    input_schema: {
      type: "object",
      properties: {
        file_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Candidate file paths returned by a prior semantic_search " +
            "or deep_search call",
        },
      },
      required: ["file_paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_REAPPLY: {
    name: "reapply",
    description: "Reapply a previously suggested patch or diff",
    input_schema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Patch content to reapply" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH_RULES: {
    name: "fetch_rules",
    description:
      "Fetch active project/agent rules, or load a specific Cursor skill by name",
    input_schema: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description:
            "Optional Cursor skill name to activate and load, such as canvas",
        },
        query: {
          type: "string",
          description:
            "Optional natural-language task description; when provided, the proxy ranks available skills by relevance using a lightweight TF-IDF index and returns the top hits in `search_hits` for discovery purposes",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: {
    name: "search_symbols",
    description: "Search symbols in workspace index",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: {
    name: "background_composer_followup",
    description: "Submit a follow-up message to a background composer task",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Follow-up user message" },
      },
      required: ["message"],
    },
  },

  CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: {
    name: "knowledge_base",
    description: "Query knowledge base for supporting information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Knowledge base query" },
      },
      required: ["query"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: {
    name: "fetch_pull_request",
    description: "Fetch pull request metadata/content by URL or identifier",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Pull request URL" },
        id: { type: "string", description: "Optional pull request identifier" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: {
    name: "create_diagram",
    description:
      "Create an architecture or flow diagram from text instructions",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Diagram creation prompt" },
      },
      required: ["prompt"],
    },
  },

  CLIENT_SIDE_TOOL_V2_FIX_LINTS: {
    name: "fix_lints",
    description: "Apply automatic lint fixes for targeted files",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to lint-fix",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: {
    name: "go_to_definition",
    description: "Resolve symbol definition location",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name or token" },
        path: { type: "string", description: "Optional current file path" },
      },
      required: ["symbol"],
    },
  },

  CLIENT_SIDE_TOOL_V2_AWAIT_TASK: {
    name: "await_task",
    description:
      "Wait for a previously spawned background sub-agent (run_in_background=true) " +
      "to finish. Pass the agentId returned by the original `task` tool call. " +
      "Resolves when the sub-agent completes or fails; if it is still running " +
      "after the optional `block_until_ms` window, returns the still-running " +
      "state so the parent agent can decide whether to wait again.",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The agentId returned by the spawning task tool call.",
        },
        block_until_ms: {
          type: "number",
          description:
            "How long (ms) to block before reporting still-running. " +
            "Defaults to 5 minutes; capped at 30 minutes.",
        },
      },
      required: ["task_id"],
    },
  },

  // bridge-internal definition: there is no ClientSideToolV2 enum value
  // for kill_agent because the proto only exposes CancelSubagentAction
  // (a ConversationAction, not a ToolCall oneof). We surface it as a
  // bridge-defined inline tool so the parent agent can stop a
  // run-away background sub-agent on demand.
  BRIDGE_KILL_AGENT: {
    name: "kill_agent",
    description:
      "Stop a previously spawned sub-agent. Pass the agentId returned by " +
      "the original task tool call, then use await_task to read its durable " +
      "terminal status.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The agentId of the background sub-agent to kill.",
        },
      },
      required: ["agent_id"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_PROJECT: {
    name: "read_project",
    description: "Read project-level settings and metadata",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Optional project key selector" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: {
    name: "update_project",
    description: "Update project-level settings and metadata",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Project key to update" },
        value: { type: "string", description: "Value to set" },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_MCP: {
    name: "mcp_tool",
    description: "Call a Model Context Protocol tool",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "MCP server name" },
        tool_name: { type: "string", description: "Tool name to call" },
        arguments: { type: "object", description: "Tool arguments" },
      },
      required: ["server_name", "tool_name"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: {
    name: "mcp_tool",
    description: "Call a Model Context Protocol tool",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "MCP server name" },
        tool_name: { type: "string", description: "Tool name to call" },
        arguments: { type: "object", description: "Tool arguments" },
      },
      required: ["server_name", "tool_name"],
    },
  },

  AGENT_V1_DIAGNOSTICS: {
    name: "read_lints",
    description:
      "Read lint/diagnostic warnings and errors for files. Paths must be inside the active workspace root — the IDE rejects paths outside the workspace with `path is outside workspace root`. Use absolute paths under the project, or workspace-relative paths (the bridge resolves them against the active project root). Use full file paths, not directories.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths to check for diagnostics. Must be inside the workspace root.",
        },
      },
      required: ["paths"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_LINTS: {
    name: "read_lints",
    description:
      "Read lint/diagnostic warnings and errors for files. Paths must be inside the active workspace root — the IDE rejects paths outside the workspace with `path is outside workspace root`. Use absolute paths under the project, or workspace-relative paths (the bridge resolves them against the active project root). Use full file paths, not directories.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths to check for diagnostics. Must be inside the workspace root.",
        },
      },
      required: ["paths"],
    },
  },

  AGENT_V1_ASK_FOLLOWUP_QUESTION: {
    name: "ask_question",
    description: "Ask a follow-up question to the user",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        title: { type: "string", description: "Question panel title" },
        questions: {
          type: "array",
          description: "Structured question list for interactive UI selection",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Question identifier" },
              prompt: { type: "string", description: "Question prompt text" },
              options: {
                type: "array",
                description: "Selectable options for this question",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option identifier" },
                    label: { type: "string", description: "Option label" },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting multiple options",
              },
            },
            required: ["prompt"],
          },
        },
        run_async: {
          type: "boolean",
          description:
            "When true, the native AskQuestion tool call completes with " +
            "an `AskQuestionResult.async` placeholder and the agent " +
            "turn ends; the user's actual answer is delivered later " +
            "as an `AsyncAskQuestionCompletionAction` ConversationAction. " +
            "When false (default), the tool call blocks until the " +
            "user answers and returns `AskQuestionResult.success`.",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_ASK_QUESTION: {
    name: "ask_question",
    description: "Ask a follow-up question to the user",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        title: { type: "string", description: "Question panel title" },
        questions: {
          type: "array",
          description: "Structured question list for interactive UI selection",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Question identifier" },
              prompt: { type: "string", description: "Question prompt text" },
              options: {
                type: "array",
                description: "Selectable options for this question",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option identifier" },
                    label: { type: "string", description: "Option label" },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Allow selecting multiple options",
              },
            },
            required: ["prompt"],
          },
        },
        run_async: {
          type: "boolean",
          description:
            "When true, the native AskQuestion tool call completes with " +
            "an `AskQuestionResult.async` placeholder and the agent " +
            "turn ends; the user's actual answer is delivered later " +
            "as an `AsyncAskQuestionCompletionAction` ConversationAction. " +
            "When false (default), the tool call blocks until the " +
            "user answers and returns `AskQuestionResult.success`.",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_SWITCH_MODE: {
    name: "switch_mode",
    description: "Switch the current agent mode",
    input_schema: {
      type: "object",
      properties: {
        targetModeId: { type: "string", description: "Target mode id" },
        explanation: {
          type: "string",
          description: "Why the mode switch is needed",
        },
      },
      required: ["targetModeId"],
    },
  },

  CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: {
    name: "list_mcp_resources",
    description: "List resources from an MCP server",
    input_schema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name" },
      },
      required: ["serverName"],
    },
  },

  CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: {
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server",
    input_schema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name" },
        uri: { type: "string", description: "Resource URI to read" },
      },
      required: ["serverName", "uri"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: {
    name: "get_mcp_tools",
    description: "List MCP tools currently available to the agent",
    input_schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server filter",
        },
        tool_name: {
          type: "string",
          description: "Optional MCP tool name filter",
        },
        pattern: {
          type: "string",
          description: "Optional fuzzy match across tool metadata",
        },
      },
      required: [],
    },
  },

  BRIDGE_EXA_SEARCH: {
    name: "exa_search",
    description: "Search the web using Exa",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        type: { type: "string", description: "Optional result type" },
        num_results: {
          type: "number",
          description: "Maximum number of results",
        },
      },
      required: ["query"],
    },
  },

  BRIDGE_EXA_FETCH: {
    name: "exa_fetch",
    description: "Fetch documents by Exa ids or URLs",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Document ids or URLs to fetch",
        },
      },
      required: ["ids"],
    },
  },

  AGENT_V1_SETUP_VM_ENVIRONMENT: {
    name: "setup_vm_environment",
    description:
      "Configure the Cursor-managed task environment before running project commands",
    input_schema: {
      type: "object",
      properties: {
        install_command: {
          type: "string",
          description: "Install/dependency command",
        },
        start_command: {
          type: "string",
          description: "Start command after setup",
        },
        dockerfile_contents: {
          type: "string",
          description: "Optional Dockerfile contents for the environment",
        },
      },
      required: [],
    },
  },

  AGENT_V1_REPLACE_ENV: {
    name: "replace_env",
    description:
      "Replace the Cursor-managed task environment with an explicit configuration",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["custom", "clean_slate", "default"],
          description: "Environment replacement mode",
        },
        install_script: {
          type: "string",
          description: "Install script used in custom mode",
        },
        dockerfile_contents: {
          type: "string",
          description: "Dockerfile contents used in custom mode",
        },
        checkout_ref_overrides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              repo_url: { type: "string" },
              ref: { type: "string" },
            },
            required: ["repo_url", "ref"],
          },
          description: "Repository checkout ref overrides",
        },
      },
      required: ["mode"],
    },
  },

  AGENT_V1_PR_MANAGEMENT: {
    name: "pr_management",
    description:
      "Create or update a pull request, inspect CI, update PR status, post a review comment, or resolve a review comment through Cursor",
    input_schema: {
      type: "object",
      properties: {
        create_pr: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            base_branch: { type: "string" },
            draft: { type: "boolean" },
            branch_name: { type: "string" },
            add_labels: { type: "array", items: { type: "string" } },
            repo_url: { type: "string" },
            skip_branch_prefix_check: { type: "boolean" },
          },
          required: ["title", "body", "branch_name"],
        },
        update_pr: {
          type: "object",
          properties: {
            pr_url: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            base_branch: { type: "string" },
            branch_name: { type: "string" },
            add_labels: { type: "array", items: { type: "string" } },
            remove_labels: { type: "array", items: { type: "string" } },
            repo_url: { type: "string" },
          },
          required: [],
        },
        post_comment: {
          type: "object",
          properties: {
            pr_url: { type: "string" },
            branch_name: { type: "string" },
            body: { type: "string" },
            repo_url: { type: "string" },
            in_reply_to: { type: "integer" },
            path: { type: "string" },
            line: { type: "integer" },
            start_line: { type: "integer" },
            side: { type: "string" },
          },
          required: ["body"],
        },
        resolve_comment: {
          type: "object",
          properties: {
            pr_url: { type: "string" },
            branch_name: { type: "string" },
            comment_id: { type: "integer" },
            repo_url: { type: "string" },
          },
          required: ["comment_id"],
        },
        get_ci_status: {
          type: "object",
          properties: {
            pr_url: { type: "string" },
            branch_name: { type: "string" },
            repo_url: { type: "string" },
          },
          required: [],
        },
        set_pr_status: {
          type: "object",
          properties: {
            pr_url: { type: "string" },
            branch_name: { type: "string" },
            repo_url: { type: "string" },
            status: {
              type: "string",
              enum: ["open", "closed"],
            },
          },
          required: ["status"],
        },
      },
      oneOf: [
        { required: ["create_pr"] },
        { required: ["update_pr"] },
        { required: ["post_comment"] },
        { required: ["resolve_comment"] },
        { required: ["get_ci_status"] },
        { required: ["set_pr_status"] },
      ],
      additionalProperties: false,
    },
  },

  CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: {
    name: "apply_agent_diff",
    description:
      "Apply the already-persisted diff owned by the specified Cursor agent.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent identifier" },
      },
      required: ["agent_id"],
    },
  },

  CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: {
    name: "generate_image",
    description: "Generate an image artifact from a prompt",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image generation prompt" },
        filePath: {
          type: "string",
          description: "Optional output file path",
        },
      },
      required: ["prompt"],
    },
  },

  AGENT_V1_SEARCH_CONVERSATIONS: {
    name: "search_conversations",
    description: "Search locally persisted conversations by text",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to search for across local conversations",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching conversations",
        },
      },
      required: ["query"],
    },
  },

  AGENT_V1_CREATE_GOAL: {
    name: "create_goal",
    description:
      "Create a durable conversation goal that Cursor can continue across idle turns",
    input_schema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description: "Goal objective the agent should keep working toward",
        },
      },
      required: ["objective"],
    },
  },

  AGENT_V1_UPDATE_GOAL: {
    name: "update_goal",
    description: "Update the status of the active conversation goal",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Goal status: active, paused, complete, or cleared",
          enum: ["active", "paused", "complete", "cleared"],
        },
      },
      required: ["status"],
    },
  },

  CLIENT_SIDE_TOOL_V2_SEND_TO_USER: {
    name: "send_to_user",
    description: "Send a message to the user without asking for a response",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message text to show to the user",
        },
      },
      required: ["message"],
    },
  },

  CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: {
    name: "report_bugfix_results",
    description:
      "Report bugfix verification results. Each result item must include " +
      "a non-empty bugId, bugTitle, explanation, and a verdict (one of " +
      '"fixed", "false_positive", "could_not_fix", or the integer 1/2/3).',
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Bugfix summary" },
        results: {
          type: "array",
          description:
            "Structured bugfix results. Must contain at least one item.",
          items: {
            type: "object",
            properties: {
              bugId: {
                type: "string",
                description:
                  'Identifier of the bug being verified (also accepts "bug_id" or "id").',
              },
              bugTitle: {
                type: "string",
                description:
                  'Short title of the bug (also accepts "bug_title" or "title").',
              },
              verdict: {
                description:
                  'Bugfix verdict: "fixed" (1), "false_positive" (2), or "could_not_fix" (3). String or integer accepted.',
                oneOf: [
                  {
                    type: "string",
                    enum: [
                      "fixed",
                      "false_positive",
                      "could_not_fix",
                      "not_fixed",
                      "failed",
                    ],
                  },
                  { type: "integer", minimum: 1, maximum: 3 },
                ],
              },
              explanation: {
                type: "string",
                description:
                  'Reason / details supporting the verdict (also accepts "reason" or "details").',
              },
            },
            required: ["bugId", "bugTitle", "verdict", "explanation"],
          },
          minItems: 1,
        },
      },
      required: ["results"],
    },
  },

  AGENT_V1_BACKGROUND_SHELL_SPAWN: {
    name: "background_shell_spawn",
    description:
      "Spawn a long-running shell session that runs `command` inside a " +
      "login shell (zsh on macOS, bash on Linux). The shell is what " +
      "executes — `write_shell_stdin` writes to the shell's stdin, NOT " +
      "to a child program's stdin. To feed stdin to a specific program, " +
      "embed it in the command (e.g. `printf '%s\\n' input | program`) " +
      "or use a heredoc inside `command`. Returns a shellId you can " +
      "later use with `write_shell_stdin` and other shell-lifecycle tools.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Shell command line; runs via `shell -c <command>` so " +
            "redirections, pipes, and heredocs work as in a normal shell.",
        },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
  },

  CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: {
    name: "write_shell_stdin",
    description:
      "Write data to the stdin of a shell session previously spawned by " +
      "`background_shell_spawn`. Note: input is consumed by the shell " +
      "process (zsh/bash), not directly by any inner program — use a " +
      "pipe or heredoc in the original `command` if you need to feed " +
      "stdin to a specific program.",
    input_schema: {
      type: "object",
      properties: {
        shellId: {
          type: "number",
          description:
            "The shell session id returned by background_shell_spawn.",
        },
        data: {
          type: "string",
          description:
            "Data to write to the shell's stdin. Append a newline if " +
            "you want the shell to evaluate the line immediately.",
        },
      },
      required: ["shellId", "data"],
    },
  },

  CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: {
    name: "record_screen",
    description: "Start/save/discard screen recording in IDE",
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "Recording mode such as start/save/discard",
        },
        saveAsFilename: {
          type: "string",
          description: "Optional file name when saving recording",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_REFLECT: {
    name: "reflect",
    description: "Run reflective reasoning before continuing execution",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  /**
   * AI 代码归因工具 — 对齐 Cursor proto agent/v1.proto AiAttributionArgs。
   * 用于在指定文件/行范围内查找 AI 生成的代码片段。
   */
  CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION: {
    name: "ai_attribution",
    description:
      "Check AI attribution for code in specified files and line ranges",
    input_schema: {
      type: "object",
      properties: {
        file_paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths to check for AI attribution",
        },
        start_line: {
          type: "number",
          description: "Optional start line number",
        },
        end_line: {
          type: "number",
          description: "Optional end line number",
        },
        commit_hashes: {
          type: "array",
          items: { type: "string" },
          description: "Optional commit hashes to check",
        },
        output_mode: {
          type: "string",
          description: "Output mode for attribution results",
        },
        max_commits: {
          type: "number",
          description: "Maximum number of commits to analyze",
        },
        include_line_ranges: {
          type: "boolean",
          description: "Whether to include line ranges in output",
        },
      },
      required: [],
    },
  },

  /**
   * 通用异步等待工具 — 对齐 Cursor proto agent/v1.proto AwaitArgs。
   * AWAIT_TASK 的升级版，支持 block_until_ms 超时和 regex 匹配。
   */
  CLIENT_SIDE_TOOL_V2_AWAIT: {
    name: "await",
    description:
      "Wait for a background task to complete, with optional timeout and output regex matching",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "ID of the background task to await",
        },
        block_until_ms: {
          type: "number",
          description:
            "Maximum time in milliseconds to block waiting for completion",
        },
        regex: {
          type: "string",
          description: "Optional regex pattern to match against task output",
        },
      },
      required: ["task_id"],
    },
  },

  /**
   * MCP 认证工具 — 对齐 Cursor proto agent/v1.proto McpAuthArgs。
   * 用于触发 MCP 服务器的认证流程。
   */
  CLIENT_SIDE_TOOL_V2_MCP_AUTH: {
    name: "mcp_auth",
    description:
      "Authenticate with an MCP server to unlock access to its tools and " +
      "resources. Call this ONLY in response to an upstream auth requirement: " +
      "either a previous mcp_tool / list_mcp_resources / read_mcp_resource " +
      "result that returned an authentication-required error carrying a " +
      "toolCallId, or an explicit instruction from the user to (re-)auth a " +
      "specific server. Do not invent a toolCallId; copy it verbatim from " +
      "the prior tool error envelope so the IDE can correlate the auth " +
      "exchange back to that pending tool call.",
    input_schema: {
      type: "object",
      properties: {
        server_identifier: {
          type: "string",
          description:
            "Stable identifier of the MCP server to authenticate. Use the " +
            "exact `server` / `providerIdentifier` value reported by " +
            "get_mcp_tools or by the failing mcp_* tool's error payload " +
            "(NOT a human-readable display name).",
        },
        tool_call_id: {
          type: "string",
          description:
            "REQUIRED in practice: the toolCallId of the previous mcp_* " +
            "call whose error indicated that authentication is required. " +
            "If you are running mcp_auth proactively (no upstream error " +
            "exists), set this to a stable identifier the IDE can echo " +
            "back, but never omit the field.",
        },
      },
      // server_identifier is the only proto-level required field; we keep
      // tool_call_id optional in the schema to stay compatible with the
      // proto, but the description above makes its practical necessity
      // explicit so the model does not silently drop it.
      required: ["server_identifier"],
    },
  },

  AGENT_V1_START_GRIND_EXECUTION: {
    name: "start_grind_execution",
    description: "Start grind execution workflow",
    input_schema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional explanation for the execution request",
        },
      },
      required: [],
    },
  },

  AGENT_V1_START_GRIND_PLANNING: {
    name: "start_grind_planning",
    description: "Start grind planning workflow",
    input_schema: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional explanation for the planning request",
        },
      },
      required: [],
    },
  },

  CLIENT_SIDE_TOOL_V2_COMPUTER_USE: {
    name: "computer_use",
    description: "Perform computer-use actions in IDE automation sandbox",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "Computer-use action list",
          items: { type: "object" },
        },
      },
      required: [],
    },
  },

  AGENT_V1_FETCH: {
    name: "fetch",
    description: "Fetch content from a URL",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },

  CLIENT_SIDE_TOOL_V2_CONNECT_SCM: {
    name: "connect_scm",
    description:
      "Connect the current GitHub repository to Cursor source control services",
    input_schema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "GitHub repository owner",
        },
        repo: {
          type: "string",
          description: "GitHub repository name",
        },
        ghe_application: {
          type: "string",
          description: "Optional GitHub Enterprise application identifier",
        },
      },
      required: ["owner", "repo"],
    },
  },
}

const PREFERRED_CURSOR_KEY_BY_TOOL_NAME: Record<string, string> = {
  ask_question: "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  search_conversations: "AGENT_V1_SEARCH_CONVERSATIONS",
  create_goal: "AGENT_V1_CREATE_GOAL",
  update_goal: "AGENT_V1_UPDATE_GOAL",
  create_plan: "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  switch_mode: "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  mcp_tool: "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  web_search: "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  web_fetch: "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
  exa_search: "BRIDGE_EXA_SEARCH",
  exa_fetch: "BRIDGE_EXA_FETCH",
  setup_vm_environment: "AGENT_V1_SETUP_VM_ENVIRONMENT",
  replace_env: "AGENT_V1_REPLACE_ENV",
  pr_management: "AGENT_V1_PR_MANAGEMENT",
  connect_scm: "CLIENT_SIDE_TOOL_V2_CONNECT_SCM",
  read_lints: "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  list_mcp_resources: "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  read_mcp_resource: "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  get_mcp_tools: "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  task: "CLIENT_SIDE_TOOL_V2_TASK_V2",
  read_todos: "CLIENT_SIDE_TOOL_V2_TODO_READ",
  update_todos: "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  apply_agent_diff: "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
  generate_image: "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  send_to_user: "CLIENT_SIDE_TOOL_V2_SEND_TO_USER",
  report_bugfix_results: "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  read_semsearch_files: "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  fetch_rules: "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  search_symbols: "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  knowledge_base: "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  fetch_pull_request: "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  create_diagram: "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  fix_lints: "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  go_to_definition: "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  await_task: "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  await: "CLIENT_SIDE_TOOL_V2_AWAIT",
  ai_attribution: "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
  mcp_auth: "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
  read_project: "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  reflect: "CLIENT_SIDE_TOOL_V2_REFLECT",
  kill_agent: "BRIDGE_KILL_AGENT",
}

const DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS = [
  "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
  "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
  "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
  "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
  "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  "CLIENT_SIDE_TOOL_V2_TASK_V2",
  "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
  "CLIENT_SIDE_TOOL_V2_AWAIT",
  "BRIDGE_KILL_AGENT",
  "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
  "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
  "CLIENT_SIDE_TOOL_V2_TODO_READ",
  "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  "AGENT_V1_CREATE_GOAL",
  "AGENT_V1_UPDATE_GOAL",
  "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
  "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
  "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  "AGENT_V1_BACKGROUND_SHELL_SPAWN",
  "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
  "AGENT_V1_FETCH",
  "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
  "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
  "CLIENT_SIDE_TOOL_V2_REFLECT",
  "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
  "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
  "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
  "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
  "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
  "AGENT_V1_SETUP_VM_ENVIRONMENT",
  "AGENT_V1_REPLACE_ENV",
  "AGENT_V1_PR_MANAGEMENT",
  "CLIENT_SIDE_TOOL_V2_CONNECT_SCM",
  "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
  "CLIENT_SIDE_TOOL_V2_SEND_TO_USER",
  "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
  "BRIDGE_EXA_SEARCH",
  "BRIDGE_EXA_FETCH",
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
] as const

const DEFAULT_CODEX_IMPLICIT_CURSOR_TOOLS = [
  "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
  "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
  "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
  "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
  "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
  "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
  "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
  "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
  "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
  "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
  "CLIENT_SIDE_TOOL_V2_TODO_READ",
  "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
  "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
  "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
  "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
  "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
  "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
] as const

const BUILTIN_CURSOR_TOOL_KEYS = new Set<string>(
  Object.keys(CURSOR_TOOL_DEFINITIONS)
)

const BUILTIN_WEB_SEARCH_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
])

const BUILTIN_WEB_FETCH_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
])

const BUILTIN_LINT_TOOL_KEYS = new Set<string>([
  "AGENT_V1_DIAGNOSTICS",
  "CLIENT_SIDE_TOOL_V2_READ_LINTS",
])

const BUILTIN_SEND_TO_USER_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_SEND_TO_USER",
])

const BUILTIN_APPLY_AGENT_DIFF_TOOL_KEYS = new Set<string>([
  "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
])

function resolveToolDefinitionKey(rawTool: string): string | undefined {
  const exactToolName = rawTool
  if (!exactToolName) return undefined

  if (CURSOR_TOOL_DEFINITIONS[exactToolName]) {
    return exactToolName
  }

  const preferred = PREFERRED_CURSOR_KEY_BY_TOOL_NAME[exactToolName]
  if (preferred && CURSOR_TOOL_DEFINITIONS[preferred]) {
    return preferred
  }

  for (const [key, definition] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    if (definition.name === exactToolName) {
      return key
    }
  }

  return undefined
}

export function resolveCursorToolDefinitionKey(
  rawTool: string
): string | undefined {
  return resolveToolDefinitionKey(rawTool)
}

/**
 * A static Cursor descriptor captured by a sub-agent capability compiler at
 * spawn time.  Unlike {@link resolveCursorToolDefinitionKey}, this lookup is
 * deliberately exact: a durable `cursorDefinitionKey` is already canonical
 * and must never be reinterpreted through aliases or normalized names while
 * a child run is being assembled.
 *
 * The returned descriptor is a detached clone.  It is valid only for
 * spawn-time compilation; a persisted child contract owns the description
 * and schema used by later provider requests.
 */
export interface FrozenCursorToolDefinition {
  readonly definitionKey: string
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

export function getFrozenCursorToolDefinition(
  definitionKey: string
): FrozenCursorToolDefinition {
  if (
    !Object.prototype.hasOwnProperty.call(
      CURSOR_TOOL_DEFINITIONS,
      definitionKey
    )
  ) {
    throw new Error(
      `Unknown frozen Cursor tool definition key: ${JSON.stringify(definitionKey)}`
    )
  }

  const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
  if (!definition) {
    throw new Error(
      `Missing frozen Cursor tool definition: ${JSON.stringify(definitionKey)}`
    )
  }

  return {
    definitionKey,
    name: definition.name,
    description: definition.description,
    inputSchema: JSON.parse(JSON.stringify(definition.input_schema)) as Record<
      string,
      unknown
    >,
  }
}

/**
 * Convert Cursor supportedTools list to Anthropic tool definitions
 */
export function mapCursorToolsToAnthropic(
  supportedTools: string[]
): AnthropicTool[] {
  const tools: AnthropicTool[] = []
  const seen = new Set<string>()

  for (const cursorTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(cursorTool)
    if (!definitionKey || seen.has(definitionKey)) continue
    seen.add(definitionKey)

    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (definition) {
      tools.push(definition)
    }
  }

  return tools
}

/**
 * Map Anthropic tool_use response back to Cursor tool name
 */
export function mapAnthropicToolToCursor(anthropicToolName: string): string {
  const exactToolName = anthropicToolName.trim()
  const preferred = PREFERRED_CURSOR_KEY_BY_TOOL_NAME[exactToolName]
  if (preferred && CURSOR_TOOL_DEFINITIONS[preferred]) {
    return preferred
  }

  // Reverse lookup
  for (const [cursorName, def] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    if (def.name === exactToolName) {
      return cursorName
    }
  }
  // If no mapping found, return as-is (might be a custom tool)
  return anthropicToolName
}

/**
 * Get all available tool names for logging/debugging
 */
export function getAvailableTools(): string[] {
  return Object.keys(CURSOR_TOOL_DEFINITIONS)
}

/**
 * Return the canonical set of bridge-recognised built-in tool
 * *user-facing* names. It contains only definitions enabled by the current
 * bridge capability set, rather than every generated Cursor protocol name.
 * Every name returned here is directly callable without a `discover_tool`
 * round-trip.
 *
 * P1-3 / smoke-regression #5: callers use this set to recognise when
 * a `discover_tool({ tool_name })` call targets a tool that is
 * already callable, so they can return a friendly success-shaped
 * response instead of the misleading `Unknown deferred tool` reject.
 */
const CURSOR_BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(CURSOR_TOOL_DEFINITIONS)
    .filter(([definitionKey]) => shouldIncludeBuiltInTool(definitionKey))
    .map(([, definition]) => definition.name)
)

export function getCursorBuiltInToolNames(): ReadonlySet<string> {
  return CURSOR_BUILT_IN_TOOL_NAMES
}

function shouldIncludeBuiltInTool(
  definitionKey: string,
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  if (!CURSOR_MODEL_CALLABLE_DEFINITION_KEYS.has(definitionKey)) {
    return false
  }

  const hasExplicitWebCapability =
    options?.webSearchEnabled !== undefined ||
    options?.webFetchEnabled !== undefined

  if (BUILTIN_WEB_SEARCH_TOOL_KEYS.has(definitionKey)) {
    return hasExplicitWebCapability ? options?.webSearchEnabled === true : true
  }

  if (BUILTIN_WEB_FETCH_TOOL_KEYS.has(definitionKey)) {
    return hasExplicitWebCapability ? options?.webFetchEnabled === true : true
  }

  if (BUILTIN_LINT_TOOL_KEYS.has(definitionKey)) {
    if (options?.readLintsEnabled === false) return false
  }

  if (BUILTIN_SEND_TO_USER_TOOL_KEYS.has(definitionKey)) {
    return options?.sendToUserEnabled === true
  }

  // ApplyAgentDiff can only apply a diff already owned by a real Cursor
  // agent. Do not expose it without an explicit executor capability.
  if (BUILTIN_APPLY_AGENT_DIFF_TOOL_KEYS.has(definitionKey)) {
    return options?.applyAgentDiffEnabled === true
  }

  return true
}

export function getDefaultAgentToolNames(
  options?: CursorBuiltInToolCapabilityOptions
): string[] {
  return DEFAULT_AGENT_BUILTIN_CURSOR_TOOLS.filter((toolName) =>
    shouldIncludeBuiltInTool(toolName, options)
  )
}

function normalizeToolSet(toolNames: string[]): string[] {
  return Array.from(
    new Set(
      toolNames
        .map((toolName) => resolveToolDefinitionKey(toolName) || toolName)
        .filter(Boolean)
    )
  ).sort()
}

export function matchesImplicitDefaultAgentToolNames(
  toolNames: string[],
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  const normalizedActual = normalizeToolSet(toolNames)
  const normalizedDefault = normalizeToolSet(getDefaultAgentToolNames(options))

  if (normalizedActual.length !== normalizedDefault.length) {
    return false
  }

  return normalizedActual.every(
    (toolName, index) => toolName === normalizedDefault[index]
  )
}

export function getDefaultCodexImplicitAgentToolNames(
  options?: CursorBuiltInToolCapabilityOptions
): string[] {
  return DEFAULT_CODEX_IMPLICIT_CURSOR_TOOLS.filter((toolName) =>
    shouldIncludeBuiltInTool(toolName, options)
  )
}

export function isCursorBuiltInToolAllowed(
  toolName: string,
  options?: CursorBuiltInToolCapabilityOptions
): boolean {
  if (!BUILTIN_CURSOR_TOOL_KEYS.has(toolName)) {
    return true
  }
  return shouldIncludeBuiltInTool(toolName, options)
}

export type CursorProtocolProjectionCapability =
  | "regular_grep"
  | "pi_grep"
  | "apply_agent_diff"

export interface CursorProtocolProjectionDecision {
  allowed: boolean
  capability?: CursorProtocolProjectionCapability
  reason?: "not_in_cursor_protocol" | "unsupported_projection"
}

/**
 * Gate projections at the Cursor protocol boundary. In particular, Codex's
 * freeform apply_patch is a runtime-native custom tool, not a Cursor
 * ApplyAgentDiff or PI edit payload.
 */
export function getCursorProtocolProjectionDecision(
  toolName: string
): CursorProtocolProjectionDecision {
  const exactToolName = toolName.trim()
  if (exactToolName === "apply_patch") {
    return { allowed: false, reason: "not_in_cursor_protocol" }
  }
  if (
    exactToolName === "grep_search" ||
    exactToolName === "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH" ||
    exactToolName === "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH"
  ) {
    return { allowed: true, capability: "regular_grep" }
  }
  if (exactToolName === "pi_grep") {
    return { allowed: true, capability: "pi_grep" }
  }
  if (
    exactToolName === "apply_agent_diff" ||
    exactToolName === "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF"
  ) {
    return { allowed: true, capability: "apply_agent_diff" }
  }
  return { allowed: false, reason: "unsupported_projection" }
}

/** ApplyAgentDiffArgs has exactly one protocol field: agent_id. */
export function hasValidCursorApplyAgentDiffArgs(
  args: unknown
): args is { agent_id?: string; agentId?: string } {
  if (!args || typeof args !== "object") return false
  const record = args as Record<string, unknown>
  const agentId = record.agent_id ?? record.agentId
  return (
    typeof agentId === "string" &&
    agentId.length > 0 &&
    agentId === agentId.trim() &&
    !agentId.includes("\u0000")
  )
}

// ToolDefinition format compatible with CreateMessageDto
export interface McpToolDefinitionForApi {
  name: string
  toolName?: string
  providerIdentifier?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface BuildToolsForApiOptions {
  mcpToolDefs?: McpToolDefinitionForApi[]
  backend?: string
  /** Logical graph projection that will own calls from this tool catalog. */
  projectionProvider?: ProjectionProvider
  /**
   * Sub-agent definitions visible to the current session. When provided,
   * the `task` tool's description is rewritten to enumerate every agent's
   * `agentType`, `whenToUse`, and resolved tool surface — mirroring
   * claude-code's `getPrompt(agentDefinitions)` behaviour. Without this,
   * the model only knows the static "Delegate a task/sub-agent execution
   * request" sentence and has to guess what `subagent_type` to pass.
   *
   * Optional: when undefined the static description is used (preserves
   * the legacy contract for callers that don't have a registry yet,
   * e.g. very early bootstrap paths).
   */
  subagentDefinitions?: Array<{
    agentType: string
    whenToUse: string
    /** Pre-resolved foreground user-facing tool names for this sub-agent. */
    toolNames: string[]
    /**
     * Tools with a complete detached execution owner. This is intentionally
     * separate from `toolNames`: a foreground Exec/client tool is not an
     * implied background capability.
     */
    backgroundToolNames: string[]
  }>
  /**
   * Exact model ids Cursor advertised through
   * `AgentRunRequest.selected_subagent_models` for this request. `undefined`
   * preserves the static descriptor for non-Cursor/bootstrap callers; an
   * empty array removes the invocation-level `model` property so the child
   * inherits through Cursor settings.
   */
  selectedSubagentModelIds?: readonly string[]
  /**
   * Mark this tool list as being assembled for a sub-agent's own LLM turn
   * rather than the top-level agent. Sub-agents must NOT see the `task`
   * tool itself (no nested sub-agents through the `task` channel — they
   * have no ExecServerMessage path to spawn one), and cannot use the
   * top-level session's deferred-tool discovery catalog. The mapper makes
   * both restrictions structural rather than relying on the resolver to
   * omit those names.
   */
  forSubAgent?: boolean
  /**
   * Optional defer-loading policy.  When provided, low-frequency / MCP
   * tools are split out of the returned `ToolDefinition[]` and instead
   * surfaced via the partner `deferred` array on `BuildToolsForApiResult`.
   * The bridge advertises deferred tools in the system prompt and serves
   * `discover_tool({ tool_name })` calls inline so the model can pull
   * any specific one back into the core surface mid-session.
   *
   * Pass `{ strategy: "off" }` (or omit) to keep the legacy contract
   * (every requested tool with full schema, no `discover_tool` injection).
   */
  defer?: BuildToolsDeferOptions
}

/**
 * Per-call defer policy.  Decoupled from `BackendType` here so callers
 * (cursor-connect-stream / sub-agent dispatcher) can override the
 * strategy from the default `pickStrategy(backend)` if a particular
 * code path needs full tools (e.g. a sub-agent whose own surface is
 * already small enough that defer is pure overhead).
 */
export interface BuildToolsDeferOptions {
  /** "off" / "mcp-only" / "aggressive" — see tool-defer-policy.ts. */
  strategy: "off" | "mcp-only" | "aggressive"
  /**
   * Tools the model has already pulled into core via `discover_tool`
   * earlier in this session.  These are exempted from deferral so the
   * tools array stays consistent across turns.
   */
  discoveredTools?: ReadonlySet<string>
}

function assertSubagentDoesNotUseDeferredCatalog(
  options: BuildToolsForApiOptions | undefined
): void {
  if (
    options?.forSubAgent === true &&
    options.defer !== undefined &&
    options.defer.strategy !== "off"
  ) {
    throw new Error(
      "Sub-agent tool surfaces cannot use deferred-tool discovery catalogs"
    )
  }
}

function isTaskToolDefinitionKey(definitionKey: string): boolean {
  return (
    definitionKey === "CLIENT_SIDE_TOOL_V2_TASK" ||
    definitionKey === "CLIENT_SIDE_TOOL_V2_TASK_V2"
  )
}

/**
 * Output of `buildToolsForApi` when `defer` is provided.  The tools
 * field is the trimmed list to send to the upstream; `deferred` is the
 * full descriptor of every tool that was split out and is now reachable
 * only via `discover_tool`.
 *
 * For backwards compatibility with callers that haven't been updated to
 * use defer yet, `buildToolsForApi()` keeps returning a plain
 * `ToolDefinition[]` when `defer` is omitted; the new behaviour is
 * accessed via `buildToolsForApiWithDefer()` (see below) which returns
 * the structured form.
 */
export interface BuildToolsForApiResult {
  /** Tools sent to the upstream with their full schema. */
  tools: ToolDefinition[]
  /**
   * Tools removed from `tools` and instead summarised in the system
   * prompt's `<deferred_tools>` catalog.  Each entry retains its full
   * description and input_schema so `discover_tool` can return them
   * verbatim when the model asks.
   */
  deferred: DeferredToolDescriptor[]
}

/**
 * One entry in the deferred-tool catalog.  The two fields the bridge
 * needs are (1) what to render in the system prompt as the model's
 * one-line index, and (2) what to return as the `discover_tool` payload.
 */
export interface DeferredToolDescriptor {
  name: string
  /** One-sentence summary used in the system prompt catalog. */
  oneLineDescription: string
  /** Full description, returned verbatim by `discover_tool`. */
  description: string
  /** Full schema, returned verbatim by `discover_tool`. */
  input_schema: Record<string, unknown>
}

export interface CursorBuiltInToolCapabilityOptions {
  webSearchEnabled?: boolean
  webFetchEnabled?: boolean
  readLintsEnabled?: boolean
  sendToUserEnabled?: boolean
  /** A real agent-diff executor is attached for this request. */
  applyAgentDiffEnabled?: boolean
}

export interface ToolDefinition {
  type: "function" | "custom" | "tool_search" | "web_search"
  name: string
  description: string
  input_schema?: Record<string, unknown>
  execution?: "client"
  strict?: boolean
  format?: Record<string, unknown>
  external_web_access?: boolean
  search_content_types?: string[]
}

const CODEX_TOOL_SEARCH_DEFINITION: ToolDefinition = {
  type: "tool_search",
  name: CODEX_TOOL_SEARCH_NAME,
  execution: "client",
  description:
    "# Tool discovery\n\n" +
    "Searches over deferred tool metadata and exposes matching tools for " +
    "the next model call.\n\n" +
    "Some of the tools may not have been provided upfront. Use this tool " +
    "to search for the required tools instead of inventing tool names.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query for deferred tools.",
      },
      limit: {
        type: "number",
        description: "Maximum number of tools to return. Defaults to 8.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
}

function cloneToolDefinition(tool: ToolDefinition): ToolDefinition {
  return JSON.parse(JSON.stringify(tool)) as ToolDefinition
}

const CODEX_NATIVE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "exec_command",
    description:
      "Run a shell command and return output or a session id for continued interaction.",
    input_schema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Shell command to execute." },
        justification: {
          type: "string",
          description:
            "Optional explanation shown when the command requires elevated permissions.",
        },
        login: {
          type: "boolean",
          description: "Run the shell with login semantics.",
        },
        max_output_tokens: {
          type: "number",
          description: "Maximum output tokens to return.",
        },
        prefix_rule: {
          type: "array",
          description: "Optional reusable command prefix rule.",
          items: { type: "string" },
        },
        sandbox_permissions: {
          type: "string",
          description: "Requested sandbox policy for the command.",
        },
        shell: {
          type: "string",
          description: "Optional shell binary override.",
        },
        tty: {
          type: "boolean",
          description: "Allocate a TTY for interactive commands.",
        },
        workdir: {
          type: "string",
          description: "Optional working directory.",
        },
        yield_time_ms: {
          type: "number",
          description: "How long to wait before yielding output.",
        },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_stdin",
    description:
      "Write characters to a running exec session and return recent output.",
    input_schema: {
      type: "object",
      properties: {
        chars: {
          type: "string",
          description: "Bytes to write to stdin. Empty means poll only.",
        },
        max_output_tokens: {
          type: "number",
          description: "Maximum output tokens to return.",
        },
        session_id: {
          type: "number",
          description: "Identifier of the running exec session.",
        },
        yield_time_ms: {
          type: "number",
          description: "How long to wait before yielding output.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_mcp_resources",
    description: "List resources exposed by configured MCP servers.",
    input_schema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous result.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_mcp_resource_templates",
    description: "List MCP resource templates exposed by configured servers.",
    input_schema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous result.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_mcp_resource",
    description: "Read a resource from an MCP server by server name and URI.",
    input_schema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "MCP server name exactly as configured.",
        },
        uri: {
          type: "string",
          description: "Resource URI returned by list_mcp_resources.",
        },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_todos",
    description:
      "Read current todo items and optionally filter by status or id.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "array",
          description:
            "Optional todo status filter (pending/in_progress/completed/cancelled).",
          items: { type: "string" },
        },
        id_filter: {
          type: "array",
          description: "Optional todo id filter.",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_todos",
    description:
      "Update todo items and optionally merge them into the current list.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Todo objects to write.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable todo id.",
              },
              content: {
                type: "string",
                description: "Human-readable todo text.",
              },
              status: {
                type: "string",
                description:
                  "Todo status enum (TODO_STATUS_PENDING/IN_PROGRESS/COMPLETED/CANCELLED).",
              },
              dependencies: {
                type: "array",
                description: "Optional upstream todo ids.",
                items: { type: "string" },
              },
              createdAt: {
                type: "string",
                description: "Optional creation timestamp (unix ms).",
              },
              updatedAt: {
                type: "string",
                description: "Optional update timestamp (unix ms).",
              },
            },
            required: ["id", "content", "status"],
            additionalProperties: false,
          },
        },
        merge: {
          type: "boolean",
          description: "Whether to merge with existing todos.",
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_plan",
    description: "Update the active task plan and plan item statuses.",
    input_schema: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        plan: {
          type: "array",
          description: "Plan items in execution order.",
          items: {
            type: "object",
            properties: {
              status: {
                type: "string",
                description: "One of pending, in_progress, or completed.",
              },
              step: { type: "string" },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_user_input",
    description: "Ask the user one to three short structured questions.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Structured question list.",
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                description: "Short header label shown in the UI.",
              },
              id: {
                type: "string",
                description: "Stable identifier for the question.",
              },
              options: {
                type: "array",
                description: "Mutually exclusive answer choices.",
                items: {
                  type: "object",
                  properties: {
                    description: {
                      type: "string",
                      description: "Short impact or tradeoff description.",
                    },
                    label: {
                      type: "string",
                      description: "User-facing choice label.",
                    },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              question: {
                type: "string",
                description: "Single-sentence prompt shown to the user.",
              },
            },
            required: ["id", "header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    type: "web_search",
    name: "web_search",
    description: "Search the web when local and MCP context is insufficient.",
    external_web_access: true,
    search_content_types: ["text", "image"],
  },
  {
    type: "function",
    name: "view_image",
    description:
      "View a local image file by absolute path within the active workspace.",
    input_schema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          description: "Optional detail override. Supported value: original.",
        },
        path: {
          type: "string",
          description:
            "Absolute filesystem path to the image inside the active workspace.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
]

const CODEX_NATIVE_TOOL_BY_NAME = new Map(
  CODEX_NATIVE_TOOL_DEFINITIONS.map((definition) => [
    definition.name,
    definition,
  ])
)

const EXPLICIT_CODEX_NATIVE_FALLBACK_NAMES = new Set([
  "exec_command",
  "write_stdin",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "read_todos",
  "update_todos",
  "update_plan",
  "request_user_input",
  "view_image",
])

function addCodexToolDefinition(
  tools: ToolDefinition[],
  seenToolNames: Set<string>,
  toolName: string
): void {
  const definition = CODEX_NATIVE_TOOL_BY_NAME.get(toolName)
  if (!definition || seenToolNames.has(toolName)) {
    return
  }

  seenToolNames.add(toolName)
  tools.push(cloneToolDefinition(definition))
}

/**
 * Build the dynamic `task` tool description shown to the parent agent.
 *
 * Mirrors claude-code's getPrompt(agentDefinitions) — the model needs to
 * see which sub-agents are available, what each is good for, and what
 * tools each one can use, so it can pick a `subagent_type` that actually
 * matches the task instead of sending an invalid explicit type.
 *
 * The static description is preserved as the first paragraph so any
 * model that never reads past the first sentence still gets the original
 * contract; the agent listing follows.
 */
function buildDynamicTaskToolDescription(
  staticDescription: string,
  subagentDefinitions: NonNullable<
    BuildToolsForApiOptions["subagentDefinitions"]
  >,
  selectedSubagentModelIds: readonly string[] | undefined
): string {
  if (subagentDefinitions.length === 0) {
    return staticDescription
  }
  const lines: string[] = [
    staticDescription,
    "",
    "Sub-agents inherit the parent model by default. Do not set `model` " +
      "unless the user explicitly requested a different model or Cursor " +
      "advertised an invocation-level choice that is necessary for this task.",
    ...(selectedSubagentModelIds
      ? selectedSubagentModelIds.length > 0
        ? [
            "Allowed invocation-level `model` values for this request: " +
              selectedSubagentModelIds.join(", ") +
              ". Any other model id is invalid.",
          ]
        : [
            "Cursor advertised no invocation-level task models for this " +
              "request, so omit `model` and inherit the configured model.",
          ]
      : []),
    "",
    "Available `subagent_type` values and what each one is good for. Pass " +
      "`subagent_type` to choose; omit it to use `general-purpose`. If you " +
      "pass `subagent_type`, it must match one listed value exactly.",
    "",
  ]
  const formatToolList = (toolNames: readonly string[]): string =>
    toolNames.length === 0
      ? "(no tools)"
      : toolNames.length > 8
        ? `${toolNames.slice(0, 8).join(", ")}, +${toolNames.length - 8} more`
        : toolNames.join(", ")
  for (const def of subagentDefinitions) {
    const foregroundToolList = formatToolList(def.toolNames)
    const backgroundToolList = formatToolList(def.backgroundToolNames)
    lines.push(
      `- ${def.agentType}: ${def.whenToUse} ` +
        `(Foreground tools: ${foregroundToolList}; ` +
        `Background tools: ${backgroundToolList})`
    )
  }
  lines.push("")
  lines.push(
    "When `run_in_background=true`, use only the selected sub-agent's " +
      "Background tools. Its Foreground tools are not an implied fallback."
  )
  lines.push(
    "When you delegate, write the prompt as if briefing a colleague who " +
      "just walked into the room with no prior context: state the goal, what " +
      "you've already learned or ruled out, and the specific question or " +
      "deliverable. Terse one-liner prompts produce shallow output."
  )
  return lines.join("\n")
}

function buildTaskInputSchema(
  inputSchema: AnthropicTool["input_schema"],
  selectedSubagentModelIds: readonly string[] | undefined
): AnthropicTool["input_schema"] {
  if (selectedSubagentModelIds === undefined) return inputSchema
  const properties = { ...inputSchema.properties }
  if (selectedSubagentModelIds.length === 0) {
    delete properties.model
  } else {
    properties.model = {
      type: "string",
      enum: [...selectedSubagentModelIds],
      description:
        "Optional Cursor-approved model override. Omit to inherit the " +
        "configured parent/sub-agent model. Use only when the user " +
        "explicitly requested a different model or the task has a clear " +
        "model-specific requirement.",
    }
  }
  return { ...inputSchema, properties }
}

function buildCodexToolsForApi(
  supportedTools: string[],
  options?: BuildToolsForApiOptions
): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  const executableViaExecServerMessage = CURSOR_MODEL_CALLABLE_DEFINITION_KEYS
  const seenDefinitionKeys = new Set<string>()
  const seenToolNames = new Set<string>()
  const resolvedDefinitionKeys = new Set<string>()
  const exactSupported = new Set<string>()
  const mcpDefByExactName = new Map<string, McpToolDefinitionForApi>()

  const addCursorToolDefinition = (definitionKey: string): void => {
    if (
      seenDefinitionKeys.has(definitionKey) ||
      !executableViaExecServerMessage.has(definitionKey)
    ) {
      return
    }

    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (!definition) {
      return
    }

    seenDefinitionKeys.add(definitionKey)
    if (seenToolNames.has(definition.name)) {
      return
    }

    seenToolNames.add(definition.name)
    tools.push({
      type: "function",
      ...definition,
    })
  }

  for (const supportedTool of supportedTools) {
    exactSupported.add(supportedTool)

    const definitionKey = resolveToolDefinitionKey(supportedTool)
    if (!definitionKey) {
      continue
    }

    resolvedDefinitionKeys.add(definitionKey)
    exactSupported.add(definitionKey)
    const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
    if (definition?.name) {
      exactSupported.add(definition.name)
    }
  }

  for (const mcpToolDef of options?.mcpToolDefs || []) {
    if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
    if (mcpToolDef.name && !mcpDefByExactName.has(mcpToolDef.name)) {
      mcpDefByExactName.set(mcpToolDef.name, mcpToolDef)
    }
    if (typeof mcpToolDef.toolName === "string" && mcpToolDef.toolName) {
      if (!mcpDefByExactName.has(mcpToolDef.toolName)) {
        mcpDefByExactName.set(mcpToolDef.toolName, mcpToolDef)
      }
    }
  }

  for (const supportedTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(supportedTool)
    if (definitionKey) {
      if (options?.forSubAgent && isTaskToolDefinitionKey(definitionKey)) {
        seenDefinitionKeys.add(definitionKey)
        continue
      }
      if (
        (definitionKey === "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL" ||
          definitionKey === "CLIENT_SIDE_TOOL_V2_MCP") &&
        mcpDefByExactName.size > 0
      ) {
        continue
      }
      addCursorToolDefinition(definitionKey)
      continue
    }

    const mcpToolDef = mcpDefByExactName.get(supportedTool)
    if (!mcpToolDef || !mcpToolDef.name) continue

    if (seenToolNames.has(mcpToolDef.name)) continue

    seenToolNames.add(mcpToolDef.name)
    tools.push({
      type: "function",
      name: mcpToolDef.name,
      description:
        mcpToolDef.description ||
        `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
      input_schema: normalizeMcpToolInputSchema(mcpToolDef.inputSchema),
    })
  }

  const hasSupportedTool = (...toolAliases: string[]): boolean =>
    toolAliases.some((toolAlias) => {
      if (resolvedDefinitionKeys.has(toolAlias)) {
        return true
      }
      return exactSupported.has(toolAlias)
    })

  if (
    hasSupportedTool(
      "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
      "AGENT_V1_BACKGROUND_SHELL_SPAWN",
      "run_terminal_command",
      "run_terminal_command_v2",
      "background_shell_spawn",
      "exec_command"
    )
  ) {
    addCursorToolDefinition("CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN")
  }

  if (
    hasSupportedTool(
      "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
      "CLIENT_SIDE_TOOL_V2_MCP",
      "mcp",
      "mcp_tool"
    )
  ) {
    for (const mcpToolDef of options?.mcpToolDefs || []) {
      if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
      if (!mcpToolDef.name || seenToolNames.has(mcpToolDef.name)) continue

      seenToolNames.add(mcpToolDef.name)
      tools.push({
        type: "function",
        name: mcpToolDef.name,
        description:
          mcpToolDef.description ||
          `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
        input_schema: normalizeMcpToolInputSchema(mcpToolDef.inputSchema),
      })
    }
  }

  for (const supportedTool of supportedTools) {
    if (!EXPLICIT_CODEX_NATIVE_FALLBACK_NAMES.has(supportedTool)) {
      continue
    }
    addCodexToolDefinition(tools, seenToolNames, supportedTool)
  }

  return tools
}

/**
 * Build tool definitions for the API backend (CreateMessageDto format).
 * This is the single source of truth — replaces the duplicate buildToolDefinitions
 * in cursor-connect-stream.service.ts.
 */
export function buildToolsForApi(
  supportedTools: string[],
  options?: BuildToolsForApiOptions
): ToolDefinition[] {
  assertSubagentDoesNotUseDeferredCatalog(options)
  if (options?.backend === "codex") {
    return buildCodexToolsForApi(supportedTools, options)
  }

  const tools: ToolDefinition[] = []
  // Track tool provenance so the defer policy can distinguish built-in
  // Cursor tools (definition came from CURSOR_TOOL_DEFINITIONS) from
  // MCP-provided tools (definition came from mcpToolDefs).  Used by
  // applyDeferPolicy() at the end of this function.
  const isBuiltInByName = new Map<string, boolean>()
  const executableViaExecServerMessage = CURSOR_MODEL_CALLABLE_DEFINITION_KEYS
  const seenDefinitionKeys = new Set<string>()
  const seenToolNames = new Set<string>()
  const mcpDefByExactName = new Map<string, McpToolDefinitionForApi>()

  for (const mcpToolDef of options?.mcpToolDefs || []) {
    if (!mcpToolDef || typeof mcpToolDef.name !== "string") continue
    if (mcpToolDef.name && !mcpDefByExactName.has(mcpToolDef.name)) {
      mcpDefByExactName.set(mcpToolDef.name, mcpToolDef)
    }
    if (typeof mcpToolDef.toolName === "string" && mcpToolDef.toolName) {
      if (!mcpDefByExactName.has(mcpToolDef.toolName)) {
        mcpDefByExactName.set(mcpToolDef.toolName, mcpToolDef)
      }
    }
  }

  for (const cursorTool of supportedTools) {
    const definitionKey = resolveToolDefinitionKey(cursorTool)
    if (definitionKey && !seenDefinitionKeys.has(definitionKey)) {
      // AgentService/Run currently dispatches tool execution via ExecServerMessage.
      // Keep the exposed tool list aligned with that executable subset to avoid
      // protocol-invalid fallbacks for unsupported tool families.
      if (!executableViaExecServerMessage.has(definitionKey)) {
        continue
      }

      // Sub-agents do not get the `task` tool — they cannot spawn nested
      // sub-agents because there is no ExecServerMessage path for the
      // child task envelope. Drop it from the tool list when assembling
      // for a sub-agent's own LLM turn.
      if (options?.forSubAgent && isTaskToolDefinitionKey(definitionKey)) {
        seenDefinitionKeys.add(definitionKey)
        continue
      }

      const definition = CURSOR_TOOL_DEFINITIONS[definitionKey]
      if (definition) {
        if (seenToolNames.has(definition.name)) {
          continue
        }
        seenDefinitionKeys.add(definitionKey)
        seenToolNames.add(definition.name)

        // For the parent agent's `task` tool, rewrite the description so
        // the model can see the available sub-agents (mirrors claude-code's
        // dynamic getPrompt(agentDefinitions)). Without this, the model
        // only sees "Delegate a task/sub-agent execution request" and has
        // to guess what `subagent_type` to pass.
        const isTaskTool =
          definitionKey === "CLIENT_SIDE_TOOL_V2_TASK" ||
          definitionKey === "CLIENT_SIDE_TOOL_V2_TASK_V2"
        const description =
          isTaskTool && options?.subagentDefinitions
            ? buildDynamicTaskToolDescription(
                definition.description,
                options.subagentDefinitions,
                options.selectedSubagentModelIds
              )
            : definition.description
        const inputSchema = isTaskTool
          ? buildTaskInputSchema(
              definition.input_schema,
              options?.selectedSubagentModelIds
            )
          : definition.input_schema

        tools.push({
          type: "function",
          ...definition,
          description,
          input_schema: inputSchema,
        })
        isBuiltInByName.set(definition.name, true)
      }
      continue
    }

    const mcpToolDef = mcpDefByExactName.get(cursorTool)
    if (!mcpToolDef || !mcpToolDef.name) continue

    if (seenToolNames.has(mcpToolDef.name)) continue

    seenToolNames.add(mcpToolDef.name)
    tools.push({
      type: "function",
      name: mcpToolDef.name,
      description:
        mcpToolDef.description ||
        `MCP tool ${mcpToolDef.toolName || mcpToolDef.name}`,
      input_schema: normalizeMcpToolInputSchema(mcpToolDef.inputSchema),
    })
    isBuiltInByName.set(mcpToolDef.name, false)
  }

  // Defer-loading split.  When `options.defer` is set, we move
  // low-frequency / MCP tools out of `tools` and surface them via the
  // `<deferred_tools>` system prompt catalog instead.  Returning only
  // the trimmed `tools` array keeps `buildToolsForApi`'s legacy
  // signature; the structured form (which exposes the deferred
  // descriptors) is `buildToolsForApiWithDefer()`.
  if (options?.defer && options.defer.strategy !== "off") {
    const split = applyDeferPolicy(
      tools,
      isBuiltInByName,
      options.defer,
      options.backend,
      options.projectionProvider
    )
    return split.tools
  }
  // Snip rewrites the detached Claude conversation projection. Codex owns an
  // append-only native rollout and other providers have no compatible
  // replacement log, so they must never receive this tool.
  const sorted = sortToolDefinitionsForPromptCache(tools)
  if (
    options?.projectionProvider === "claude" &&
    options.forSubAgent !== true &&
    !sorted.some((tool) => tool.name === SNIP_MESSAGES_TOOL_DEFINITION.name)
  ) {
    sorted.push(SNIP_MESSAGES_TOOL_DEFINITION)
  }
  return sorted
}

/**
 * Variant of `buildToolsForApi` that returns the structured
 * `BuildToolsForApiResult` (tools + deferred descriptors).  Use this
 * when you need access to the deferred catalog — for example the
 * cursor-connect-stream layer renders it into the system prompt and the
 * `discover_tool` handler looks it up by name.
 *
 * Codex uses the same defer split as the other bridge-owned backends. The
 * Codex request builder receives the already-trimmed tools array, and the
 * cursor-connect-stream layer renders the deferred catalog into the Codex
 * system prompt.
 */
export function buildToolsForApiWithDefer(
  supportedTools: string[],
  options?: BuildToolsForApiOptions
): BuildToolsForApiResult {
  assertSubagentDoesNotUseDeferredCatalog(options)
  // Re-run the main path but capture provenance so we can split.
  // Inlining the logic is cleaner than threading two return shapes
  // through `buildToolsForApi` itself.
  const fullOptions = options ? { ...options, defer: undefined } : undefined
  const allTools = buildToolsForApi(supportedTools, fullOptions)
  // Re-derive provenance: built-in iff CURSOR_TOOL_DEFINITIONS contains
  // a definition with this name.  This is O(N×M) but N <= ~80 and we
  // only do this once per request.
  const builtInNames = new Set<string>()
  for (const def of Object.values(CURSOR_TOOL_DEFINITIONS)) {
    builtInNames.add(def.name)
  }
  const provenance = new Map<string, boolean>()
  for (const tool of allTools) {
    provenance.set(tool.name, builtInNames.has(tool.name))
  }

  if (!options?.defer || options.defer.strategy === "off") {
    return { tools: allTools, deferred: [] }
  }
  return applyDeferPolicy(
    allTools,
    provenance,
    options.defer,
    options.backend,
    options.projectionProvider
  )
}

/**
 * Internal: split a fully-resolved tool list into core/deferred according
 * to the policy.  Pure function — no I/O, no globals.
 */
function applyDeferPolicy(
  tools: ToolDefinition[],
  isBuiltInByName: ReadonlyMap<string, boolean>,
  defer: BuildToolsDeferOptions,
  backend?: string,
  projectionProvider?: ProjectionProvider
): BuildToolsForApiResult {
  const discovered = defer.discoveredTools ?? new Set<string>()
  const core: ToolDefinition[] = []
  const deferred: DeferredToolDescriptor[] = []
  for (const tool of tools) {
    if (tool.name === SNIP_MESSAGES_TOOL_DEFINITION.name) {
      if (projectionProvider === "claude") {
        core.push(tool)
      }
      continue
    }
    const isBuiltIn = isBuiltInByName.get(tool.name) ?? true
    const isCore = !shouldDeferTool(
      { name: tool.name, isBuiltIn },
      defer.strategy,
      discovered
    )
    if (isCore) {
      core.push(tool)
      continue
    }
    deferred.push({
      name: tool.name,
      oneLineDescription: extractOneLineDescription(tool.description),
      description: tool.description,
      input_schema: tool.input_schema || { type: "object", properties: {} },
    })
  }

  const sortedCore = sortToolDefinitionsForPromptCache(core)

  // Inject the backend-appropriate discovery entrypoint only when there
  // is at least one deferred tool. Codex must use native tool_search:
  // promoting discovered tools into the static tools array breaks
  // previous_response_id continuation because top-level tool fields must
  // remain stable across a response chain.
  if (deferred.length > 0) {
    sortedCore.push(
      backend === "codex"
        ? cloneToolDefinition(CODEX_TOOL_SEARCH_DEFINITION)
        : DISCOVER_TOOL_DEFINITION
    )
  }

  // Snip is a Claude projection mutation, not a generic history operation.
  if (
    projectionProvider === "claude" &&
    !sortedCore.some((tool) => tool.name === SNIP_MESSAGES_TOOL_DEFINITION.name)
  ) {
    sortedCore.push(SNIP_MESSAGES_TOOL_DEFINITION)
  }

  return {
    tools: sortedCore,
    deferred: deferred.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function sortToolDefinitionsForPromptCache(
  tools: ToolDefinition[]
): ToolDefinition[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Extract a one-line summary from a tool description.  We take the
 * first sentence (split on period, exclamation, newline) and cap at
 * 160 chars so the catalog stays compact.  Falls back to the whole
 * description (truncated) when no sentence boundary is found.
 */
function extractOneLineDescription(description: string): string {
  const trimmed = description.trim()
  if (!trimmed) return ""
  const firstSentenceMatch = trimmed.match(/^[^.!\n]+[.!]?/)
  const candidate = firstSentenceMatch ? firstSentenceMatch[0].trim() : trimmed
  return candidate.length > 160 ? candidate.slice(0, 157) + "..." : candidate
}

/**
 * Get default tools for agent mode (when supportedTools is empty)
 */
export function getDefaultAgentTools(
  options?: CursorBuiltInToolCapabilityOptions
): AnthropicTool[] {
  return mapCursorToolsToAnthropic(getDefaultAgentToolNames(options))
}

/**
 * Get the ClientSideToolV2Type enum value for a given tool name
 *
 * NOTE: These values are extracted from Cursor source code static analysis.
 * The generated proto file has outdated values, so we hardcode the correct ones.
 */
export function getToolTypeEnumValue(toolName: string): number {
  // Corrected enum values from Cursor source analysis (2026-01-19)
  const TOOL_ENUM_VALUES: Record<string, number> = {
    CLIENT_SIDE_TOOL_V2_READ_FILE: 5,
    CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: 1,
    CLIENT_SIDE_TOOL_V2_LIST_DIR: 6,
    CLIENT_SIDE_TOOL_V2_EDIT_FILE: 7,
    CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: 3,
    CLIENT_SIDE_TOOL_V2_FILE_SEARCH: 8,
    CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: 9,
    CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: 27,
    CLIENT_SIDE_TOOL_V2_DELETE_FILE: 11,
    CLIENT_SIDE_TOOL_V2_REAPPLY: 12,
    CLIENT_SIDE_TOOL_V2_FETCH_RULES: 16,
    CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: 15,
    CLIENT_SIDE_TOOL_V2_WEB_SEARCH: 18,
    CLIENT_SIDE_TOOL_V2_MCP: 19,
    CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: 23,
    CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: 24,
    CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: 25,
    CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: 26,
    CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: 28,
    CLIENT_SIDE_TOOL_V2_FIX_LINTS: 29,
    CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: 31,
    CLIENT_SIDE_TOOL_V2_WEB_FETCH: 57,
    CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: 38,
    CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: 39,
    CLIENT_SIDE_TOOL_V2_READ_FILE_V2: 40,
    CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: 41,
    CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: 42,
    CLIENT_SIDE_TOOL_V2_CREATE_PLAN: 43,
    CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: 44,
    CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: 45,
    CLIENT_SIDE_TOOL_V2_READ_PROJECT: 46,
    CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: 47,
    CLIENT_SIDE_TOOL_V2_TASK: 32,
    CLIENT_SIDE_TOOL_V2_AWAIT_TASK: 33,
    CLIENT_SIDE_TOOL_V2_TASK_V2: 48,
    CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: 49,
    CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: 50,
    CLIENT_SIDE_TOOL_V2_ASK_QUESTION: 51,
    CLIENT_SIDE_TOOL_V2_SWITCH_MODE: 52,
    CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: 53,
    CLIENT_SIDE_TOOL_V2_SEND_TO_USER: 65,
    CLIENT_SIDE_TOOL_V2_COMPUTER_USE: 54,
    CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: 55,
    CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: 56,
    CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: 58,
    CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION: 59,
    CLIENT_SIDE_TOOL_V2_MCP_AUTH: 60,
    CLIENT_SIDE_TOOL_V2_REFLECT: 61,
    CLIENT_SIDE_TOOL_V2_AWAIT: 62,
    CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: 63,
    CLIENT_SIDE_TOOL_V2_READ_LINTS: 30,
    CLIENT_SIDE_TOOL_V2_TODO_READ: 34,
    CLIENT_SIDE_TOOL_V2_TODO_WRITE: 35,
    CLIENT_SIDE_TOOL_V2_CONNECT_SCM: 66,
  }

  // 1. Direct match on tool name
  const directValue = TOOL_ENUM_VALUES[toolName]
  if (directValue !== undefined) {
    return directValue
  }

  // 2. Find the Cursor tool key by anthropic name
  for (const [key, def] of Object.entries(CURSOR_TOOL_DEFINITIONS)) {
    const enumValue = TOOL_ENUM_VALUES[key]
    if (def.name === toolName && enumValue !== undefined) {
      return enumValue
    }
  }

  // Default: UNSPECIFIED = 0
  return 0
}
