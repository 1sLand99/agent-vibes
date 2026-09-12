import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CdpError, CdpSession, listTargets } from "./chatgpt-web-cdp"
import { HOOK_FLAG, PAGE_HOOK_SOURCE } from "./chatgpt-web-page-hook"

/**
 * Drives a real ChatGPT tab so connector-backed turns can be issued from the
 * bridge.
 *
 * Why a browser at all: a connector only activates for a request the web app
 * itself issued. Replaying one from Node — with the app's own sentinel,
 * turnstile and integrity headers harvested verbatim, the full cookie jar, and
 * a byte-identical body — is accepted (HTTP 200) but the model is never
 * offered the connector's tools. So the app has to make the request, and this
 * service supplies the prompt and reads the answer back out.
 *
 * Consequences worth knowing before relying on it:
 *
 *   - It depends on the page's DOM (the composer and its send button). A
 *     ChatGPT redesign breaks it, loudly rather than silently — every step
 *     below checks its own postcondition.
 *   - One tab serves one turn at a time, so calls are queued.
 *   - The profile is persistent and signing in is a manual, one-time step.
 */

const DEFAULT_PORT = 9333
const PAGE_READY_TIMEOUT_MS = 90_000
const TURN_TIMEOUT_MS = 300_000
const POLL_MS = 500

export class ChatGptWebBrowserError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ChatGptWebBrowserError"
  }
}

export interface BrowserTurnRequest {
  readonly prompt: string
  readonly connectorId: string
  readonly signal?: AbortSignal
}

