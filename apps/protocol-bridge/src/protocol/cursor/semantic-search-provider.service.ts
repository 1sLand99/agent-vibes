import { Injectable, Logger } from "@nestjs/common"
import { readdir, readFile, stat } from "fs/promises"
import * as path from "path"
import {
  WorkspaceScope,
  type WorkspaceScopeRoot,
  type WorkspaceTarget,
} from "./session/workspace-scope"

export type SemanticSearchFamily = "semantic_search" | "deep_search"

export interface SemanticSearchHit {
  /** Canonical absolute path so multi-root hits remain unambiguous. */
  path: string
  score: number
  snippet?: string
}

export interface SemanticSearchRequest {
  conversationId: string
  family: SemanticSearchFamily
  query: string
  /**
   * The sole filesystem authority. Parent sessions and child projection
   * requests both pass a validated `WorkspaceScope`; consumers never decode
   * durable JSON or infer a root from process state.
   */
  workspaceScope: WorkspaceScope
  targetDirectories: string[]
  maxResults: number
}

export interface SemanticSearchResponse {
  status: "success" | "error" | "unavailable"
  provider: string
  message?: string
  results: SemanticSearchHit[]
}

interface IndexedDocument {
  readonly path: string
  readonly rootPath: string
  readonly relativePath: string
  readonly normalizedPath: string
  readonly content: string
  readonly normalizedContent: string
}

interface IndexCacheEntry {
  readonly builtAt: number
  readonly documents: readonly IndexedDocument[]
}

interface SearchDirectoryTarget {
  readonly root: WorkspaceScopeRoot
  readonly target: WorkspaceTarget
}

interface CollectedWorkspaceFile {
  readonly absolutePath: string
  readonly relativePath: string
}

@Injectable()
export class SemanticSearchProviderService {
  private readonly logger = new Logger(SemanticSearchProviderService.name)
  private readonly cache = new Map<string, IndexCacheEntry>()
  private readonly cacheTtlMs = 30_000
  private readonly maxFileBytes = 256_000
  private readonly skipDirs = new Set([
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".idea",
    ".vscode",
  ])

  async search(
    request: SemanticSearchRequest
  ): Promise<SemanticSearchResponse> {
    const queryTokens = this.tokenizeQuery(request.query)

    if (queryTokens.length === 0) {
      return {
        status: "error",
        provider: "local",
        message: "missing query terms",
        results: [],
      }
    }

    try {
      if (!(request.workspaceScope instanceof WorkspaceScope)) {
        throw new Error("semantic search requires a WorkspaceScope")
      }
      const documents = await this.getIndexedDocuments(
        request.workspaceScope,
        request.family,
        request.targetDirectories
      )
      const ranked = this.rankDocuments(
        request.query,
        queryTokens,
        documents
      ).slice(0, Math.max(1, request.maxResults || 1))
      return {
        status: "success",
        provider: "local",
        results: ranked,
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "local semantic search failed"
      this.logger.warn(`local semantic search failed: ${message}`)
      return {
        status: "error",
        provider: "local",
        message,
        results: [],
      }
    }
  }

  private tokenizeQuery(query: string): string[] {
    const raw = query.trim()
    if (!raw) return []

    // Split camelCase/PascalCase and non-word separators for better symbol matching.
    const expanded = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    const tokens = expanded
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)

    return Array.from(new Set(tokens))
  }

  private resolveSearchDirectoryTargets(
    scope: WorkspaceScope,
    targetDirectories: readonly string[]
  ): readonly SearchDirectoryTarget[] {
    const requestedDirectories = targetDirectories.map((value, index) => {
      if (typeof value !== "string") {
        throw new Error(
          `semantic search targetDirectories[${index}] must be a string`
        )
      }
      // Directory names are filesystem input, not normalized identifiers.
      // Preserve their exact spelling and let WorkspaceScope resolve/reject
      // empty, NUL-bearing, non-canonical, or out-of-scope targets.
      return value
    })
    const targets =
      requestedDirectories.length === 0
        ? scope.roots.map((root) => scope.resolveTarget(root.path))
        : requestedDirectories.map((directory) =>
            scope.resolveTarget(directory)
          )

    const seen = new Set<string>()
    const resolved: SearchDirectoryTarget[] = []
    for (const target of targets) {
      if (seen.has(target.absolutePath)) continue
      seen.add(target.absolutePath)
      resolved.push(Object.freeze({ root: target.root, target }))
    }
    return Object.freeze(resolved)
  }

