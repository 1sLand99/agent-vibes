/**
 * Cursor Skills 子系统对外入口。
 *
 * 上层模块统一通过这里访问；avoid 直接 import 具体文件，便于将来重构。
 */

export { CursorSkillsManager } from "./cursor-skills.manager"
export type { CursorSkillsPromptContext } from "./cursor-skills.manager"
export {
  CURSOR_SKILL_ACTIVATION_RECEIPTS_METADATA_KEY,
  type CursorSkillActivationReceipt,
  type DurableToolSkillActivationMetadata,
} from "./skill-activation-receipt"

export {
  extractCursorRuleFrontmatterName,
  normalizePathForMatch,
  normalizeSkillName,
  parseSkillFrontmatter,
} from "./frontmatter"

export {
  findCursorSkillByName,
  findCursorSkillForInternalPath,
  getCursorSkillMetadata,
  resolveCursorSkillPolicy,
} from "./policy"

export { renderCursorSkillsCatalog } from "./catalog"
export { searchCursorSkills } from "./search"

export type {
  CursorSkillActivationReason,
  CursorSkillCatalogBudget,
  CursorSkillMetadata,
  CursorSkillPolicyInput,
  CursorSkillPolicyResult,
  CursorSkillSearchHit,
} from "./types"
