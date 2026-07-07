/**
 * Cursor Skills 子系统的数据模型与公共契约。
 *
 * 设计参考：
 * - Anthropic Claude Code 的 SkillTool/DiscoverSkillsTool（双工具 + token 预算）
 * - OpenAI Codex 的 core-skills（多 Scope + 富 metadata + 显式 mention）
 *
 * Cursor 协议本身只规定 `SkillDescriptor` 字段（name/description/paths/whenToUse），
 * 激活时机、token 预算、生命周期、执行隔离等问题都由实现方决定。
 * 这里把这些决策集中沉淀在 skills/ 目录中。
 */

import type { CursorRule, SkillOptions } from "../../../gen/agent/v1_pb"

/**
 * Skill 被认定为 active 的原因。
 *
 * 优先级 required > manual > selected > previously_loaded > path_match。
 */
export type CursorSkillActivationReason =
  | "required"
  | "manual"
  | "selected"
  | "previously_loaded"
  | "path_match"

/**
 * 解析后的 Skill metadata + 当前激活状态。
 *
 * 内容字段（fullPath/content）只用于激活后注入 prompt；inactive 状态下
 * 仍保留 content 是为了 fetch_rules 直接返回（避免再次读盘）。
 */
export interface CursorSkillMetadata {
  name: string
  description?: string
  whenToUse?: string
  paths: string[]
  fullPath: string
  content: string
  ruleType?: string
  enabled?: boolean
  parseError?: string
  folderPath?: string
  readmeFilePath?: string
  packageType?: number
  ruleSource?: CursorRule["source"]
  gitRemoteOrigin?: string
  plugin?: string
  marketplace?: string
  pluginId?: string
  marketplaceId?: string
  active: boolean
  activationReason?: CursorSkillActivationReason
}

/**
 * 计算 Skill 激活策略时所需的输入。
 *
 * 字段语义：
 * - rules：从 Cursor 客户端收到的所有规则（含非 Skill 类）
 * - selectedRulePaths/Names：当前轮次用户在 IDE 中显式选中的 Skill
 * - activeSkillNames：会话历史中已经激活过的 Skill（持久状态）
 * - projectRoot：用于 paths glob 匹配时的相对路径解析
 * - contextPaths：当前轮次涉及的文件路径（用于 path_match 自动激活）
 * - environmentNames：当前 bridge/IDE 环境名，用于 environments / disabled_environments
 * - scopePaths：当前项目/工作区路径，用于 scoped_to
 */
export interface CursorSkillPolicyInput {
  rules?: CursorRule[]
  skillOptions?: SkillOptions
  selectedRulePaths?: string[]
  selectedRuleNames?: string[]
  activeSkillNames?: string[]
  projectRoot?: string
  contextPaths?: string[]
  environmentNames?: string[]
  scopePaths?: string[]
}

/**
 * 策略计算结果。
 *
 * - promptRules：注入到系统 prompt 中的 rule 列表（active skill + 普通 rule）
 * - availableSkills：所有可用 Skill（含 active 与 inactive）
 * - activeSkills：本轮已激活
 * - inactiveSkills / suppressedSkills：未激活，前者用于 metadata 展示，
 *   后者用于日志告警。当前实现下两者集合等价，留出语义位置便于将来分化。
 */
export interface CursorSkillPolicyResult {
  promptRules: CursorRule[]
  availableSkills: CursorSkillMetadata[]
  activeSkills: CursorSkillMetadata[]
  inactiveSkills: CursorSkillMetadata[]
  suppressedSkills: CursorSkillMetadata[]
}

/**
 * Skill catalog 渲染时的 token 预算策略。
 *
 * 参考 Claude Code：默认 1% 上下文窗口。这里改用绝对字符数，避免在
 * 不知道目标模型 contextWindow 的场景下过度复杂。调用方可以传入自定义值。
 */
export interface CursorSkillCatalogBudget {
  /** Skill 列表整体可占用的最大字符数；默认 4000。 */
  maxTotalChars?: number
  /** 单个 Skill description 截断长度；默认 220。 */
  maxDescriptionChars?: number
  /** 最多展示多少个 Skill；默认 24。 */
  maxItems?: number
}

/**
 * Skill 搜索匹配项。
 */
export interface CursorSkillSearchHit {
  skill: CursorSkillMetadata
  score: number
  /** 命中的字段（用于调试/解释）。 */
  matchedFields: Array<"name" | "description" | "whenToUse" | "paths">
}
