/**
 * CursorSkillsManager —— Skill 子系统的统一入口。
 *
 * 设计意图：
 *   - 把原先散落在 cursor-connect-stream.service.ts 中的 7 个 private 方法
 *     （resolveCursorSkillPolicyForPrompt / buildCursorSkillsCatalogSection /
 *      isCursorSkillActive / activateCursorSkillForSession / activateCursorSkillsForPath /
 *      buildInactiveCursorSkillToolError / pickCursorSkillTargetPath）集中到本类。
 *   - 提供「只读策略求解」「会话级激活/卸载」「工具访问拦截」「Skill 搜索」四组 API。
 *   - Service 自身保持无状态（state 全部寄存在 SessionRecord 上），便于水平扩展。
 *
 * 模型对照：
 *   - Anthropic Claude Code SkillsManager（getSkillToolCommands + permission）
 *   - OpenAI Codex SkillsManager（cache + scope + restriction_product）
 *   本实现是 Cursor 协议的轻量适配版，专注 session 内激活策略与 prompt 注入。
 */

import { Injectable, Logger } from "@nestjs/common"
import type { CursorRule, SkillOptions } from "../../../gen/agent/v1_pb"
import type { SessionRecord } from "../session/session-lifecycle.service"
import { SessionLifecycleService } from "../session/session-lifecycle.service"
import { WorkspaceScope } from "../session/workspace-scope"
import { renderCursorSkillsCatalog } from "./catalog"
import { normalizePathForMatch, normalizeSkillName } from "./frontmatter"
import type { CursorSkillActivationReceipt } from "./skill-activation-receipt"
import {
  findCursorSkillByName,
  findCursorSkillForInternalPath,
  resolveCursorSkillPolicy,
} from "./policy"
import { searchCursorSkills } from "./search"
import type {
  CursorSkillCatalogBudget,
  CursorSkillMetadata,
  CursorSkillPolicyInput,
  CursorSkillPolicyResult,
  CursorSkillSearchHit,
} from "./types"

/** Service 接受的 Prompt 上下文子集；保持与 PromptContext 兼容。 */
export interface CursorSkillsPromptContext {
  /** Canonical live or restored workspace authority for this prompt build. */
  workspaceScope: WorkspaceScope
  cursorRules?: CursorRule[]
  skillOptions?: SkillOptions
  selectedCursorRulePaths?: string[]
  selectedCursorRuleNames?: string[]
  activeCursorSkillNames?: string[]
  codeChunks?: Array<{ path: string }>
}

const DEFAULT_CURSOR_SKILL_ENVIRONMENTS = [
  "cursor",
  "vscode",
  "agent",
  "agent-vibes",
]

@Injectable()
export class CursorSkillsManager {
  private readonly logger = new Logger(CursorSkillsManager.name)

  /**
   * Per-session dedupe ledger for the "Suppressed N inactive Cursor skill
   * rule(s)" WARN. Without this guard the same line is emitted on every
   * prompt rebuild (227 occurrences observed in the smoke regression's
   * 20-minute bridge log for a single session). The ledger keys on
   * conversationId + sorted suppressed-skill-name fingerprint so a real
   * change in suppressed set still surfaces a fresh WARN; pure
   * repetition is silenced.
   *
   * Memory bound: keyed by conversationId, cleared via
   * `forgetSession`. The Set per session is at most O(K) where K is the
   * number of distinct suppressed-skill fingerprints observed in that
   * session — in practice K ≤ 3 since the catalog rarely changes mid-
   * session.
   */
  private readonly suppressedSkillsWarnedFingerprints = new Map<
    string,
    Set<string>
  >()

  constructor(private readonly sessionManager: SessionLifecycleService) {}

  /* ---------------- 策略求解 ---------------- */

  /** 以 PromptContext 求解策略，并对 suppressed Skill 输出诊断日志。 */
  resolvePolicyForPrompt(
    context: CursorSkillsPromptContext
  ): CursorSkillPolicyResult {
    const policy = resolveCursorSkillPolicy(this.toPolicyInput(context))
    if (policy.suppressedSkills.length > 0) {
      const conversationId = this.deriveDedupeSessionKey(context)
      const fingerprint = policy.suppressedSkills
        .map((skill) => skill.name)
        .sort()
        .join("|")
      const seenForSession =
        this.suppressedSkillsWarnedFingerprints.get(conversationId) ??
        new Set<string>()
      if (!seenForSession.has(fingerprint)) {
        seenForSession.add(fingerprint)
        this.suppressedSkillsWarnedFingerprints.set(
          conversationId,
          seenForSession
        )
        this.logger.debug(
          `Omitted ${policy.suppressedSkills.length} inactive Cursor skill(s) from prompt: ` +
            policy.suppressedSkills.map((skill) => skill.name).join(", ") +
            "; use fetch_rules({ skill_name }) to load a skill before applying its workflow"
        )
      }
    }
    return policy
  }

  /**
   * Derive the dedupe key for the suppressed-skills WARN. Falls back to
   * `__no_session__` only when no scope exists. Prompt contexts must carry a
   * canonical WorkspaceScope, so the scope fingerprint keeps root grants and
   * primary selection from being conflated in diagnostics.
   */
  private deriveDedupeSessionKey(context: CursorSkillsPromptContext): string {
    return `scope:${context.workspaceScope.scopeFingerprint}`
  }

