/**
 * Skill 激活策略求解器。
 *
 * 输入：原始 Cursor Rule 列表 + 当前 session 的选中/激活/上下文路径状态。
 * 输出：把每条 rule 分类为「Skill / 普通 rule」，并对 Skill 计算激活原因。
 *
 * 激活规则（与 Cursor 官方协议对齐）：
 *   1. is_required === true → required
 *   2. type === "manuallyAttached" → manual
 *   3. selectedRulePaths/Names 命中 → selected
 *   4. activeSkillNames 命中 → previously_loaded
 *   5. paths / fileGlobbed.globs 匹配 contextPaths → path_match
 *
 * environments / disabled_environments / scoped_to 会先裁剪不适用于当前
 * bridge 环境或项目作用域的 Skill。Glob 匹配交给 `picomatch`，不重造轮子。
 */

import * as nodePath from "path"
import picomatch from "picomatch"
import type {
  CursorRule,
  SkillDescriptor,
  SkillOptions,
} from "../../../gen/agent/v1_pb"
import {
  normalizePathForMatch,
  normalizeSkillName,
  parseSkillFrontmatter,
} from "./frontmatter"
import type {
  CursorSkillActivationReason,
  CursorSkillMetadata,
  CursorSkillPolicyInput,
  CursorSkillPolicyResult,
} from "./types"

/** 从一组 Cursor Rule 中识别 Skill、计算激活状态、生成 prompt 用 rule 子集。 */
export function resolveCursorSkillPolicy(
  input: CursorSkillPolicyInput
): CursorSkillPolicyResult {
  const rules = input.rules || []
  const selectedPaths = new Set(
    (input.selectedRulePaths || []).map((item) => normalizePathForMatch(item))
  )
  const selectedNames = new Set(
    (input.selectedRuleNames || []).map((item) => normalizeSkillName(item))
  )
  const activeNames = new Set(
    (input.activeSkillNames || []).map((item) => normalizeSkillName(item))
  )
  const contextPaths = input.contextPaths || []
  const environmentNames = normalizeRuleTags(input.environmentNames || [])
  const scopePaths = (input.scopePaths || [])
    .map((path) => normalizePathForMatch(path))
    .filter((path) => path.length > 0)
  const descriptorIndex = buildSkillDescriptorIndex(input.skillOptions)
  const matchedDescriptorKeys = new Set<string>()

  const promptRules: CursorRule[] = []
  const availableSkills: CursorSkillMetadata[] = []
  const activeSkills: CursorSkillMetadata[] = []
  const inactiveSkills: CursorSkillMetadata[] = []
  const suppressedSkills: CursorSkillMetadata[] = []

  for (const rule of rules) {
    const ruleMetadata = getCursorSkillMetadata(rule)
    const descriptor = ruleMetadata
      ? findMatchingSkillDescriptor(ruleMetadata, descriptorIndex)
      : undefined
    if (descriptor) {
      for (const key of descriptorKeys(descriptor)) {
        matchedDescriptorKeys.add(key)
      }
    }
    const metadata = ruleMetadata
      ? mergeSkillDescriptorMetadata(ruleMetadata, descriptor)
      : null
    if (!metadata) {
      promptRules.push(rule)
      continue
    }

    if (!isSkillUsable(metadata)) {
      continue
    }
    if (!isRuleApplicableToPolicyContext(rule, environmentNames, scopePaths)) {
      continue
    }

    const activationReason = resolveSkillActivationReason({
      metadata,
      rule,
      selectedPaths,
      selectedNames,
      activeNames,
      projectRoot: input.projectRoot,
      contextPaths,
    })
    const active = Boolean(activationReason)
    const skill: CursorSkillMetadata = {
      ...metadata,
      active,
      activationReason: activationReason || undefined,
    }

    availableSkills.push(skill)
    if (active) {
      activeSkills.push(skill)
      promptRules.push(rule)
    } else {
      inactiveSkills.push(skill)
      suppressedSkills.push(skill)
    }
  }

  for (const descriptor of descriptorIndex.descriptors) {
    if (
      descriptorKeys(descriptor).some((key) => matchedDescriptorKeys.has(key))
    ) {
      continue
    }
    const metadata = getCursorSkillDescriptorMetadata(descriptor)
    if (!metadata || !isSkillUsable(metadata)) {
      continue
    }
    const activationReason = resolveDescriptorActivationReason({
      metadata,
      selectedPaths,
      selectedNames,
      activeNames,
    })
    const skill: CursorSkillMetadata = {
      ...metadata,
      active: Boolean(activationReason),
      activationReason: activationReason || undefined,
    }
    availableSkills.push(skill)
    if (skill.active) {
      activeSkills.push(skill)
    } else {
      inactiveSkills.push(skill)
      suppressedSkills.push(skill)
    }
  }

  return {
    promptRules,
    availableSkills: dedupeSkillsByName(availableSkills),
    activeSkills: dedupeSkillsByName(activeSkills),
    inactiveSkills: dedupeSkillsByName(inactiveSkills),
    suppressedSkills: dedupeSkillsByName(suppressedSkills),
  }
}

