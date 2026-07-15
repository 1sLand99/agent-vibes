import { Injectable } from "@nestjs/common"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 8_000
const GIT_MAX_BUFFER_BYTES = 1024 * 1024

export type GitBranchState =
  | { kind: "ready"; current: string | null; branches: string[] }
  | { kind: "no-repo" }
  | { kind: "error"; message: string }

export type GitCheckoutResult = { ok: true } | { ok: false; message: string }

type GitResult = { code: number; stdout: string; stderr: string }

/**
 * Read-only Git branch inspection plus a guarded local checkout, scoped to a
 * workspace folder path supplied by the IDE-registered workspace set.
 *
 * All Git invocations use execFile with an argument array (never a shell), so
 * folder paths and branch names cannot be interpreted as shell syntax. A
 * checkout target must additionally match one of the branches Git itself
 * reports, so only real local branches are ever passed to `git checkout`.
 */
@Injectable()
export class GitBranchService {
  async getBranchState(cwd: string): Promise<GitBranchState> {
    const insideWorkTree = await this.runGit(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
    ])
    if (insideWorkTree.code !== 0 || insideWorkTree.stdout.trim() !== "true") {
      if (this.isMissingGit(insideWorkTree)) {
        return { kind: "error", message: "Git executable not found" }
      }
      return { kind: "no-repo" }
    }

    const listed = await this.runGit(cwd, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ])
    if (listed.code !== 0) {
      return { kind: "error", message: this.firstLine(listed.stderr) }
    }
    const branches = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const head = await this.runGit(cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ])
    const current = head.code === 0 ? head.stdout.trim() || null : null

    return { kind: "ready", current, branches }
  }

  async checkout(cwd: string, branch: string): Promise<GitCheckoutResult> {
    const state = await this.getBranchState(cwd)
    if (state.kind === "no-repo") {
      return { ok: false, message: "Not a Git repository" }
    }
    if (state.kind === "error") {
      return { ok: false, message: state.message }
    }
    if (!state.branches.includes(branch)) {
      return { ok: false, message: "Unknown local branch" }
    }
    if (state.current === branch) {
      return { ok: true }
    }

    const result = await this.runGit(cwd, ["checkout", branch])
    if (result.code !== 0) {
      return {
        ok: false,
        message: this.firstLine(result.stderr) || "git checkout failed",
      }
    }
    return { ok: true }
  }

  private async runGit(cwd: string, args: string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const failure = error as {
        code?: number | string
        stdout?: string
        stderr?: string
        message?: string
      }
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr || failure.message || "",
      }
    }
  }

  private isMissingGit(result: GitResult): boolean {
    return /ENOENT|not found|not recognized/iu.test(result.stderr)
  }

  private firstLine(text: string): string {
    return text.split("\n")[0]?.trim() ?? ""
  }
}