  /**
   * Drop dedupe ledger entries for a session. Called by SessionLifecycleService
   * when a session is closed so long-running bridges do not slowly leak
   * fingerprints. Safe no-op when the session was never seen.
   */
  forgetSession(conversationId: string): void {
    if (!conversationId) return
    this.suppressedSkillsWarnedFingerprints.delete(conversationId)
  }

  /** 直接以 SessionRecord 求解策略；用于 fetch_rules 等运行时调用。 */
  resolvePolicyForSession(
    session: SessionRecord,
    extraContextPaths: string[] = []
  ): CursorSkillPolicyResult {
    return resolveCursorSkillPolicy(
      this.toPolicyInputFromSession(session, extraContextPaths)
    )
  }

  /** 暴露底层 policy 求解，便于 parser 等场景按自定义 input 调用。 */
  resolvePolicy(input: CursorSkillPolicyInput): CursorSkillPolicyResult {
    return resolveCursorSkillPolicy(input)
  }

  /* ---------------- Catalog 渲染 ---------------- */

  /** 渲染 Skill 目录段落；空列表返回 null。 */
  buildCatalogSection(
    skills: CursorSkillMetadata[],
    budget?: CursorSkillCatalogBudget
  ): string | null {
    return renderCursorSkillsCatalog(skills, budget)
  }

  /* ---------------- 会话级激活/卸载 ---------------- */

  /** 判定 Skill 是否在当前会话中处于激活态。 */
  isActive(session: SessionRecord, skillName: string): boolean {
    const normalized = normalizeSkillName(skillName)
    if (!normalized) return false
    if (
      (session.activeCursorSkillNames || []).some(
        (name) => normalizeSkillName(name) === normalized
      )
    ) {
      return true
    }
    return this.resolvePolicyForSession(session).activeSkills.some(
      (skill) => skill.name === normalized
    )
  }

  /**
   * Produce an immutable activation receipt without changing session state.
   * The receipt belongs to the matching tool-result graph commit.
   */
  planActivation(
    session: SessionRecord,
    skillName: string,
    reason: string
  ): CursorSkillActivationReceipt | undefined {
    const normalized = normalizeSkillName(skillName)
    if (!normalized || this.isActive(session, normalized)) return undefined
    return Object.freeze({
      skillName: normalized,
      reason,
    })
  }

  /**
   * Publish a previously planned activation after its graph result commits.
   * Concurrent commits are idempotent: a receipt that is already represented
   * in the session becomes a no-op rather than a second state transition.
   */
  commitActivation(
    session: SessionRecord,
    receipt: CursorSkillActivationReceipt
  ): boolean {
    const normalized = normalizeSkillName(receipt.skillName)
    if (!normalized || this.isActive(session, normalized)) return false
    session.activeCursorSkillNames = [
      ...(session.activeCursorSkillNames || []),
      normalized,
    ]
    this.sessionManager.markSessionDirty(session.conversationId)
    this.logger.log(
      `Activated Cursor skill "${normalized}" for session ${session.conversationId}; reason=${receipt.reason}`
    )
    return true
  }

  /** 显式卸载某个 Skill；无匹配则忽略。 */
  deactivate(session: SessionRecord, skillName: string): boolean {
    const normalized = normalizeSkillName(skillName)
    if (!normalized) return false
    const before = session.activeCursorSkillNames || []
    const after = before.filter(
      (name) => normalizeSkillName(name) !== normalized
    )
    if (after.length === before.length) return false
    session.activeCursorSkillNames = after
    this.sessionManager.markSessionDirty(session.conversationId)
    this.logger.log(
      `Deactivated Cursor skill "${normalized}" for session ${session.conversationId}`
    )
    return true
  }

  /**
   * Plan all path-triggered activations for one tool call without mutating the
   * session. The caller carries these receipts to that tool's graph commit.
   */
  planActivationsForPath(
    session: SessionRecord,
    rawPath: string,
    reason: string
  ): readonly CursorSkillActivationReceipt[] {
    if (!rawPath) return []
    const policy = this.resolvePolicyForSession(session, [rawPath])
    const receipts: CursorSkillActivationReceipt[] = []
    for (const skill of policy.activeSkills) {
      if (skill.activationReason === "path_match") {
        const receipt = this.planActivation(session, skill.name, reason)
        if (receipt) receipts.push(receipt)
      }
    }
    return receipts
  }

  /* ---------------- 工具访问拦截 ---------------- */

