import { getCodexModelProfile } from "./codex-model-catalog"
import { parseModelRequest } from "../shared/model-request"
import {
  CODEX_FALLBACK_BASE_INSTRUCTIONS,
  CODEX_MODEL_INSTRUCTION_CATALOG,
  type GeneratedCodexModelInstructionEntry,
  type GeneratedCodexModelMessages,
} from "./codex-model-instructions.generated"

export type CodexInstructionPersonality = "none" | "friendly" | "pragmatic"

export interface CodexModelInstructionResolution {
  model: string
  source: "catalog" | "fallback"
  instructions: string
  includeSkillsUsageInstructions: boolean
}

const PERSONALITY_PLACEHOLDER = "{{ personality }}"
const DEFAULT_PERSONALITY_HEADER =
  "You are Codex, a coding agent based on GPT-5. You and the user share the same workspace and collaborate to achieve the user's goals."
const LOCAL_FRIENDLY_TEMPLATE =
  "You optimize for team morale and being a supportive teammate as much as code quality."
const LOCAL_PRAGMATIC_TEMPLATE =
  "You are a deeply pragmatic, effective software engineer."

const GENERATED_CATALOG = CODEX_MODEL_INSTRUCTION_CATALOG as Record<
  string,
  GeneratedCodexModelInstructionEntry
>

function normalizeCodexModelId(modelId: string): string {
  return parseModelRequest(modelId || "").normalizedBaseModel
}

function buildFallbackInstructionEntry(
  normalizedModel: string
): GeneratedCodexModelInstructionEntry {
  const modelMessages = localPersonalityMessagesForSlug(normalizedModel)
  return modelMessages
    ? {
        baseInstructions: CODEX_FALLBACK_BASE_INSTRUCTIONS,
        modelMessages,
        includeSkillsUsageInstructions: false,
      }
    : {
        baseInstructions: CODEX_FALLBACK_BASE_INSTRUCTIONS,
        includeSkillsUsageInstructions: false,
      }
}

function localPersonalityMessagesForSlug(
  normalizedModel: string
): GeneratedCodexModelMessages | undefined {
  if (
    normalizedModel !== "gpt-5.2-codex" &&
    normalizedModel !== "exp-codex-personality"
  ) {
    return undefined
  }

  return {
    instructionsTemplate: [
      DEFAULT_PERSONALITY_HEADER,
      "",
      PERSONALITY_PLACEHOLDER,
      "",
      CODEX_FALLBACK_BASE_INSTRUCTIONS,
    ].join("\n"),
    instructionsVariables: {
      personalityDefault: "",
      personalityFriendly: LOCAL_FRIENDLY_TEMPLATE,
      personalityPragmatic: LOCAL_PRAGMATIC_TEMPLATE,
    },
  }
}

function getPersonalityMessage(
  modelMessages: GeneratedCodexModelMessages,
  personality?: CodexInstructionPersonality | null
): string | undefined {
  const variables = modelMessages.instructionsVariables
  if (!variables) {
    return undefined
  }

  switch (personality) {
    case "none":
      return ""
    case "friendly":
      return variables.personalityFriendly
    case "pragmatic":
      return variables.personalityPragmatic
    default:
      return variables.personalityDefault
  }
}

export function resolveCodexModelInstructionEntry(modelId: string): {
  normalizedModel: string
  source: "catalog" | "fallback"
  entry: GeneratedCodexModelInstructionEntry
} {
  const normalizedModel = normalizeCodexModelId(modelId)
  const profile = getCodexModelProfile(normalizedModel)
  if (profile && typeof profile.base_instructions === "string") {
    const messages = profile.model_messages as
      | {
          instructions_template?: string
          instructions_variables?: Record<string, string>
        }
      | undefined
    return {
      normalizedModel,
      source: "catalog",
      entry: {
        baseInstructions: profile.base_instructions,
        includeSkillsUsageInstructions:
          profile.include_skills_usage_instructions === true,
        modelMessages: messages
          ? {
              instructionsTemplate: messages.instructions_template,
              instructionsVariables: messages.instructions_variables
                ? {
                    personalityDefault:
                      messages.instructions_variables.personality_default,
                    personalityFriendly:
                      messages.instructions_variables.personality_friendly,
                    personalityPragmatic:
                      messages.instructions_variables.personality_pragmatic,
                  }
                : undefined,
            }
          : undefined,
      },
    }
  }
  const catalogEntry = GENERATED_CATALOG[normalizedModel]
  if (catalogEntry) {
    return {
      normalizedModel,
      source: "catalog",
      entry: catalogEntry,
    }
  }

  return {
    normalizedModel,
    source: "fallback",
    entry: buildFallbackInstructionEntry(normalizedModel),
  }
}

export function resolveCodexModelInstructions(
  modelId: string,
  options: {
    personality?: CodexInstructionPersonality | null
  } = {}
): CodexModelInstructionResolution {
  const { normalizedModel, source, entry } =
    resolveCodexModelInstructionEntry(modelId)
  const template = entry.modelMessages?.instructionsTemplate

  if (template) {
    const personalityMessage =
      getPersonalityMessage(entry.modelMessages!, options.personality) || ""
    return {
      model: normalizedModel,
      source,
      instructions: template.replace(
        PERSONALITY_PLACEHOLDER,
        personalityMessage
      ),
      includeSkillsUsageInstructions:
        entry.includeSkillsUsageInstructions === true,
    }
  }

  return {
    model: normalizedModel,
    source,
    instructions: entry.baseInstructions,
    includeSkillsUsageInstructions:
      entry.includeSkillsUsageInstructions === true,
  }
}
