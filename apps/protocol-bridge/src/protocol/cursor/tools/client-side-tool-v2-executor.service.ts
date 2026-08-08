import { Injectable, Logger } from "@nestjs/common"
import * as os from "os"
import * as path from "path"
import { promises as fs } from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import {
  WorkspaceScope,
  WorkspaceScopeError,
  type WorkspaceTarget,
} from "../session/workspace-scope"

type FixExecutionStatus = "success" | "failure" | "error"

export interface LintDiagnostic {
  source: string
  code?: string
  message: string
  severity: number
  range?: {
    start?: { line: number; column: number }
    end?: { line: number; column: number }
  }
}

export interface LintFileDiagnostics {
  path: string
  relativePath: string
  diagnostics: LintDiagnostic[]
  diagnosticsCount: number
}

interface FixLintsFileResult {
  filePath: string
  relativePath: string
  diff: string
  isApplied: boolean
  applyFailed: boolean
  error?: string
  beforeDiagnostics: number
  afterDiagnostics: number
}

export interface ClientSideFixLintsReplay {
  before: {
    totalDiagnostics: number
    files: LintFileDiagnostics[]
  }
  fix: {
    command: string
    fileResults: FixLintsFileResult[]
  }
  after: {
    totalDiagnostics: number
    files: LintFileDiagnostics[]
  }
}

export interface ClientSideFixLintsExecutionResult {
  status: FixExecutionStatus
  message?: string
  content: string
  replay: ClientSideFixLintsReplay
}

export interface ClientSideReadLintsExecutionResult {
  status: "success" | "error"
  message?: string
  content: string
  diagnostics: {
    totalDiagnostics: number
    files: LintFileDiagnostics[]
  }
}

type ResolvedLintTarget =
  | { kind: "ok"; absPath: string; relPath: string; rootPath: string }
  | { kind: "error"; absPath: string; relPath: string; error: string }

type ValidLintTarget = Extract<ResolvedLintTarget, { kind: "ok" }>
type FailedLintTarget = Extract<ResolvedLintTarget, { kind: "error" }>

interface PreparedLintTargets {
  requestedPaths: string[]
  validTargets: ValidLintTarget[]
  failedTargets: FailedLintTarget[]
}

@Injectable()
export class ClientSideToolV2ExecutorService {
  private readonly logger = new Logger(ClientSideToolV2ExecutorService.name)
  private readonly execFileAsync = promisify(execFile)

  /**
   * Read diagnostics without applying any fixes. `read_lints` is a
   * read-only Cursor tool; it must never reuse the `eslint --fix` path used
   * by `fix_lints`.
   */
  async executeReadLints(
    workspaceScope: WorkspaceScope,
    input: Record<string, unknown>
  ): Promise<ClientSideReadLintsExecutionResult> {
    const prepared = this.prepareLintTargets(workspaceScope, input)
    if (prepared.requestedPaths.length === 0) {
      return {
        status: "error",
        message: "missing paths",
        content: "[read_lints error] Missing required paths/files payload",
        diagnostics: { totalDiagnostics: 0, files: [] },
      }
    }
    if (
      prepared.failedTargets.length > 0 ||
      prepared.validTargets.length === 0
    ) {
      const details = prepared.failedTargets
        .map((target) => `${target.relPath}: ${target.error}`)
        .join("; ")
      const message = details || "no valid target files"
      return {
        status: "error",
        message,
        content: `[read_lints error] ${message}`,
        diagnostics: { totalDiagnostics: 0, files: [] },
      }
    }

    try {
      const diagnostics = await this.collectDiagnostics(prepared.validTargets)
      return {
        status: "success",
        content: this.formatReadLintsContent(diagnostics),
        diagnostics,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: "error",
        message,
        content: `[read_lints error] ${message}`,
        diagnostics: { totalDiagnostics: 0, files: [] },
      }
    }
  }

