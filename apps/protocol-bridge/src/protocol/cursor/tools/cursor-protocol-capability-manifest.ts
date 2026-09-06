/**
 * Authoritative bridge capability classification for every official
 * `agent.v1.ToolCall.tool` oneof case.
 *
 * The protobuf descriptor answers only "does this wire case exist?". It does
 * not answer whether the bridge can execute it, whether it is model-facing,
 * or whether a particular turn advertised it. Keeping those facts explicit
 * prevents smoke reports from treating every unobserved proto branch as an
 * unavailable user capability.
 */

export type CursorToolCallFamily =
  | "filesystem_read"
  | "filesystem_write"
  | "shell"
  | "search"
  | "diagnostics"
  | "planning_todos"
  | "network"
  | "mcp"
  | "subagent"
  | "ide_interaction"
  | "scm_pr_cloud"
  | "reporting"
  | "grind"
  | "pi"
  | "conversation"
  | "protocol_guard"

export type CursorToolCallSupport =
  | "implemented"
  | "projection_only"
  | "unsupported"
  | "protocol_guard"

export type CursorToolCallExposurePolicy =
  | "default"
  | "capability_gated"
  | "workflow_only"
  | "not_model_callable"
  | "unsupported"
  | "internal"

export interface CursorToolCallCapability {
  readonly caseId: string
  readonly family: CursorToolCallFamily
  readonly support: CursorToolCallSupport
  readonly exposurePolicy: CursorToolCallExposurePolicy
  /** Provider-visible tool names that can project to this ToolCall case. */
  readonly modelToolNames: readonly string[]
  /** Gate or architectural boundary, stated as a stable project fact. */
  readonly reason: string
}

function capability(
  caseId: string,
  family: CursorToolCallFamily,
  support: CursorToolCallSupport,
  exposurePolicy: CursorToolCallExposurePolicy,
  modelToolNames: readonly string[],
  reason: string
): CursorToolCallCapability {
  return Object.freeze({
    caseId,
    family,
    support,
    exposurePolicy,
    modelToolNames: Object.freeze([...modelToolNames]),
    reason,
  })
}

