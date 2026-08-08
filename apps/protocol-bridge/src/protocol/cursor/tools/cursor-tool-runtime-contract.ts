/**
 * Exact runtime ownership for Cursor-facing tools.
 *
 * Cursor exposes three distinct namespaces that must not be conflated:
 *
 * - `CLIENT_SIDE_TOOL_V2_*`: values from aiserver.v1.ClientSideToolV2.
 * - `AGENT_V1_*`: AgentService tools represented by agent.v1 messages only.
 * - `BRIDGE_*`: provider/runtime tools owned entirely by this bridge.
 *
 * Provider projection, execution routing and ToolCall serialization all read
 * this contract. A name is accepted only when it is a registered definition
 * key or an explicit runtime tool name; semantic substring matching is not a
 * protocol boundary.
 */

export type CursorDeferredToolFamily =
  | "web_search"
  | "web_fetch"
  | "command_status"
  | "read_todos"
  | "update_todos"
  | "get_mcp_tools"
  | "list_mcp_resource_templates"
  | "view_image"
  | "fetch"
  | "record_screen"
  | "computer_use"
  | "reflect"
  | "ask_question"
  | "request_user_input"
  | "create_plan"
  | "switch_mode"
  | "exa_search"
  | "exa_fetch"
  | "setup_vm_environment"
  | "replace_env"
  | "connect_scm"
  | "task"
  | "apply_patch"
  | "generate_image"
  | "report_bugfix_results"
  | "file_search"
  | "glob_search"
  | "semantic_search"
  | "deep_search"
  | "read_semsearch_files"
  | "fetch_rules"
  | "search_symbols"
  | "knowledge_base"
  | "fetch_pull_request"
  | "create_diagram"
  | "fix_lints"
  | "read_lints"
  | "go_to_definition"
  | "await_task"
  | "ai_attribution"
  | "await"
  | "kill_agent"
  | "mcp_auth"
  | "read_project"
  | "force_background_shell"
  | "force_background_subagent"
  | "mcp_state_exec"
  | "subagent_await"
  | "search_conversations"
  | "create_goal"
  | "update_goal"
  | "communicate_update"
  | "send_final_summary"
  | "send_to_user"
  | "blame_by_file_path"
  | "report_bug"
  | "set_active_branch"
  | "request_context"
  | "redacted_read"
  | "pr_management"

export type CursorProjectionToolFamily =
  | "get_mcp_tools"
  | "read_mcp_resource"
  | "list_mcp_resources"
  | "read_lints"
  | "fix_lints"
  | "read_todos"
  | "update_todos"
  | "apply_agent_diff"
  | "write_shell_stdin"
  | "background_shell_spawn"
  | "setup_vm_environment"
  | "replace_env"
  | "connect_scm"
  | "start_grind_execution"
  | "start_grind_planning"
  | "report_bugfix_results"
  | "generate_image"
  | "record_screen"
  | "computer_use"
  | "web_search"
  | "web_fetch"
  | "exa_search"
  | "exa_fetch"
  | "ask_question"
  | "switch_mode"
  | "create_plan"
  | "sem_search"
  | "truncated"
  | "reflect"
  | "read"
  | "edit"
  | "ls"
  | "delete"
  | "grep"
  | "glob"
  | "fetch"
  | "mcp"
  | "mcp_auth"
  | "task"
  | "shell"
  | "execute_hook"
  | "await"
  | "ai_attribution"
  | "pr_management"
  | "blame_by_file_path"
  | "report_bug"
  | "set_active_branch"
  | "force_background_shell"
  | "force_background_subagent"
  | "canvas_get_url"
  | "canvas_destroy"
  | "canvas_register"
  | "mcp_state_exec"
  | "subagent_await"
  | "communicate_update"
  | "send_final_summary"
  | "send_to_user"
  | "request_context"
  | "redacted_read"
  | "pi_read"
  | "pi_bash"
  | "pi_edit"
  | "pi_write"
  | "pi_grep"
  | "pi_find"
  | "pi_ls"
  | "search_conversations"
  | "create_goal"
  | "update_goal"
  | "unknown"