  async executeFixLints(
    workspaceScope: WorkspaceScope,
    input: Record<string, unknown>
  ): Promise<ClientSideFixLintsExecutionResult> {
    const prepared = this.prepareLintTargets(workspaceScope, input)
    if (prepared.requestedPaths.length === 0) {
      return {
        status: "error",
        message: "missing paths",
        content: "[fix_lints error] Missing required paths/files payload",
        replay: {
          before: { totalDiagnostics: 0, files: [] },
          fix: { command: "n/a", fileResults: [] },
          after: { totalDiagnostics: 0, files: [] },
        },
      }
    }

    const { validTargets, failedTargets } = prepared

    if (validTargets.length === 0) {
      const fileResults = failedTargets.map((entry) => ({
        filePath: entry.absPath,
        relativePath: entry.relPath,
        diff: "",
        isApplied: false,
        applyFailed: true,
        error: entry.error,
        beforeDiagnostics: 0,
        afterDiagnostics: 0,
      }))
      return {
        status: "error",
        message: "no valid target files",
        content: "[fix_lints error] No valid files under workspace root",
        replay: {
          before: { totalDiagnostics: 0, files: [] },
          fix: {
            command: "n/a",
            fileResults,
          },
          after: { totalDiagnostics: 0, files: [] },
        },
      }
    }

    const beforeContents = new Map<string, string>()
    for (const target of validTargets) {
      beforeContents.set(
        target.absPath,
        await fs.readFile(target.absPath, "utf8")
      )
    }

    const beforeDiagnostics = await this.collectDiagnostics(validTargets)
    const beforeDiagnosticsByFile = new Map(
      beforeDiagnostics.files.map((entry) => [
        entry.path,
        entry.diagnosticsCount,
      ])
    )

    const fixCommand =
      "npx eslint --fix --format json --no-error-on-unmatched-pattern <paths...>"
    const fixRun = await this.runEslintForTargets(validTargets, [
      "--fix",
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
    ])

    const afterContents = new Map<string, string>()
    for (const target of validTargets) {
      afterContents.set(
        target.absPath,
        await fs.readFile(target.absPath, "utf8")
      )
    }

    const afterDiagnostics = await this.collectDiagnostics(validTargets)
    const afterDiagnosticsByFile = new Map(
      afterDiagnostics.files.map((entry) => [
        entry.path,
        entry.diagnosticsCount,
      ])
    )

    const fileResults: FixLintsFileResult[] = []
    for (const target of validTargets) {
      const before = beforeContents.get(target.absPath) || ""
      const after = afterContents.get(target.absPath) || ""
      const isApplied = before !== after
      const beforeCount = beforeDiagnosticsByFile.get(target.absPath) || 0
      const afterCount = afterDiagnosticsByFile.get(target.absPath) || 0
      let error: string | undefined
      if (!isApplied && beforeCount > 0 && afterCount >= beforeCount) {
        error = "no automatic fix was applied"
      }
      if (fixRun.fatalError && !error) {
        error = fixRun.fatalError
      }
      const diff = isApplied
        ? await this.createUnifiedDiff(target.relPath, before, after)
        : ""
      fileResults.push({
        filePath: target.absPath,
        relativePath: target.relPath,
        diff,
        isApplied,
        applyFailed: Boolean(error),
        error,
        beforeDiagnostics: beforeCount,
        afterDiagnostics: afterCount,
      })
    }

    for (const entry of failedTargets) {
      fileResults.push({
        filePath: entry.absPath,
        relativePath: entry.relPath,
        diff: "",
        isApplied: false,
        applyFailed: true,
        error: entry.error,
        beforeDiagnostics: 0,
        afterDiagnostics: 0,
      })
    }

    const changedCount = fileResults.filter((entry) => entry.isApplied).length
    const failedCount = fileResults.filter((entry) => entry.applyFailed).length
    const beforeTotal = beforeDiagnostics.totalDiagnostics
    const afterTotal = afterDiagnostics.totalDiagnostics

    const status: FixExecutionStatus =
      failedCount === 0 && afterTotal <= beforeTotal ? "success" : "failure"
    const prefix =
      status === "success" ? "[fix_lints success]" : "[fix_lints failure]"
    const summary =
      `${prefix} files=${fileResults.length} changed=${changedCount} failed=${failedCount} ` +
      `before=${beforeTotal} after=${afterTotal}`
    const stderrSnippet = fixRun.stderr.trim()
    const details = stderrSnippet
      ? `${summary}\n[eslint stderr] ${stderrSnippet.slice(0, 500)}`
      : summary

    return {
      status,
      message: fixRun.fatalError,
      content: details,
      replay: {
        before: beforeDiagnostics,
        fix: {
          command: fixCommand,
          fileResults,
        },
        after: afterDiagnostics,
      },
    }
  }