export const CURSOR_TOOL_CALL_CAPABILITIES: readonly CursorToolCallCapability[] =
  Object.freeze([
    capability(
      "readToolCall",
      "filesystem_read",
      "implemented",
      "default",
      ["read_file", "read_semsearch_files", "fetch_rules"],
      "bridge and Cursor client provide an end-to-end read projection"
    ),
    capability(
      "lsToolCall",
      "filesystem_read",
      "implemented",
      "default",
      ["list_directory", "read_project"],
      "bridge and Cursor client provide an end-to-end directory projection"
    ),
    capability(
      "globToolCall",
      "filesystem_read",
      "implemented",
      "default",
      ["file_search", "glob_search"],
      "bridge projects file-name and glob search through the official case"
    ),
    capability(
      "editToolCall",
      "filesystem_write",
      "implemented",
      "default",
      ["edit_file", "edit_file_v2"],
      "bridge and Cursor client provide an end-to-end edit projection"
    ),
    capability(
      "deleteToolCall",
      "filesystem_write",
      "implemented",
      "default",
      ["delete_file"],
      "bridge and Cursor client provide an end-to-end delete projection"
    ),
    capability(
      "shellToolCall",
      "shell",
      "implemented",
      "default",
      ["run_terminal_command", "background_shell_spawn"],
      "foreground and background shell tools share the official shell case"
    ),
    capability(
      "writeShellStdinToolCall",
      "shell",
      "implemented",
      "default",
      ["write_shell_stdin"],
      "available when the shell surface is present"
    ),
    capability(
      "grepToolCall",
      "search",
      "implemented",
      "default",
      ["grep_search"],
      "regular grep uses the official GrepArgs and GrepResult pair"
    ),
    capability(
      "semSearchToolCall",
      "search",
      "implemented",
      "default",
      ["semantic_search", "deep_search", "search_symbols", "go_to_definition"],
      "semantic and symbol search tools project through the official semantic-search case"
    ),
    capability(
      "readLintsToolCall",
      "diagnostics",
      "implemented",
      "capability_gated",
      ["read_lints"],
      "request_context.read_lints_enabled can disable this capability"
    ),
    capability(
      "createPlanToolCall",
      "planning_todos",
      "implemented",
      "default",
      ["create_plan"],
      "plan creation has an end-to-end interaction and ToolCall result"
    ),
    capability(
      "updateTodosToolCall",
      "planning_todos",
      "implemented",
      "default",
      ["update_todos"],
      "todo mutation is bridge-owned and durably projected"
    ),
    capability(
      "readTodosToolCall",
      "planning_todos",
      "implemented",
      "default",
      ["read_todos"],
      "todo reads are bridge-owned and durably projected"
    ),
    capability(
      "createGoalToolCall",
      "planning_todos",
      "implemented",
      "default",
      ["create_goal"],
      "goal creation is bridge-owned and durably projected into ConversationStateStructure.goal_state"
    ),
    capability(
      "updateGoalToolCall",
      "planning_todos",
      "implemented",
      "default",
      ["update_goal"],
      "goal status updates are bridge-owned and durably projected into ConversationStateStructure.goal_state"
    ),
    capability(
      "webSearchToolCall",
      "network",
      "implemented",
      "capability_gated",
      ["web_search", "exa_search", "knowledge_base"],
      "request_context.web_search_enabled and provider availability control exposure"
    ),
    capability(
      "webFetchToolCall",
      "network",
      "implemented",
      "capability_gated",
      ["web_fetch", "exa_fetch", "fetch_pull_request"],
      "request_context.web_fetch_enabled and provider availability control exposure"
    ),
    capability(
      "fetchToolCall",
      "network",
      "implemented",
      "default",
      ["fetch"],
      "direct URL fetch has an end-to-end bridge executor"
    ),
    capability(
      "mcpToolCall",
      "mcp",
      "implemented",
      "capability_gated",
      ["mcp_tool"],
      "concrete MCP calls require a mounted server/tool definition"
    ),
    capability(
      "listMcpResourcesToolCall",
      "mcp",
      "implemented",
      "capability_gated",
      ["list_mcp_resources", "list_mcp_resource_templates"],
      "resource enumeration requires a mounted MCP server"
    ),
    capability(
      "readMcpResourceToolCall",
      "mcp",
      "implemented",
      "capability_gated",
      ["read_mcp_resource"],
      "resource reads require a mounted MCP server and advertised resource"
    ),
    capability(
      "getMcpToolsToolCall",
      "mcp",
      "implemented",
      "capability_gated",
      ["get_mcp_tools"],
      "tool discovery is meaningful only for the current frozen MCP registry"
    ),
    capability(
      "mcpAuthToolCall",
      "mcp",
      "implemented",
      "capability_gated",
      ["mcp_auth"],
      "authentication is invoked only after a real MCP auth requirement"
    ),
    capability(
      "taskToolCall",
      "subagent",
      "implemented",
      "default",
      ["task"],
      "task uses the frozen sub-agent registry advertised for the turn"
    ),
    capability(
      "awaitToolCall",
      "subagent",
      "implemented",
      "default",
      ["await_task", "await"],
      "await operates on a real durable background task identity"
    ),
    capability(
      "applyAgentDiffToolCall",
      "ide_interaction",
      "implemented",
      "workflow_only",
      ["apply_agent_diff"],
      "requires a diff already owned by a real Cursor agent"
    ),
    capability(
      "askQuestionToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["ask_question"],
      "question interaction is end-to-end"
    ),
    capability(
      "switchModeToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["switch_mode"],
      "mode switching is end-to-end when the IDE supplies valid modes"
    ),
    capability(
      "generateImageToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["generate_image", "create_diagram"],
      "image and diagram generation project through the official image case"
    ),
    capability(
      "recordScreenToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["record_screen"],
      "screen recording is executed by the bridge/IDE integration"
    ),
    capability(
      "computerUseToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["computer_use"],
      "computer-use is executed only when the current environment can perform the actions"
    ),
    capability(
      "reflectToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["reflect"],
      "reflect is a bridge-owned inline operation with an official projection"
    ),
    capability(
      "setupVmEnvironmentToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["setup_vm_environment"],
      "Cursor client owns the setup interaction and the bridge preserves its ToolCall lifecycle"
    ),
    capability(
      "replaceEnvToolCall",
      "ide_interaction",
      "implemented",
      "default",
      ["replace_env"],
      "Cursor client owns environment replacement and the bridge preserves both result variants"
    ),
    capability(
      "aiAttributionToolCall",
      "scm_pr_cloud",
      "implemented",
      "default",
      ["ai_attribution"],
      "AI attribution has a bridge definition and official projection"
    ),
    capability(
      "prManagementToolCall",
      "scm_pr_cloud",
      "implemented",
      "default",
      ["pr_management"],
      "all four PR actions and all five official result variants use the Cursor interaction path"
    ),
    capability(
      "blameByFilePathToolCall",
      "scm_pr_cloud",
      "projection_only",
      "not_model_callable",
      ["blame_by_file_path"],
      "serialization exists but no parent model-facing executor is advertised"
    ),
    capability(
      "setActiveBranchToolCall",
      "scm_pr_cloud",
      "projection_only",
      "not_model_callable",
      ["set_active_branch"],
      "serialization exists but no parent model-facing executor is advertised"
    ),
    capability(
      "updatePrCodeTourToolCall",
      "scm_pr_cloud",
      "unsupported",
      "unsupported",
      ["update_pr_code_tour"],
      "official case exists without a complete bridge handler"
    ),
    capability(
      "editPrLabelsToolCall",
      "scm_pr_cloud",
      "unsupported",
      "unsupported",
      ["edit_pr_labels"],
      "official case exists without a complete bridge handler"
    ),
    capability(
      "recordCiInvestigationFindingsToolCall",
      "scm_pr_cloud",
      "unsupported",
      "unsupported",
      ["record_ci_investigation_findings"],
      "official case exists without a complete bridge handler"
    ),
    capability(
      "sendMessageToolCall",
      "scm_pr_cloud",
      "unsupported",
      "unsupported",
      ["send_message"],
      "official case exists without a complete bridge handler"
    ),
    capability(
      "fetchCloudAgentDataToolCall",
      "scm_pr_cloud",
      "unsupported",
      "unsupported",
      ["fetch_cloud_agent_data"],
      "official case exists without a complete bridge handler"
    ),
    capability(
      "connectScmToolCall",
      "scm_pr_cloud",
      "implemented",
      "default",
      ["connect_scm"],
      "GitHub connection approval is executed by Cursor through the official interaction pair"
    ),
    capability(
      "reportBugfixResultsToolCall",
      "reporting",
      "implemented",
      "default",
      ["report_bugfix_results"],
      "structured bugfix reporting is bridge-owned"
    ),
    capability(
      "reportBugToolCall",
      "reporting",
      "projection_only",
      "not_model_callable",
      ["report_bug"],
      "serialization exists but no parent model-facing executor is advertised"
    ),
    capability(
      "communicateUpdateToolCall",
      "reporting",
      "projection_only",
      "not_model_callable",
      ["communicate_update"],
      "runtime updates can be projected but are not a normal provider tool"
    ),
    capability(
      "sendFinalSummaryToolCall",
      "reporting",
      "projection_only",
      "not_model_callable",
      ["send_final_summary"],
      "final-summary projection is a runtime reporting branch, not a normal provider tool"
    ),
    capability(
      "sendToUserToolCall",
      "reporting",
      "implemented",
      "capability_gated",
      ["send_to_user"],
      "requires AgentRunRequest.client_supports_send_to_user"
    ),
    capability(
      "startGrindExecutionToolCall",
      "grind",
      "unsupported",
      "unsupported",
      ["start_grind_execution"],
      "wire case is retained but the bridge has no grind executor"
    ),
    capability(
      "startGrindPlanningToolCall",
      "grind",
      "unsupported",
      "unsupported",
      ["start_grind_planning"],
      "wire case is retained but the bridge has no grind executor"
    ),
    capability(
      "piReadToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_read"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "piBashToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_bash"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "piEditToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_edit"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "piWriteToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_write"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "piGrepToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_grep"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "piFindToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_find"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "piLsToolCall",
      "pi",
      "projection_only",
      "not_model_callable",
      ["pi_ls"],
      "official PI ToolCall/Exec serializers exist but PI is not a parent provider tool"
    ),
    capability(
      "searchConversationsToolCall",
      "conversation",
      "implemented",
      "capability_gated",
      ["search_conversations"],
      "requires request_context.search_conversations_enabled"
    ),
    capability(
      "truncatedToolCall",
      "protocol_guard",
      "protocol_guard",
      "internal",
      [],
      "guard/fallback projection for explicitly known tools without a dedicated oneof; never a capability claim"
    ),
    ...[
      ["adoptToolCall", "adopt"],
      ["getAgentStatusToolCall", "get_agent_status"],
      ["sendToAgentToolCall", "send_to_agent"],
      ["readAgentTranscriptToolCall", "read_agent_transcript"],
      ["createAgentToolCall", "create_agent"],
      ["stopAgentToolCall", "stop_agent"],
      ["getPrCodeTourToolCall", "get_pr_code_tour"],
    ].map(([caseId, toolName]) =>
      capability(
        caseId!,
        "scm_pr_cloud",
        "unsupported",
        "unsupported",
        [toolName!],
        "requires the official cloud agent/store or PR service; not exposed by the local Composer tool contract"
      )
    ),
  ])

export function getCursorToolCallCapability(
  caseId: string
): CursorToolCallCapability | undefined {
  return CURSOR_TOOL_CALL_CAPABILITIES.find((entry) => entry.caseId === caseId)
}