/** Definition keys that have a complete provider-callable runtime owner. */
export const CURSOR_MODEL_CALLABLE_DEFINITION_KEYS: ReadonlySet<string> =
  new Set([
    "CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_READ_FILE",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE",
    "CLIENT_SIDE_TOOL_V2_FILE_SEARCH",
    "CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL",
    "CLIENT_SIDE_TOOL_V2_DELETE_FILE",
    "CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2",
    "CLIENT_SIDE_TOOL_V2_FETCH_RULES",
    "CLIENT_SIDE_TOOL_V2_WEB_SEARCH",
    "CLIENT_SIDE_TOOL_V2_MCP",
    "CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS",
    "CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE",
    "CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST",
    "CLIENT_SIDE_TOOL_V2_DEEP_SEARCH",
    "CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM",
    "CLIENT_SIDE_TOOL_V2_FIX_LINTS",
    "CLIENT_SIDE_TOOL_V2_READ_LINTS",
    "CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION",
    "CLIENT_SIDE_TOOL_V2_TASK",
    "CLIENT_SIDE_TOOL_V2_AWAIT_TASK",
    "CLIENT_SIDE_TOOL_V2_TODO_READ",
    "CLIENT_SIDE_TOOL_V2_TODO_WRITE",
    "CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_LIST_DIR_V2",
    "CLIENT_SIDE_TOOL_V2_READ_FILE_V2",
    "CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH",
    "CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH",
    "CLIENT_SIDE_TOOL_V2_CREATE_PLAN",
    "CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES",
    "CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE",
    "CLIENT_SIDE_TOOL_V2_READ_PROJECT",
    "CLIENT_SIDE_TOOL_V2_TASK_V2",
    "CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL",
    "CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF",
    "CLIENT_SIDE_TOOL_V2_ASK_QUESTION",
    "CLIENT_SIDE_TOOL_V2_SWITCH_MODE",
    "CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE",
    "CLIENT_SIDE_TOOL_V2_COMPUTER_USE",
    "CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN",
    "CLIENT_SIDE_TOOL_V2_RECORD_SCREEN",
    "CLIENT_SIDE_TOOL_V2_WEB_FETCH",
    "CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS",
    "CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION",
    "CLIENT_SIDE_TOOL_V2_MCP_AUTH",
    "CLIENT_SIDE_TOOL_V2_REFLECT",
    "CLIENT_SIDE_TOOL_V2_AWAIT",
    "CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS",
    "CLIENT_SIDE_TOOL_V2_SEND_TO_USER",
    "CLIENT_SIDE_TOOL_V2_CONNECT_SCM",
    "AGENT_V1_SETUP_VM_ENVIRONMENT",
    "AGENT_V1_REPLACE_ENV",
    "AGENT_V1_PR_MANAGEMENT",
    "AGENT_V1_BACKGROUND_SHELL_SPAWN",
    "AGENT_V1_FETCH",
    "BRIDGE_KILL_AGENT",
    "BRIDGE_EXA_SEARCH",
    "BRIDGE_EXA_FETCH",
    "AGENT_V1_SEARCH_CONVERSATIONS",
    "AGENT_V1_CREATE_GOAL",
    "AGENT_V1_UPDATE_GOAL",
  ])

/** Legacy aiserver calls without an AgentService execution owner. */
export const CURSOR_LEGACY_ONLY_DEFINITION_KEYS: ReadonlySet<string> = new Set([
  "CLIENT_SIDE_TOOL_V2_REAPPLY",
  "CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP",
  "CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT",
])

const DEFERRED_FAMILY_BY_DEFINITION_KEY: Readonly<
  Record<string, CursorDeferredToolFamily>