/** 把单条 Cursor Rule 解析为 Skill metadata；非 Skill 返回 null。 */
export function getCursorSkillMetadata(
  rule: CursorRule
): Omit<CursorSkillMetadata, "active" | "activationReason"> | null {
  const frontmatter = parseCursorRuleSkillFrontmatter(rule)
  const pathSkillName = extractSkillNameFromPath(rule.fullPath || "")
  const name = normalizeSkillName(frontmatter.name || pathSkillName || "")
  const typeCase = rule.type?.type.case
  const looksLikeSkill =
    Boolean(name) &&
    (typeCase === "agentFetched" ||
      typeCase === "manuallyAttached" ||
      isSkillFilePath(rule.fullPath || "") ||
      Boolean(frontmatter.name))

  if (!looksLikeSkill || !name) {
    return null
  }

  const agentFetchedDescription =
    typeCase === "agentFetched" ? rule.type?.type.value.description : undefined
  const fileGlobbedPaths: string[] =
    typeCase === "fileGlobbed" ? rule.type?.type.value.globs || [] : []

  return {
    name,
    description:
      frontmatter.description || agentFetchedDescription || undefined,
    whenToUse: frontmatter.whenToUse,
    paths: [...frontmatter.paths, ...fileGlobbedPaths],
    fullPath: rule.fullPath || "",
    content: rule.content || "",
    ruleType: typeCase,
    enabled: true,
    parseError: rule.parseError || undefined,
    ruleSource: rule.source,
    gitRemoteOrigin: rule.gitRemoteOrigin || undefined,
    plugin: rule.plugin || undefined,
    marketplace: rule.marketplace || undefined,
    pluginId: rule.pluginId || undefined,
    marketplaceId: rule.marketplaceId || undefined,
  }
}

/** 按 name 精确查找 Skill；找到时强制返回 active=false。 */
export function findCursorSkillByName(
  rules: CursorRule[] | undefined,
  skillName: string,
  skillOptions?: SkillOptions
): CursorSkillMetadata | null {
  const requestedName = normalizeSkillName(skillName)
  if (!requestedName) return null
  const descriptorIndex = buildSkillDescriptorIndex(skillOptions)

  for (const rule of rules || []) {
    const ruleMetadata = getCursorSkillMetadata(rule)
    const metadata = ruleMetadata
      ? mergeSkillDescriptorMetadata(
          ruleMetadata,
          findMatchingSkillDescriptor(ruleMetadata, descriptorIndex)
        )
      : null
    if (metadata && metadata.name === requestedName) {
      if (!isSkillUsable(metadata)) return null
      return { ...metadata, active: false }
    }
  }
  for (const descriptor of descriptorIndex.descriptors) {
    const metadata = getCursorSkillDescriptorMetadata(descriptor)
    if (
      metadata &&
      metadata.name === requestedName &&
      isSkillUsable(metadata)
    ) {
      return { ...metadata, active: false }
    }
  }
  return null
}

/**
 * 给定一个工具尝试访问的路径，反查它是否落在某个 Skill 的内部目录里。
 * 用于「未激活的 Skill 不允许被工具直接读取」的访问拦截。
 */