  private pickRequestedPaths(input: Record<string, unknown>): string[] {
    const raw: unknown[] = []
    if (Array.isArray(input.paths)) raw.push(...(input.paths as unknown[]))
    if (Array.isArray(input.files)) raw.push(...(input.files as unknown[]))
    if (typeof input.path === "string") raw.push(input.path)
    if (typeof input.file === "string") raw.push(input.file)
    const seen = new Set<string>()
    const out: string[] = []
    for (const entry of raw) {
      if (typeof entry !== "string") continue
      // A filesystem path is not an identifier. In particular, a trailing
      // space can name a distinct POSIX file, so this boundary must hand the
      // exact raw value to WorkspaceScope rather than quietly repairing it.
      // WorkspaceScope.resolveTarget owns the empty/NUL and containment
      // checks for every accepted path.
      if (seen.has(entry)) continue
      seen.add(entry)
      out.push(entry)
    }
    return out
  }

  private prepareLintTargets(
    workspaceScope: WorkspaceScope,
    input: Record<string, unknown>
  ): PreparedLintTargets {
    const requestedPaths = this.pickRequestedPaths(input)
    const resolvedTargets = this.resolveTargetFiles(
      workspaceScope,
      requestedPaths
    )
    return {
      requestedPaths,
      validTargets: resolvedTargets.filter(
        (entry): entry is ValidLintTarget => entry.kind === "ok"
      ),
      failedTargets: resolvedTargets.filter(
        (entry): entry is FailedLintTarget => entry.kind === "error"
      ),
    }
  }

  private resolveTargetFiles(
    workspaceScope: WorkspaceScope,
    requestedPaths: string[]
  ): ResolvedLintTarget[] {
    const seen = new Set<string>()
    const out: ResolvedLintTarget[] = []
    for (const rawPath of requestedPaths) {
      try {
        const target = workspaceScope.resolveTarget(rawPath)
        if (seen.has(target.absolutePath)) continue
        seen.add(target.absolutePath)
        out.push({
          kind: "ok",
          absPath: target.absolutePath,
          relPath: this.displayLintTargetPath(workspaceScope, target),
          rootPath: target.root.path,
        })
      } catch (error) {
        const message =
          error instanceof WorkspaceScopeError
            ? error.message
            : "path is outside workspace scope"
        out.push({
          kind: "error",
          absPath: rawPath,
          relPath: rawPath,
          error: message,
        })
        continue
      }
    }
    return out
  }

  private displayLintTargetPath(
    workspaceScope: WorkspaceScope,
    target: WorkspaceTarget
  ): string {
    if (target.root.path !== workspaceScope.primaryRoot) {
      return target.absolutePath
    }
    return target.relativePath || path.basename(target.absolutePath)
  }

  private async collectDiagnostics(
    targets: readonly ValidLintTarget[]
  ): Promise<{ totalDiagnostics: number; files: LintFileDiagnostics[] }> {
    const eslintByFile = await this.collectEslintDiagnostics(targets)
    const files: LintFileDiagnostics[] = []
    let totalDiagnostics = 0

    for (const target of targets) {
      const content = await fs.readFile(target.absPath, "utf8")
      const tsDiagnostics = await this.collectTypeScriptSyntaxDiagnostics(
        target.absPath,
        content
      )
      const eslintDiagnostics = eslintByFile.get(target.absPath) || []
      const diagnostics = [...tsDiagnostics, ...eslintDiagnostics]
      totalDiagnostics += diagnostics.length
      files.push({
        path: target.absPath,
        relativePath: target.relPath,
        diagnostics,
        diagnosticsCount: diagnostics.length,
      })
    }

    return { totalDiagnostics, files }
  }

  private formatReadLintsContent(diagnostics: {
    totalDiagnostics: number
    files: LintFileDiagnostics[]
  }): string {
    const maxRenderedDiagnostics = 240
    let remaining = maxRenderedDiagnostics
    const lines = [
      `[read_lints success] files=${diagnostics.files.length} diagnostics=${diagnostics.totalDiagnostics}`,
    ]

    for (const file of diagnostics.files) {
      lines.push(
        `\n${file.relativePath}: ${file.diagnosticsCount} diagnostic(s)`
      )
      const rendered = file.diagnostics.slice(0, remaining)
      for (const diagnostic of rendered) {
        const line = diagnostic.range?.start?.line
        const column = diagnostic.range?.start?.column
        const location =
          typeof line === "number" && typeof column === "number"
            ? `:${line + 1}:${column + 1}`
            : ""
        const code = diagnostic.code ? `/${diagnostic.code}` : ""
        lines.push(
          `- ${file.relativePath}${location} [${diagnostic.source}${code}] ${diagnostic.message}`
        )
      }
      remaining -= rendered.length
      if (file.diagnostics.length > rendered.length) {
        lines.push(
          `- [${file.diagnostics.length - rendered.length} more diagnostic(s) retained in the structured result]`
        )
      }
    }

    const omitted = Math.max(
      0,
      diagnostics.totalDiagnostics - maxRenderedDiagnostics
    )
    if (omitted > 0) {
      lines.push(
        `\n[${omitted} additional diagnostic(s) retained in the structured result]`
      )
    }
    return lines.join("\n")
  }