> = Object.freeze({
  CLIENT_SIDE_TOOL_V2_WEB_SEARCH: "web_search",
  CLIENT_SIDE_TOOL_V2_WEB_FETCH: "web_fetch",
  CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: "record_screen",
  CLIENT_SIDE_TOOL_V2_COMPUTER_USE: "computer_use",
  CLIENT_SIDE_TOOL_V2_REFLECT: "reflect",
  CLIENT_SIDE_TOOL_V2_ASK_QUESTION: "ask_question",
  CLIENT_SIDE_TOOL_V2_TODO_READ: "read_todos",
  CLIENT_SIDE_TOOL_V2_TODO_WRITE: "update_todos",
  CLIENT_SIDE_TOOL_V2_CREATE_PLAN: "create_plan",
  CLIENT_SIDE_TOOL_V2_SWITCH_MODE: "switch_mode",
  CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: "get_mcp_tools",
  CLIENT_SIDE_TOOL_V2_TASK: "task",
  CLIENT_SIDE_TOOL_V2_TASK_V2: "task",
  CLIENT_SIDE_TOOL_V2_AWAIT_TASK: "await_task",
  CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: "generate_image",
  CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: "generate_image",
  CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: "report_bugfix_results",
  CLIENT_SIDE_TOOL_V2_SEND_TO_USER: "send_to_user",
  CLIENT_SIDE_TOOL_V2_FILE_SEARCH: "file_search",
  CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: "glob_search",
  CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: "semantic_search",
  CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: "deep_search",
  CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: "read_semsearch_files",
  CLIENT_SIDE_TOOL_V2_FETCH_RULES: "fetch_rules",
  CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: "search_symbols",
  CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: "knowledge_base",
  CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: "fetch_pull_request",
  CLIENT_SIDE_TOOL_V2_FIX_LINTS: "fix_lints",
  CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: "go_to_definition",
  CLIENT_SIDE_TOOL_V2_READ_PROJECT: "read_project",
  CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION: "ai_attribution",
  CLIENT_SIDE_TOOL_V2_AWAIT: "await",
  CLIENT_SIDE_TOOL_V2_MCP_AUTH: "mcp_auth",
  CLIENT_SIDE_TOOL_V2_CONNECT_SCM: "connect_scm",
  AGENT_V1_SETUP_VM_ENVIRONMENT: "setup_vm_environment",
  AGENT_V1_REPLACE_ENV: "replace_env",
  AGENT_V1_PR_MANAGEMENT: "pr_management",
  AGENT_V1_FETCH: "fetch",
  BRIDGE_KILL_AGENT: "kill_agent",
  BRIDGE_EXA_SEARCH: "exa_search",
  BRIDGE_EXA_FETCH: "exa_fetch",
  AGENT_V1_SEARCH_CONVERSATIONS: "search_conversations",
  AGENT_V1_CREATE_GOAL: "create_goal",
  AGENT_V1_UPDATE_GOAL: "update_goal",
})

const PROJECTION_FAMILY_BY_DEFINITION_KEY: Readonly<
  Record<string, CursorProjectionToolFamily>