  private buildCacheKey(
    scope: WorkspaceScope,
    family: SemanticSearchFamily,
    targets: readonly SearchDirectoryTarget[]
  ): string {
    const targetIdentity = targets
      .map((entry) => entry.target.absolutePath)
      .sort()
      .join("|")
    return `${scope.scopeFingerprint}::${family}::${targetIdentity}`
  }

  private async getIndexedDocuments(
    scope: WorkspaceScope,
    family: SemanticSearchFamily,
    targetDirectories: readonly string[]
  ): Promise<readonly IndexedDocument[]> {
    const targets = this.resolveSearchDirectoryTargets(scope, targetDirectories)
    const cacheKey = this.buildCacheKey(scope, family, targets)
    const cached = this.cache.get(cacheKey)
    const now = Date.now()
    if (cached && now - cached.builtAt < this.cacheTtlMs) {
      return cached.documents
    }

    const maxFilesPerRoot = family === "deep_search" ? 7_000 : 2_500
    const maxDepth = family === "deep_search" ? 12 : 8
    const targetsByRoot = new Map<string, SearchDirectoryTarget[]>()
    for (const target of targets) {
      const rootTargets = targetsByRoot.get(target.root.path) ?? []
      rootTargets.push(target)
      targetsByRoot.set(target.root.path, rootTargets)
    }

    const documents: IndexedDocument[] = []
    for (const root of scope.roots) {
      const rootTargets = targetsByRoot.get(root.path)
      if (!rootTargets || rootTargets.length === 0) continue
      const discovered = await this.collectWorkspaceFiles(
        scope,
        root,
        rootTargets,
        maxFilesPerRoot,
        maxDepth
      )
      for (const file of discovered) {
        let fileStats
        try {
          fileStats = await stat(file.absolutePath)
        } catch {
          continue
        }
        if (!fileStats.isFile()) continue
        if (fileStats.size <= 0 || fileStats.size > this.maxFileBytes) continue

        let content = ""
        try {
          content = await readFile(file.absolutePath, "utf8")
        } catch {
          continue
        }

        if (!this.looksTextual(content)) continue
        const trimmedContent =
          content.length > 32_000 ? content.slice(0, 32_000) : content
        documents.push({
          path: file.absolutePath,
          rootPath: root.path,
          relativePath: file.relativePath.replace(/\\/g, "/"),
          normalizedPath: file.relativePath.replace(/\\/g, "/").toLowerCase(),
          content: trimmedContent,
          normalizedContent: trimmedContent.toLowerCase(),
        })
      }
    }

    const entry: IndexCacheEntry = Object.freeze({
      builtAt: now,
      documents: Object.freeze(documents),
    })
    this.cache.set(cacheKey, entry)
    return entry.documents
  }