  private async collectEslintDiagnostics(
    targets: readonly ValidLintTarget[]
  ): Promise<Map<string, LintDiagnostic[]>> {
    const out = new Map<string, LintDiagnostic[]>()
    if (targets.length === 0) return out
    const grouped = this.groupLintTargetsByRoot(targets)
    const collected = await Promise.all(
      Array.from(grouped.entries()).map(async ([rootPath, rootTargets]) =>
        this.collectEslintDiagnosticsForRoot(rootPath, rootTargets)
      )
    )
    for (const entries of collected) {
      for (const [filePath, diagnostics] of entries) {
        out.set(filePath, diagnostics)
      }
    }
    return out
  }

  private async collectEslintDiagnosticsForRoot(
    rootPath: string,
    targets: readonly ValidLintTarget[]
  ): Promise<Map<string, LintDiagnostic[]>> {
    const out = new Map<string, LintDiagnostic[]>()
    const targetPaths = new Set(targets.map((target) => target.absPath))
    const result = await this.runEslint(rootPath, [
      "--format",
      "json",
      "--no-error-on-unmatched-pattern",
      ...targetPaths,
    ])
    const parsed = this.parseEslintJson(result.stdout)
    if (!parsed) return out

    for (const entry of parsed) {
      const filePathRaw = this.coerceScalarString(entry.filePath)
      if (!filePathRaw) continue
      const filePath = path.isAbsolute(filePathRaw)
        ? path.normalize(filePathRaw)
        : path.resolve(rootPath, filePathRaw)
      if (!targetPaths.has(filePath)) continue
      const diagnostics: LintDiagnostic[] = []
      const messages = Array.isArray(entry.messages) ? entry.messages : []
      for (const message of messages) {
        if (!message || typeof message !== "object") continue
        const msg = message as Record<string, unknown>
        const text = this.coerceScalarString(msg.message) || ""
        if (
          text.includes(
            "File ignored because no matching configuration was supplied"
          )
        ) {
          continue
        }
        diagnostics.push({
          source: "eslint",
          code:
            typeof msg.ruleId === "string" && msg.ruleId.trim()
              ? msg.ruleId.trim()
              : undefined,
          message: text || "lint warning",
          severity:
            typeof msg.severity === "number" && msg.severity > 0
              ? Math.floor(msg.severity)
              : 1,
          range: {
            start: this.normalizeOneBasedPosition(msg.line, msg.column),
            end: this.normalizeOneBasedPosition(msg.endLine, msg.endColumn),
          },
        })
      }
      out.set(filePath, diagnostics)
    }

    return out
  }

  private groupLintTargetsByRoot(
    targets: readonly ValidLintTarget[]
  ): ReadonlyMap<string, readonly ValidLintTarget[]> {
    const grouped = new Map<string, ValidLintTarget[]>()
    for (const target of targets) {
      const rootTargets = grouped.get(target.rootPath) ?? []
      rootTargets.push(target)
      grouped.set(target.rootPath, rootTargets)
    }
    return grouped
  }

  private normalizeOneBasedPosition(
    lineRaw: unknown,
    columnRaw: unknown
  ): { line: number; column: number } | undefined {
    const line =
      typeof lineRaw === "number" && Number.isFinite(lineRaw) ? lineRaw : 0
    const column =
      typeof columnRaw === "number" && Number.isFinite(columnRaw)
        ? columnRaw
        : 0
    if (line <= 0 || column <= 0) return undefined
    return { line: Math.floor(line - 1), column: Math.floor(column - 1) }
  }