export function findCursorSkillForInternalPath(
  rules: readonly CursorRule[] | undefined,
  rawPath: string,
  skillOptions?: SkillOptions
): CursorSkillMetadata | null {
  const targetPath = normalizePathForMatch(rawPath).toLowerCase()
  if (!targetPath) return null
  const descriptorIndex = buildSkillDescriptorIndex(skillOptions)

  for (const rule of rules || []) {
    const ruleMetadata = getCursorSkillMetadata(rule)
    const metadata = ruleMetadata
      ? mergeSkillDescriptorMetadata(
          ruleMetadata,
          findMatchingSkillDescriptor(ruleMetadata, descriptorIndex)
        )
      : null
    if (!metadata) continue
    if (!isSkillUsable(metadata)) continue
    const skillRoot = normalizePathForMatch(
      nodePath.posix.dirname(normalizePathForMatch(metadata.fullPath))
    ).toLowerCase()
    if (skillRoot && pathIsInside(targetPath, skillRoot)) {
      return { ...metadata, active: false }
    }
    if (metadata.name === "canvas" && isCursorCanvasProjectPath(targetPath)) {
      return { ...metadata, active: false }
    }
  }
  for (const descriptor of descriptorIndex.descriptors) {
    const metadata = getCursorSkillDescriptorMetadata(descriptor)
    if (!metadata || !isSkillUsable(metadata)) continue
    for (const root of descriptorRootPaths(metadata)) {
      if (pathIsInside(targetPath, root.toLowerCase())) {
        return { ...metadata, active: false }
      }
    }
  }

  return null
}

/* ---------------- 内部辅助 ---------------- */

function resolveSkillActivationReason(input: {
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
  rule: CursorRule
  selectedPaths: Set<string>
  selectedNames: Set<string>
  activeNames: Set<string>
  projectRoot?: string
  contextPaths: string[]
}): CursorSkillActivationReason | null {
  const { metadata, rule, selectedPaths, selectedNames, activeNames } = input
  if (rule.isRequired === true) {
    return "required"
  }
  if (rule.type?.type.case === "manuallyAttached") {
    return "manual"
  }
  if (selectedPaths.has(normalizePathForMatch(metadata.fullPath))) {
    return "selected"
  }
  if (selectedNames.has(metadata.name)) {
    return "selected"
  }
  if (activeNames.has(metadata.name)) {
    return "previously_loaded"
  }
  if (
    metadata.paths.length > 0 &&
    matchesAnyPath(metadata.paths, input.contextPaths, input.projectRoot)
  ) {
    return "path_match"
  }
  return null
}

function resolveDescriptorActivationReason(input: {
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
  selectedPaths: Set<string>
  selectedNames: Set<string>
  activeNames: Set<string>
}): CursorSkillActivationReason | null {
  const { metadata, selectedPaths, selectedNames, activeNames } = input
  if (selectedPaths.has(normalizePathForMatch(metadata.fullPath))) {
    return "selected"
  }
  if (
    metadata.readmeFilePath &&
    selectedPaths.has(normalizePathForMatch(metadata.readmeFilePath))
  ) {
    return "selected"
  }
  if (
    metadata.folderPath &&
    selectedPaths.has(normalizePathForMatch(metadata.folderPath))
  ) {
    return "selected"
  }
  if (selectedNames.has(metadata.name)) {
    return "selected"
  }
  if (activeNames.has(metadata.name)) {
    return "previously_loaded"
  }
  return null
}

interface SkillDescriptorIndex {
  descriptors: SkillDescriptor[]
  byName: Map<string, SkillDescriptor>
  byPath: Map<string, SkillDescriptor>
}

function buildSkillDescriptorIndex(
  skillOptions: SkillOptions | undefined
): SkillDescriptorIndex {
  const descriptors = skillOptions?.skillDescriptors || []
  const byName = new Map<string, SkillDescriptor>()
  const byPath = new Map<string, SkillDescriptor>()
  for (const descriptor of descriptors) {
    const name = normalizeSkillName(descriptor.name || "")
    if (name) {
      byName.set(name, descriptor)
    }
    for (const key of descriptorPathKeys(descriptor)) {
      byPath.set(key, descriptor)
    }
  }
  return { descriptors, byName, byPath }
}

function findMatchingSkillDescriptor(
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">,
  index: SkillDescriptorIndex
): SkillDescriptor | undefined {
  for (const key of metadataDescriptorPathKeys(metadata)) {
    const byPath = index.byPath.get(key)
    if (byPath) {
      return byPath
    }
  }
  return index.byName.get(metadata.name)
}