> = Object.freeze({
  CLIENT_SIDE_TOOL_V2_READ_SEMSEARCH_FILES: "read",
  CLIENT_SIDE_TOOL_V2_RIPGREP_SEARCH: "grep",
  CLIENT_SIDE_TOOL_V2_READ_FILE: "read",
  CLIENT_SIDE_TOOL_V2_LIST_DIR: "ls",
  CLIENT_SIDE_TOOL_V2_EDIT_FILE: "edit",
  CLIENT_SIDE_TOOL_V2_FILE_SEARCH: "glob",
  CLIENT_SIDE_TOOL_V2_SEMANTIC_SEARCH_FULL: "sem_search",
  CLIENT_SIDE_TOOL_V2_DELETE_FILE: "delete",
  CLIENT_SIDE_TOOL_V2_REAPPLY: "unknown",
  CLIENT_SIDE_TOOL_V2_RUN_TERMINAL_COMMAND_V2: "shell",
  CLIENT_SIDE_TOOL_V2_FETCH_RULES: "read",
  CLIENT_SIDE_TOOL_V2_WEB_SEARCH: "web_search",
  CLIENT_SIDE_TOOL_V2_MCP: "mcp",
  CLIENT_SIDE_TOOL_V2_SEARCH_SYMBOLS: "sem_search",
  CLIENT_SIDE_TOOL_V2_BACKGROUND_COMPOSER_FOLLOWUP: "truncated",
  CLIENT_SIDE_TOOL_V2_KNOWLEDGE_BASE: "web_search",
  CLIENT_SIDE_TOOL_V2_FETCH_PULL_REQUEST: "web_fetch",
  CLIENT_SIDE_TOOL_V2_DEEP_SEARCH: "sem_search",
  CLIENT_SIDE_TOOL_V2_CREATE_DIAGRAM: "generate_image",
  CLIENT_SIDE_TOOL_V2_FIX_LINTS: "fix_lints",
  CLIENT_SIDE_TOOL_V2_READ_LINTS: "read_lints",
  CLIENT_SIDE_TOOL_V2_GO_TO_DEFINITION: "sem_search",
  CLIENT_SIDE_TOOL_V2_TASK: "task",
  CLIENT_SIDE_TOOL_V2_AWAIT_TASK: "await",
  CLIENT_SIDE_TOOL_V2_TODO_READ: "read_todos",
  CLIENT_SIDE_TOOL_V2_TODO_WRITE: "update_todos",
  CLIENT_SIDE_TOOL_V2_EDIT_FILE_V2: "edit",
  CLIENT_SIDE_TOOL_V2_LIST_DIR_V2: "ls",
  CLIENT_SIDE_TOOL_V2_READ_FILE_V2: "read",
  CLIENT_SIDE_TOOL_V2_RIPGREP_RAW_SEARCH: "grep",
  CLIENT_SIDE_TOOL_V2_GLOB_FILE_SEARCH: "glob",
  CLIENT_SIDE_TOOL_V2_CREATE_PLAN: "create_plan",
  CLIENT_SIDE_TOOL_V2_LIST_MCP_RESOURCES: "list_mcp_resources",
  CLIENT_SIDE_TOOL_V2_READ_MCP_RESOURCE: "read_mcp_resource",
  CLIENT_SIDE_TOOL_V2_READ_PROJECT: "ls",
  CLIENT_SIDE_TOOL_V2_UPDATE_PROJECT: "truncated",
  CLIENT_SIDE_TOOL_V2_TASK_V2: "task",
  CLIENT_SIDE_TOOL_V2_CALL_MCP_TOOL: "mcp",
  CLIENT_SIDE_TOOL_V2_APPLY_AGENT_DIFF: "apply_agent_diff",
  CLIENT_SIDE_TOOL_V2_ASK_QUESTION: "ask_question",
  CLIENT_SIDE_TOOL_V2_SWITCH_MODE: "switch_mode",
  CLIENT_SIDE_TOOL_V2_GENERATE_IMAGE: "generate_image",
  CLIENT_SIDE_TOOL_V2_COMPUTER_USE: "computer_use",
  CLIENT_SIDE_TOOL_V2_WRITE_SHELL_STDIN: "write_shell_stdin",
  CLIENT_SIDE_TOOL_V2_RECORD_SCREEN: "record_screen",
  CLIENT_SIDE_TOOL_V2_WEB_FETCH: "web_fetch",
  CLIENT_SIDE_TOOL_V2_REPORT_BUGFIX_RESULTS: "report_bugfix_results",
  CLIENT_SIDE_TOOL_V2_AI_ATTRIBUTION: "ai_attribution",
  CLIENT_SIDE_TOOL_V2_MCP_AUTH: "mcp_auth",
  CLIENT_SIDE_TOOL_V2_REFLECT: "reflect",
  CLIENT_SIDE_TOOL_V2_AWAIT: "await",
  CLIENT_SIDE_TOOL_V2_GET_MCP_TOOLS: "get_mcp_tools",
  CLIENT_SIDE_TOOL_V2_SEND_TO_USER: "send_to_user",
  CLIENT_SIDE_TOOL_V2_CONNECT_SCM: "connect_scm",
  AGENT_V1_SETUP_VM_ENVIRONMENT: "setup_vm_environment",
  AGENT_V1_REPLACE_ENV: "replace_env",
  AGENT_V1_PR_MANAGEMENT: "pr_management",
  AGENT_V1_BACKGROUND_SHELL_SPAWN: "background_shell_spawn",
  AGENT_V1_FETCH: "fetch",
  AGENT_V1_START_GRIND_EXECUTION: "start_grind_execution",
  AGENT_V1_START_GRIND_PLANNING: "start_grind_planning",
  BRIDGE_KILL_AGENT: "truncated",
  BRIDGE_EXA_SEARCH: "exa_search",
  BRIDGE_EXA_FETCH: "exa_fetch",
  AGENT_V1_SEARCH_CONVERSATIONS: "search_conversations",
  AGENT_V1_CREATE_GOAL: "create_goal",
  AGENT_V1_UPDATE_GOAL: "update_goal",
})