  private async collectWorkspaceFiles(
    scope: WorkspaceScope,
    root: WorkspaceScopeRoot,
    targets: readonly SearchDirectoryTarget[],
    maxFiles: number,
    maxDepth: number
  ): Promise<readonly CollectedWorkspaceFile[]> {
    const files: CollectedWorkspaceFile[] = []
    const seenDirectories = new Set<string>()
    const seenFiles = new Set<string>()
    const queue: Array<{ abs: string; rel: string; depth: number }> = []
    for (const target of targets) {
      if (target.root.path !== root.path) continue
      if (seenDirectories.has(target.target.absolutePath)) continue
      seenDirectories.add(target.target.absolutePath)
      queue.push({
        abs: target.target.absolutePath,
        rel: target.target.relativePath,
        depth: 0,
      })
    }

    while (queue.length > 0 && files.length < maxFiles) {
      const current = queue.pop()
      if (!current) break
      let entries: Array<{
        isDirectory: () => boolean
        isFile: () => boolean
        name: string
      }> = []
      try {
        entries = (await readdir(current.abs, {
          withFileTypes: true,
        })) as Array<{
          isDirectory: () => boolean
          isFile: () => boolean
          name: string
        }>
      } catch {
        continue
      }

      for (const entry of entries) {
        const relativePath = current.rel
          ? path.join(current.rel, entry.name)
          : entry.name
        const absolutePath = path.join(current.abs, entry.name)

        if (entry.isDirectory()) {
          if (current.depth >= maxDepth) continue
          if (this.skipDirs.has(entry.name)) continue
          // A nested declared root is indexed by its own root-local pass.
          // Do not let a broader root absorb it merely because the filesystem
          // hierarchy overlaps.
          if (
            scope.roots.some(
              (declaredRoot) =>
                declaredRoot.path !== root.path &&
                declaredRoot.path === absolutePath
            )
          ) {
            continue
          }
          if (seenDirectories.has(absolutePath)) continue
          seenDirectories.add(absolutePath)
          queue.push({
            abs: absolutePath,
            rel: relativePath,
            depth: current.depth + 1,
          })
          continue
        }

        if (!entry.isFile() || seenFiles.has(absolutePath)) continue
        seenFiles.add(absolutePath)
        files.push(Object.freeze({ absolutePath, relativePath }))
        if (files.length >= maxFiles) break
      }
    }

    return Object.freeze(files)
  }

  private looksTextual(content: string): boolean {
    if (!content) return false
    const sample = content.slice(0, 1_200)
    let controlChars = 0
    for (let i = 0; i < sample.length; i += 1) {
      const code = sample.charCodeAt(i)
      if (code === 0) return false
      if (code < 9 || (code > 13 && code < 32)) controlChars += 1
    }
    return controlChars / sample.length < 0.03
  }

  private countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0
    let count = 0
    let cursor = 0
    while (cursor < haystack.length) {
      const idx = haystack.indexOf(needle, cursor)
      if (idx < 0) break
      count += 1
      cursor = idx + needle.length
    }
    return count
  }

  private buildSnippet(
    content: string,
    queryTokens: string[]
  ): string | undefined {
    if (!content) return undefined
    const normalized = content.toLowerCase()
    let hitIndex = -1
    for (const token of queryTokens) {
      const idx = normalized.indexOf(token)
      if (idx >= 0 && (hitIndex < 0 || idx < hitIndex)) {
        hitIndex = idx
      }
    }

    if (hitIndex < 0) {
      return content.replace(/\s+/g, " ").trim().slice(0, 140) || undefined
    }

    const start = Math.max(0, hitIndex - 70)
    const end = Math.min(content.length, hitIndex + 180)
    const snippet = content.slice(start, end).replace(/\s+/g, " ").trim()
    return snippet || undefined
  }

  private rankDocuments(
    query: string,
    queryTokens: string[],
    documents: readonly IndexedDocument[]
  ): SemanticSearchHit[] {
    const phrase = query.trim().toLowerCase()
    const compactPhrase = phrase.replace(/\s+/g, "")
    const results: SemanticSearchHit[] = []

    for (const doc of documents) {
      let score = 0
      let matchedTokens = 0

      for (const token of queryTokens) {
        const pathHits = this.countOccurrences(doc.normalizedPath, token)
        const contentHits = this.countOccurrences(doc.normalizedContent, token)
        if (pathHits + contentHits > 0) matchedTokens += 1
        score += pathHits * 3.5
        score += Math.min(contentHits, 8) * 1.1
      }

      if (phrase && doc.normalizedContent.includes(phrase)) {
        score += 8
      }
      if (compactPhrase && doc.normalizedPath.includes(compactPhrase)) {
        score += 4
      }
      if (matchedTokens === queryTokens.length && queryTokens.length > 0) {
        score += 3
      }

      if (score <= 0) continue
      results.push({
        path: doc.path,
        score: Number(score.toFixed(4)),
        snippet: this.buildSnippet(doc.content, queryTokens),
      })
    }

    return results.sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path)
    )
  }
}
