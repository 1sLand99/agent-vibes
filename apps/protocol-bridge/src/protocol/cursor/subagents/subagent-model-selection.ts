import type { AgentRunRequest } from "../../../gen/agent/v1_pb"
import type { ResolvedSubagentOverride } from "./subagent-model-override"

/**
 * Request-scoped catalog of model ids Cursor permits the parent model to
 * choose through `TaskArgs.model`.
 *
 * Cursor sends this authority separately from per-agent settings:
 * `selected_subagent_models` is the allow-list for an invocation-level model
 * choice, while `subagent_model_overrides` is the user's authoritative
 * setting for one concrete subagent type. Keeping the two facts distinct
 * prevents a model from inventing an unavailable id and accidentally
 * bypassing "Inherit from parent" in Cursor settings.
 */
export interface SelectedSubagentModelCatalog {
  has(modelId: string): boolean
  ids(): readonly string[]
  isEmpty(): boolean
}

export const EMPTY_SELECTED_SUBAGENT_MODELS: SelectedSubagentModelCatalog =
  Object.freeze({
    has: () => false,
    ids: () => Object.freeze([]),
    isEmpty: () => true,
  })

export function parseSelectedSubagentModels(
  request: Pick<AgentRunRequest, "selectedSubagentModels">
): SelectedSubagentModelCatalog {
  const selected = request.selectedSubagentModels
  if (!selected || selected.length === 0) {
    return EMPTY_SELECTED_SUBAGENT_MODELS
  }

  const ids: string[] = []
  const allowed = new Set<string>()
  for (const requested of selected) {
    const modelId = requested.modelId
    if (!modelId || modelId.trim().length === 0) {
      throw new Error("Selected subagent model id is required")
    }
    if (modelId.trim() !== modelId) {
      throw new Error(
        `Selected subagent model id must not contain leading or trailing whitespace: ${modelId}`
      )
    }
    if (allowed.has(modelId)) {
      throw new Error(`Duplicate selected subagent model id: ${modelId}`)
    }
    allowed.add(modelId)
    ids.push(modelId)
  }
  const frozenIds = Object.freeze([...ids])
  return Object.freeze({
    has(modelId: string) {
      return allowed.has(modelId)
    },
    ids() {
      return frozenIds
    },
    isEmpty() {
      return frozenIds.length === 0
    },
  })
}

export type SubagentModelSelectionSource =
  | "cursor-model-override"
  | "cursor-inherit-override"
  | "task-model"
  | "agent-definition"
  | "parent"

export interface ResolvedSubagentModelSelection {
  modelId: string
  source: SubagentModelSelectionSource
}

export interface ResolveSubagentModelSelectionInput {
  parentModel: string
  cursorOverride?: ResolvedSubagentOverride
  requestedTaskModel?: string
  agentDefinitionModel?: string
  selectedTaskModels: SelectedSubagentModelCatalog
}

/**
 * Resolve one child model from Cursor protocol authority.
 *
 * Precedence is deliberately Cursor-first:
 *  1. A per-subagent Cursor setting (`model`, `inherit`, or `disabled`).
 *  2. An invocation model only when Cursor advertised that exact id in
 *     `selected_subagent_models` for this request.
 *  3. The agent definition's declared model.
 *  4. The exact parent model.
 *
 * This differs from Claude Code's standalone Agent tool precedence because
 * Cursor has a separate, user-owned `SubagentModelOverride` protocol. The
 * provider-authored task arguments cannot overrule that setting.
 */
export function resolveSubagentModelSelection(
  input: ResolveSubagentModelSelectionInput
): ResolvedSubagentModelSelection {
  const parentModel = input.parentModel.trim()
  if (!parentModel) {
    throw new Error("Sub-agent model selection requires a parent model")
  }

  switch (input.cursorOverride?.kind) {
    case "model":
      return {
        modelId: input.cursorOverride.modelId,
        source: "cursor-model-override",
      }
    case "inherit":
      return {
        modelId: parentModel,
        source: "cursor-inherit-override",
      }
    case "disabled":
      throw new Error("Sub-agent type is disabled in Cursor settings")
  }

  const requestedTaskModel = input.requestedTaskModel?.trim()
  if (requestedTaskModel) {
    if (!input.selectedTaskModels.has(requestedTaskModel)) {
      const selected = input.selectedTaskModels.ids()
      const suffix =
        selected.length > 0
          ? ` Available task models: ${selected.join(", ")}.`
          : " Cursor did not advertise any invocation-level task models."
      throw new Error(
        `Task requested unavailable sub-agent model ${requestedTaskModel}. ` +
          `Omit \`model\` to inherit the parent model.${suffix}`
      )
    }
    return { modelId: requestedTaskModel, source: "task-model" }
  }

  const definitionModel = input.agentDefinitionModel?.trim()
  if (definitionModel && definitionModel !== "inherit") {
    return { modelId: definitionModel, source: "agent-definition" }
  }
  return { modelId: parentModel, source: "parent" }
}