function getCursorSkillDescriptorMetadata(
  descriptor: SkillDescriptor
): Omit<CursorSkillMetadata, "active" | "activationReason"> | null {
  const name = normalizeSkillName(descriptor.name || "")
  if (!name) {
    return null
  }
  const readmeFilePath = descriptor.readmeFilePath || ""
  const folderPath = descriptor.folderPath || ""
  return {
    name,
    description: descriptor.description || undefined,
    paths: [],
    fullPath: readmeFilePath || folderPath,
    content: "",
    enabled: descriptor.enabled,
    parseError: descriptor.parseError || undefined,
    folderPath: folderPath || undefined,
    readmeFilePath: readmeFilePath || undefined,
    packageType: descriptor.packageType,
  }
}

function mergeSkillDescriptorMetadata(
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">,
  descriptor: SkillDescriptor | undefined
): Omit<CursorSkillMetadata, "active" | "activationReason"> {
  if (!descriptor) {
    return metadata
  }
  return {
    ...metadata,
    description: metadata.description || descriptor.description || undefined,
    enabled: descriptor.enabled,
    parseError: metadata.parseError || descriptor.parseError || undefined,
    folderPath: descriptor.folderPath || metadata.folderPath,
    readmeFilePath: descriptor.readmeFilePath || metadata.readmeFilePath,
    packageType: descriptor.packageType,
    fullPath:
      metadata.fullPath || descriptor.readmeFilePath || descriptor.folderPath,
  }
}

function isSkillUsable(
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
): boolean {
  if (metadata.enabled === false) {
    return false
  }
  return !metadata.parseError
}

function descriptorKeys(descriptor: SkillDescriptor): string[] {
  const keys: string[] = []
  const name = normalizeSkillName(descriptor.name || "")
  if (name) {
    keys.push(`name:${name}`)
  }
  for (const pathKey of descriptorPathKeys(descriptor)) {
    keys.push(`path:${pathKey}`)
  }
  return keys
}

function descriptorPathKeys(descriptor: SkillDescriptor): string[] {
  return [
    descriptor.readmeFilePath || "",
    descriptor.folderPath || "",
    descriptor.folderPath ? `${descriptor.folderPath}/SKILL.md` : "",
    descriptor.folderPath ? `${descriptor.folderPath}/skill.md` : "",
  ]
    .map((value) => normalizePathForMatch(value).toLowerCase())
    .filter(Boolean)
}

function metadataDescriptorPathKeys(
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
): string[] {
  return [
    metadata.fullPath || "",
    metadata.readmeFilePath || "",
    metadata.folderPath || "",
  ]
    .map((value) => normalizePathForMatch(value).toLowerCase())
    .filter(Boolean)
}

function descriptorRootPaths(
  metadata: Omit<CursorSkillMetadata, "active" | "activationReason">
): string[] {
  const roots = [
    metadata.folderPath || "",
    metadata.readmeFilePath
      ? nodePath.posix.dirname(normalizePathForMatch(metadata.readmeFilePath))
      : "",
    metadata.fullPath
      ? nodePath.posix.dirname(normalizePathForMatch(metadata.fullPath))
      : "",
  ]
    .map((value) => normalizePathForMatch(value))
    .filter(Boolean)
  return Array.from(new Set(roots))
}

function parseCursorRuleSkillFrontmatter(
  rule: CursorRule
): ReturnType<typeof parseSkillFrontmatter> {
  if (rule.frontmatter.trim()) {
    return parseRawFrontmatterField(rule.frontmatter)
  }
  return parseSkillFrontmatter(rule.content || "")
}

function parseRawFrontmatterField(
  raw: string
): ReturnType<typeof parseSkillFrontmatter> {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { paths: [] }
  }
  return parseSkillFrontmatter(`---\n${trimmed}\n---`)
}

function isRuleApplicableToPolicyContext(
  rule: CursorRule,
  environmentNames: Set<string>,
  scopePaths: string[]
): boolean {
  if (matchesAnyTag(rule.disabledEnvironments, environmentNames)) {
    return false
  }
  if (
    rule.environments.length > 0 &&
    environmentNames.size > 0 &&
    !matchesAnyTag(rule.environments, environmentNames)
  ) {
    return false
  }
  if (
    rule.scopedTo.length > 0 &&
    scopePaths.length > 0 &&
    !matchesAnyScope(rule.scopedTo, scopePaths)
  ) {
    return false
  }
  return true
}