  /**
   * 给定一个工具调用（toolName + input），如果它尝试访问的路径属于
   * 某个未激活 Skill 的内部目录，返回错误信息字符串供调用方拒绝执行。
   * 否则返回 null。
   */
  guardToolAccess(
    session: SessionRecord,
    toolName: string,
    input: Record<string, unknown>,
    pendingActivations: readonly CursorSkillActivationReceipt[] = []
  ): string | null {
    const targetPath = this.pickToolTargetPath(toolName, input)
    if (!targetPath) return null
    const skill = findCursorSkillForInternalPath(
      session.cursorRules,
      targetPath,
      session.skillOptions
    )
    if (!skill) return null
    if (this.isActive(session, skill.name)) return null
    const normalizedSkillName = normalizeSkillName(skill.name)
    if (
      pendingActivations.some(
        (receipt) =>
          normalizeSkillName(receipt.skillName) === normalizedSkillName
      )
    ) {
      return null
    }

    const message =
      `Cursor skill access blocked: skill "${skill.name}" is available but not active. ` +
      `Load it with fetch_rules({ skill_name: "${skill.name}" }) before using its internal files or generated workspace.`
    this.logger.warn(
      `${message}; tool=${toolName}; path=${targetPath || "(none)"}`
    )
    return message
  }

  /** 从工具调用 input 中提取「可能涉及文件路径」的字段。 */
  pickToolTargetPath(toolName: string, input: Record<string, unknown>): string {
    const normalizedTool = toolName.trim().toLowerCase()
    if (!normalizedTool) return ""

    const mayTouchPath =
      normalizedTool.includes("read") ||
      normalizedTool.includes("list") ||
      normalizedTool.includes("ls") ||
      normalizedTool.includes("edit") ||
      normalizedTool.includes("write") ||
      normalizedTool.includes("delete") ||
      normalizedTool.includes("file") ||
      normalizedTool.includes("dir")
    if (!mayTouchPath) return ""

    return pickFirstString(input, [
      "path",
      "filePath",
      "file_path",
      "targetPath",
      "target_path",
      "directory",
      "dir",
    ])
  }

  /* ---------------- 查找与搜索 ---------------- */

  /** 按 name 在 rules 中精确查找 Skill。 */
  findByName(
    rules: CursorRule[] | undefined,
    skillName: string,
    skillOptions?: SkillOptions
  ): CursorSkillMetadata | null {
    return findCursorSkillByName(rules, skillName, skillOptions)
  }

  /** 按任务描述模糊检索 Skill。 */
  search(
    skills: CursorSkillMetadata[],
    query: string,
    limit?: number
  ): CursorSkillSearchHit[] {
    return searchCursorSkills(skills, query, limit)
  }

  /* ---------------- 内部 ---------------- */

  private toPolicyInput(
    context: CursorSkillsPromptContext
  ): CursorSkillPolicyInput {
    const scope = this.requireWorkspaceScope(
      context.workspaceScope,
      "Cursor skill prompt policy"
    )
    return {
      rules: context.cursorRules,
      skillOptions: context.skillOptions,
      selectedRulePaths: context.selectedCursorRulePaths,
      selectedRuleNames: context.selectedCursorRuleNames,
      activeSkillNames: context.activeCursorSkillNames,
      projectRoot: scope.primaryRoot,
      contextPaths: (context.codeChunks || []).map((chunk) => chunk.path),
      environmentNames: DEFAULT_CURSOR_SKILL_ENVIRONMENTS,
      // scoped_to represents IDE project identity, never broad additional
      // execution grants. Additional roots may be executable but cannot make
      // a skill appear to belong to a project it was not scoped for.
      scopePaths: this.buildScopePaths(scope.ideRoots),
    }
  }

  private toPolicyInputFromSession(
    session: SessionRecord,
    extraContextPaths: string[]
  ): CursorSkillPolicyInput {
    const scope = this.requireWorkspaceScope(
      session.workspace?.scope,
      "Cursor skill session policy"
    )
    const baseContextPaths = (session.codeChunks || []).map(
      (chunk) => chunk.path
    )
    const contextPaths = extraContextPaths.length
      ? [...baseContextPaths, ...extraContextPaths.map(normalizePathForMatch)]
      : baseContextPaths
    return {
      rules: session.cursorRules,
      skillOptions: session.skillOptions,
      selectedRulePaths: session.selectedCursorRulePaths,
      selectedRuleNames: session.selectedCursorRuleNames,
      activeSkillNames: session.activeCursorSkillNames,
      projectRoot: scope.primaryRoot,
      contextPaths,
      environmentNames: DEFAULT_CURSOR_SKILL_ENVIRONMENTS,
      scopePaths: this.buildScopePaths(scope.ideRoots),
    }
  }

  private requireWorkspaceScope(
    scope: WorkspaceScope | undefined,
    operation: string
  ): WorkspaceScope {
    if (!(scope instanceof WorkspaceScope)) {
      throw new Error(`${operation} requires a declared WorkspaceScope`)
    }
    return scope
  }

  private buildScopePaths(ideRoots: readonly string[]): string[] {
    const scopePaths: string[] = []
    for (const rootPath of ideRoots) {
      const normalizedPath = normalizePathForMatch(rootPath)
      if (!normalizedPath) continue
      scopePaths.push(normalizedPath)
      const segments = normalizedPath.split("/").filter(Boolean)
      const leaf = segments[segments.length - 1]
      if (leaf) scopePaths.push(leaf)
    }
    return [...new Set(scopePaths)]
  }
}

function pickFirstString(
  input: Record<string, unknown>,
  keys: string[]
): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return ""
}