@Injectable()
export class ChatGptWebBrowserService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatGptWebBrowserService.name)
  private chrome: ChildProcess | null = null
  private session: CdpSession | null = null
  /** Serialises turns: one tab can only carry one conversation at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly configService: ConfigService) {}

  private get port(): number {
    const raw = Number.parseInt(
      this.configService.get<string>("CHATGPT_WEB_BROWSER_PORT", ""),
      10
    )
    return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_PORT
  }

  private get profileDir(): string {
    const configured = this.configService
      .get<string>("CHATGPT_WEB_BROWSER_PROFILE", "")
      .trim()
    if (configured) return configured
    const base =
      this.configService.get<string>("AGENT_VIBES_DATA_DIR", "").trim() ||
      path.join(os.homedir(), ".agent-vibes")
    return path.join(base, "chatgpt-browser-profile")
  }

  private get chromeBinary(): string {
    const configured = this.configService
      .get<string>("CHATGPT_WEB_BROWSER_BINARY", "")
      .trim()
    if (configured) return configured
    const candidates =
      process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ]
    return candidates.find((candidate) => fs.existsSync(candidate)) || ""
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /** Reuse a Chrome already listening on the port, or start one. */
  private async ensureChrome(): Promise<void> {
    if (await this.devToolsReachable()) return

    const binary = this.chromeBinary
    if (!binary) {
      throw new ChatGptWebBrowserError(
        503,
        "chatgpt_web_browser_missing",
        "No Chrome binary found — set CHATGPT_WEB_BROWSER_BINARY"
      )
    }
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 })

    // Headless is rejected by the Cloudflare check that fronts chatgpt.com, so
    // this window is real. It is also where a human signs in the first time.
    this.chrome = spawn(
      binary,
      [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
        "https://chatgpt.com/",
      ],
      { stdio: "ignore", detached: false }
    )
    this.chrome.on("exit", (code) => {
      this.logger.warn(`ChatGPT browser exited (code ${code ?? "unknown"})`)
      this.chrome = null
      this.session = null
    })

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (await this.devToolsReachable()) return
      await delay(POLL_MS)
    }
    throw new ChatGptWebBrowserError(
      503,
      "chatgpt_web_browser_unavailable",
      "Chrome did not expose its DevTools port in time"
    )
  }

  private async devToolsReachable(): Promise<boolean> {
    try {
      await listTargets(this.port, 2_000)
      return true
    } catch {
      return false
    }
  }

  /** Attach to a chatgpt.com tab, installing the hook if it is missing. */
  private async ensurePage(): Promise<CdpSession> {
    if (this.session) {
      try {
        const installed = await this.session.evaluate<boolean>(
          `!!window.${HOOK_FLAG}`
        )
        if (installed) return this.session
      } catch {
        // Page navigated away or the socket died; fall through and re-attach.
      }
      this.session.close()
      this.session = null
    }

    await this.ensureChrome()
    const targets = await listTargets(this.port)
    const page =
      targets.find((t) => t.type === "page" && t.url.includes("chatgpt.com")) ??
      targets.find((t) => t.type === "page")
    if (!page?.webSocketDebuggerUrl) {
      throw new ChatGptWebBrowserError(
        503,
        "chatgpt_web_browser_no_page",
        "The browser has no page to attach to"
      )
    }

    const session = await CdpSession.connect(page.webSocketDebuggerUrl)
    await session.send("Runtime.enable")
    await session.send("Page.enable")
    if (!page.url.includes("chatgpt.com")) {
      await session.send("Page.navigate", { url: "https://chatgpt.com/" })
    }
    await this.waitForComposer(session)

    const result = await session.evaluate<string>(PAGE_HOOK_SOURCE)
    if (result !== "installed" && result !== "already") {
      throw new ChatGptWebBrowserError(
        502,
        "chatgpt_web_hook_failed",
        `Could not install the page hook: ${String(result)}`
      )
    }
    this.session = session
    return session
  }

  /**
   * Wait for the composer, which is also the signed-in check: a signed-out or
   * challenged page never renders one.
   */
  private async waitForComposer(session: CdpSession): Promise<void> {
    const deadline = Date.now() + PAGE_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const ready = await session
        .evaluate<boolean>(`!!document.querySelector("#prompt-textarea")`)
        .catch(() => false)
      if (ready) return
      await delay(POLL_MS)
    }
    throw new ChatGptWebBrowserError(
      503,
      "chatgpt_web_not_signed_in",
      "The ChatGPT tab never showed a composer — sign in once in the browser " +
        "window this service opened, then retry"
    )
  }

  // ── turns ─────────────────────────────────────────────────────────────

  /**
   * Run one turn, yielding raw SSE as the page receives it.
   *
   * Turns are queued: one tab carries one conversation, and interleaving two
   * would mix their frames. A caller that abandons the iterator still releases
   * the queue, so one dropped request cannot wedge the rest.
   */
  async *streamTurn(
    request: BrowserTurnRequest
  ): AsyncGenerator<string, void, unknown> {
    const release = await this.acquire()
    try {
      yield* this.runTurnExclusive(request)
    } finally {
      release()
    }
  }

  /** Convenience for callers that only want the finished stream. */
  async runTurn(request: BrowserTurnRequest): Promise<string> {
    const parts: string[] = []
    for await (const chunk of this.streamTurn(request)) parts.push(chunk)
    return parts.join("")
  }

  /** Take the turn lock, resolving to the function that gives it back. */
  private acquire(): Promise<() => void> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const waited = this.queue.then(
      () => release,
      () => release
    )
    this.queue = this.queue.then(
      () => next,
      () => next
    )
    return waited
  }

  private async *runTurnExclusive(
    request: BrowserTurnRequest
  ): AsyncGenerator<string, void, unknown> {
    const session = await this.ensurePage()
    await session.send("Page.bringToFront")

    const armed = await session.evaluate<string>(
      `window.${HOOK_FLAG}.arm(${JSON.stringify(`plugin:${request.connectorId}`)}, ${JSON.stringify(request.prompt)})`
    )
    if (armed !== "armed") {
      throw new ChatGptWebBrowserError(
        502,
        "chatgpt_web_compose_failed",
        `Could not put the prompt in the composer (${armed})`
      )
    }

    await this.clickSend(session)

    const deadline = Date.now() + TURN_TIMEOUT_MS
    try {
      for (;;) {
        if (request.signal?.aborted) {
          throw new ChatGptWebBrowserError(
            499,
            "chatgpt_web_aborted",
            "The caller went away"
          )
        }
        const progress = JSON.parse(
          await session.evaluate<string>(`window.${HOOK_FLAG}.progress()`)
        ) as { done: boolean; chunks: number; failed: string | null }

        if (progress.chunks > 0) {
          const drained = await session.evaluate<string>(
            `window.${HOOK_FLAG}.drain()`
          )
          if (drained) yield drained
        }
        if (progress.failed) {
          throw new ChatGptWebBrowserError(
            502,
            "chatgpt_web_turn_failed",
            `The page reported: ${progress.failed.slice(0, 200)}`
          )
        }
        if (progress.done) return
        if (Date.now() > deadline) {
          throw new ChatGptWebBrowserError(
            504,
            "chatgpt_web_turn_timeout",
            "The turn did not finish in time"
          )
        }
        await delay(POLL_MS)
      }
    } finally {
      // Runs on a thrown error and on an abandoned iterator alike, so the page
      // never stays armed for a turn nobody is reading.
      await session.evaluate(`window.${HOOK_FLAG}.release()`).catch(() => null)
    }
  }

  /**
   * Press send. The button has to be clicked through the browser's input
   * pipeline; Enter and synthetic events do not reach the app's handler.
   */
  private async clickSend(session: CdpSession): Promise<void> {
    const deadline = Date.now() + 15_000
    for (;;) {
      const raw = await session.evaluate<string | null>(
        `window.${HOOK_FLAG}.sendButton()`
      )
      if (raw) {
        const box = JSON.parse(raw) as { x: number; y: number }
        await session.clickAt(box.x, box.y)
        return
      }
      if (Date.now() > deadline) {
        throw new ChatGptWebBrowserError(
          502,
          "chatgpt_web_send_unavailable",
          "The composer's send button never became clickable"
        )
      }
      await delay(POLL_MS)
    }
  }

  onModuleDestroy(): void {
    this.session?.close()
    this.session = null
    // The browser is left running on purpose: it holds the signed-in profile,
    // and a restart of the bridge should not cost a new sign-in.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { CdpError }