const DEFERRED_FAMILY_BY_RUNTIME_NAME: Readonly<
  Record<string, CursorDeferredToolFamily>
> = Object.freeze({
  command_status: "command_status",
  request_user_input: "request_user_input",
  list_mcp_resource_templates: "list_mcp_resource_templates",
  view_image: "view_image",
  apply_patch: "apply_patch",
  force_background_shell: "force_background_shell",
  force_background_subagent: "force_background_subagent",
  mcp_state_exec: "mcp_state_exec",
  subagent_await: "subagent_await",
  communicate_update: "communicate_update",
  send_final_summary: "send_final_summary",
  blame_by_file_path: "blame_by_file_path",
  report_bug: "report_bug",
  set_active_branch: "set_active_branch",
  request_context: "request_context",
  redacted_read: "redacted_read",
  spawn_agent: "task",
  send_input: "task",
  resume_agent: "task",
  close_agent: "task",
  wait_agent: "await_task",
})

const PROJECTION_FAMILY_BY_RUNTIME_NAME: Readonly<
  Record<string, CursorProjectionToolFamily>
> = Object.freeze({
  request_user_input: "ask_question",
  list_mcp_resource_templates: "list_mcp_resources",
  view_image: "read",
  update_plan: "update_todos",
  discover_tool: "truncated",
  snip_messages: "truncated",
  spawn_agent: "task",
  send_input: "task",
  resume_agent: "task",
  close_agent: "task",
  wait_agent: "await",
  execute_hook: "execute_hook",
  force_background_shell: "force_background_shell",
  force_background_subagent: "force_background_subagent",
  canvas_get_url: "canvas_get_url",
  canvas_destroy: "canvas_destroy",
  canvas_register: "canvas_register",
  mcp_state_exec: "mcp_state_exec",
  subagent_await: "subagent_await",
  communicate_update: "communicate_update",
  send_final_summary: "send_final_summary",
  blame_by_file_path: "blame_by_file_path",
  report_bug: "report_bug",
  set_active_branch: "set_active_branch",
  request_context: "request_context",
  redacted_read: "redacted_read",
  pi_read: "pi_read",
  pi_bash: "pi_bash",
  pi_edit: "pi_edit",
  pi_write: "pi_write",
  pi_grep: "pi_grep",
  pi_find: "pi_find",
  pi_ls: "pi_ls",
})

export function getCursorDeferredFamilyForDefinitionKey(
  definitionKey: string
): CursorDeferredToolFamily | undefined {
  return DEFERRED_FAMILY_BY_DEFINITION_KEY[definitionKey]
}

export function getCursorProjectionFamilyForDefinitionKey(
  definitionKey: string
): CursorProjectionToolFamily | undefined {
  return PROJECTION_FAMILY_BY_DEFINITION_KEY[definitionKey]
}

export function getCursorDeferredFamilyForRuntimeName(
  toolName: string
): CursorDeferredToolFamily | undefined {
  return DEFERRED_FAMILY_BY_RUNTIME_NAME[toolName]
}

export function getCursorProjectionFamilyForRuntimeName(
  toolName: string
): CursorProjectionToolFamily | undefined {
  return PROJECTION_FAMILY_BY_RUNTIME_NAME[toolName]
}