function dedupeSkillsByName(
  skills: CursorSkillMetadata[]
): CursorSkillMetadata[] {
  const seen = new Set<string>()
  const result: CursorSkillMetadata[] = []
  for (const skill of skills) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    result.push(skill)
  }
  return result
}

function extractSkillNameFromPath(rawPath: string): string | null {
  const normalizedPath = normalizePathForMatch(rawPath)
  const segments = normalizedPath.split("/").filter(Boolean)
  const fileName = segments[segments.length - 1] || ""
  if (fileName.toLowerCase() !== "skill.md") return null
  return segments[segments.length - 2] || null
}

function isSkillFilePath(rawPath: string): boolean {
  return Boolean(extractSkillNameFromPath(rawPath))
}

function normalizeRuleTags(values: string[]): Set<string> {
  return new Set(
    values.map((value) => value.trim().toLowerCase()).filter(Boolean)
  )
}

function matchesAnyTag(
  values: string[],
  environmentNames: Set<string>
): boolean {
  if (values.length === 0 || environmentNames.size === 0) return false
  for (const value of values) {
    if (environmentNames.has(value.trim().toLowerCase())) return true
  }
  return false
}

function matchesAnyScope(scopes: string[], scopePaths: string[]): boolean {
  const normalizedScopes = scopes
    .map((scope) => normalizePathForMatch(scope))
    .filter(Boolean)
  if (normalizedScopes.length === 0) return true
  for (const scope of normalizedScopes) {
    for (const scopePath of scopePaths) {
      const normalizedScopePath = normalizePathForMatch(scopePath)
      const scopePathLeaf = normalizedScopePath.split("/").filter(Boolean).pop()
      if (normalizedScopePath === scope || scopePathLeaf === scope) return true
      if (pathIsInside(normalizedScopePath, scope)) return true
      if (pathIsInside(scope, normalizedScopePath)) return true
    }
  }
  return false
}

function matchesAnyPath(
  patterns: string[],
  contextPaths: string[],
  projectRoot?: string
): boolean {
  if (contextPaths.length === 0) return false
  const matcher = buildPathMatcher(patterns)
  if (!matcher) return false
  const root = projectRoot ? normalizePathForMatch(projectRoot) : ""
  for (const rawPath of contextPaths) {
    const candidate = toRelativePath(rawPath, root)
    if (matcher(candidate)) return true
    // 同时按绝对路径再试一次，兼容 patterns 写成 `/abs/path` 或 `**/foo` 的情况。
    if (matcher(normalizePathForMatch(rawPath).replace(/^\/+/, ""))) return true
  }
  return false
}

function buildPathMatcher(
  patterns: string[]
): ((path: string) => boolean) | null {
  const cleaned = patterns
    .map((pattern) => normalizePathForMatch(pattern).replace(/^\/+/, ""))
    .filter((pattern) => pattern.length > 0)
  if (cleaned.length === 0) return null
  return picomatch(cleaned, {
    dot: true,
    nocase: true,
    contains: true,
  })
}

function toRelativePath(rawPath: string, normalizedRoot: string): string {
  const normalized = normalizePathForMatch(rawPath)
  if (normalizedRoot && pathIsInside(normalized, normalizedRoot)) {
    return normalized.slice(normalizedRoot.length).replace(/^\/+/, "")
  }
  return normalized.replace(/^\/+/, "")
}

function pathIsInside(rawPath: string, rawParent: string): boolean {
  const pathValue = normalizePathForMatch(rawPath).replace(/\/+$/, "")
  const parent = normalizePathForMatch(rawParent).replace(/\/+$/, "")
  return pathValue === parent || pathValue.startsWith(`${parent}/`)
}

function isCursorCanvasProjectPath(normalizedLowerPath: string): boolean {
  const segments = normalizedLowerPath.split("/").filter(Boolean)
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] !== ".cursor" || segments[index + 1] !== "projects") {
      continue
    }
    const projectSegments = segments.slice(index + 2)
    return (
      projectSegments.includes("canvases") ||
      (projectSegments[projectSegments.length - 1] || "").endsWith(
        ".canvas.tsx"
      )
    )
  }
  return false
}