  private async collectTypeScriptSyntaxDiagnostics(
    absPath: string,
    content: string
  ): Promise<LintDiagnostic[]> {
    if (!/\.(tsx?|mts|cts)$/i.test(absPath)) return []
    try {
      const ts = await import("typescript")
      const transpileResult = ts.transpileModule(content, {
        fileName: absPath,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.Latest,
        },
      })
      const diagnostics = transpileResult.diagnostics || []
      const sourceFile = ts.createSourceFile(
        absPath,
        content,
        ts.ScriptTarget.Latest,
        true
      )
      return diagnostics.map((diagnostic: import("typescript").Diagnostic) => {
        const start =
          typeof diagnostic.start === "number" ? diagnostic.start : 0
        const end =
          start +
          (typeof diagnostic.length === "number" ? diagnostic.length : 0)
        const startPos = sourceFile.getLineAndCharacterOfPosition(start)
        const endPos = sourceFile.getLineAndCharacterOfPosition(
          Math.min(content.length, Math.max(start, end))
        )
        return {
          source: "typescript",
          code: `TS${diagnostic.code}`,
          severity: 1,
          message: ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n"
          ),
          range: {
            start: {
              line: startPos.line,
              column: startPos.character,
            },
            end: {
              line: endPos.line,
              column: endPos.character,
            },
          },
        }
      })
    } catch (error) {
      this.logger.warn(
        `TypeScript diagnostics unavailable for ${absPath}: ${String(error)}`
      )
      return []
    }
  }

  private async runEslintForTargets(
    targets: readonly ValidLintTarget[],
    args: readonly string[]
  ): Promise<{
    stdout: string
    stderr: string
    fatalError?: string
  }> {
    const grouped = this.groupLintTargetsByRoot(targets)
    const runs = await Promise.all(
      Array.from(grouped.entries()).map(async ([rootPath, rootTargets]) =>
        this.runEslint(rootPath, [
          ...args,
          ...rootTargets.map((target) => target.absPath),
        ])
      )
    )
    const fatalErrors = runs
      .map((run) => run.fatalError)
      .filter((error): error is string => Boolean(error))
    return {
      stdout: runs
        .map((run) => run.stdout)
        .filter(Boolean)
        .join("\n"),
      stderr: runs
        .map((run) => run.stderr)
        .filter(Boolean)
        .join("\n"),
      ...(fatalErrors.length > 0 ? { fatalError: fatalErrors.join("; ") } : {}),
    }
  }

  private async runEslint(
    cwd: string,
    args: string[]
  ): Promise<{
    stdout: string
    stderr: string
    fatalError?: string
  }> {
    const npxBinary = process.platform === "win32" ? "npx.cmd" : "npx"
    try {
      const { stdout, stderr } = await this.execFileAsync(
        npxBinary,
        ["eslint", ...args],
        {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
        }
      )
      return {
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      }
    } catch (error) {
      const err = error as {
        stdout?: string
        stderr?: string
        message?: string
      }
      return {
        stdout: String(err.stdout || ""),
        stderr: String(err.stderr || ""),
        fatalError: String(err.message || "eslint execution failed"),
      }
    }
  }

  private parseEslintJson(
    stdout: string
  ): Array<Record<string, unknown>> | undefined {
    const normalized = stdout.trim()
    if (!normalized.startsWith("[")) return undefined
    try {
      const parsed: unknown = JSON.parse(normalized)
      if (!Array.isArray(parsed)) return undefined
      return parsed.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object"
      )
    } catch {
      return undefined
    }
  }

  private coerceScalarString(value: unknown): string | undefined {
    if (typeof value === "string") return value
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      return String(value)
    }
    return undefined
  }

  private async createUnifiedDiff(
    relativePath: string,
    before: string,
    after: string
  ): Promise<string> {
    if (before === after) return ""
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-fix-lints-"))
    const beforePath = path.join(tmpDir, "before.tmp")
    const afterPath = path.join(tmpDir, "after.tmp")
    try {
      await fs.writeFile(beforePath, before, "utf8")
      await fs.writeFile(afterPath, after, "utf8")
      try {
        const { stdout } = await this.execFileAsync(
          "diff",
          [
            "-u",
            "-L",
            `a/${relativePath}`,
            "-L",
            `b/${relativePath}`,
            beforePath,
            afterPath,
          ],
          { maxBuffer: 4 * 1024 * 1024 }
        )
        return String(stdout || "").trim()
      } catch (error) {
        const err = error as { stdout?: string; code?: number }
        if (err.code === 1) {
          return String(err.stdout || "").trim()
        }
        return `[diff unavailable] ${String((error as Error).message || error)}`
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }
}
