import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { execFile, spawn, type ChildProcess } from "node:child_process"
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

const ORIGIN = "https://chatgpt.com"
/** How long to keep trying to get a send to land. */
const SEND_TIMEOUT_MS = 30_000
/** How long one click gets to prove itself before another is tried. */
const SEND_CONFIRM_MS = 2_000
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
  /**
   * chatgpt.com's own model slug, e.g. `gpt-5-6-thinking`.
   *
   * Left out, the turn runs on whatever the tab happens to be set to — which
   * is how a request for one model quietly got answered by another.
   */
  readonly model?: string
  /** ChatGPT's own depth: `min`, `standard`, `extended` or `max`. */
  readonly thinkingEffort?: string
  /**
   * The chatgpt.com conversation this turn belongs to.
   *
   * Set, the tab is taken there first, so the turn lands in that thread and
   * reads whatever has been said in it — including anything typed by hand in
   * the web UI. Unset, the turn starts a new conversation.
   */
  readonly conversationId?: string | null
  /** Called with the conversation the turn ended up in, new or continued. */
  readonly onConversationId?: (conversationId: string) => void
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

  /**
   * Whether to open a window a person can see and use.
   *
   * Off by default, which means headless: the turn is machinery, not something
   * to watch, and a browser that takes the screen on every turn is worse than
   * no feature. Turn it on to sign in the first time, or to watch what the
   * page is doing when something breaks.
   */
  private get visible(): boolean {
    const raw = this.configService
      .get<string>("CHATGPT_WEB_BROWSER_VISIBLE", "")
      .trim()
      .toLowerCase()
    return raw === "1" || raw === "true" || raw === "yes"
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

    // Headless unless someone asked to watch. The page is driven over CDP,
    // which does not need a window, and the alternative — a browser opening on
    // top of whatever you were doing, once per session — is not something to
    // live with.
    //
    // The one thing headless has to hide is that it is headless: Chrome puts
    // `HeadlessChrome` in its User-Agent, and the Cloudflare check in front of
    // chatgpt.com reads it. The override says the same version the browser
    // would otherwise claim, so nothing else about the request changes.
    const mode = this.visible
      ? ["--window-size=1280,900"]
      : [
          "--headless=new",
          "--window-size=1280,900",
          ...(await this.headlessUserAgentArgs(binary)),
        ]
    this.chrome = spawn(
      binary,
      [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...mode,
        `${ORIGIN}/`,
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

  /**
   * The `--user-agent` a headless launch should claim, if it can be worked
   * out.
   *
   * Chrome reports its own version on `--version`, so the override differs
   * from what this browser would send by exactly one word: `HeadlessChrome`
   * becomes `Chrome`. If the version cannot be read the launch goes ahead
   * without an override rather than guessing a version — a wrong one is a
   * worse tell than an honest one.
   */
  private async headlessUserAgentArgs(binary: string): Promise<string[]> {
    const version = await new Promise<string>((resolve) => {
      execFile(binary, ["--version"], (error, stdout) =>
        resolve(error ? "" : stdout.trim())
      )
    })
    const major = /(\d+)\.\d+\.\d+\.\d+/.exec(version)?.[1]
    if (!major) {
      this.logger.warn(
        `Could not read a version from ${binary}; running headless without a ` +
          "User-Agent override"
      )
      return []
    }
    const platform =
      process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : process.platform === "win32"
          ? "Windows NT 10.0; Win64; x64"
          : "X11; Linux x86_64"
    return [
      `--user-agent=Mozilla/5.0 (${platform}) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    ]
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
      await session.send("Page.navigate", { url: `${ORIGIN}/` })
    }
    await this.waitForComposer(session)
    await this.installHook(session)
    this.session = session
    return session
  }

  /**
   * Put the hook on the page in front of us.
   *
   * Idempotent, and has to be repeated after every navigation: a new document
   * is a new `window`, and the hook that wrapped the old one went with it.
   */
  private async installHook(session: CdpSession): Promise<void> {
    const result = await session.evaluate<string>(PAGE_HOOK_SOURCE)
    if (result !== "installed" && result !== "already") {
      throw new ChatGptWebBrowserError(
        502,
        "chatgpt_web_hook_failed",
        `Could not install the page hook: ${String(result)}`
      )
    }
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
      "The ChatGPT tab never showed a composer, which is what a signed-out or " +
        "challenged page looks like. Set CHATGPT_WEB_BROWSER_VISIBLE=1 " +
        "(agentVibes.chatGptWeb.showBrowser) so the window is on screen, sign " +
        "in there once, then turn it back off"
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

  /**
   * Put the tab on the conversation this turn belongs to.
   *
   * The tab is shared, so without this a turn lands wherever the last one left
   * it: two conversations would braid into one thread, and a new one would
   * carry on an old one's context. Navigating only when the tab is somewhere
   * else keeps the common case — turn after turn in the same conversation —
   * free.
   */
  private async openConversation(
    session: CdpSession,
    conversationId?: string | null
  ): Promise<void> {
    const wanted = conversationId ? `/c/${conversationId}` : "/"
    const current = await session
      .evaluate<string>("location.pathname")
      .catch(() => "")
    if (current === wanted) return

    await session.send("Page.navigate", { url: `${ORIGIN}${wanted}` })
    await this.waitForPath(session, wanted)
    await this.waitForComposer(session)
    // The hook wrapped the window that just went away.
    await this.installHook(session)
  }

  /**
   * Wait for the new document to be the one in front of us.
   *
   * Without this the composer check can match the page being navigated away
   * from, and everything after it would be done to a document that is already
   * gone.
   */
  private async waitForPath(
    session: CdpSession,
    wanted: string
  ): Promise<void> {
    const deadline = Date.now() + PAGE_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const path = await session
        .evaluate<string>("location.pathname")
        .catch(() => "")
      if (path === wanted) return
      await delay(POLL_MS)
    }
    throw new ChatGptWebBrowserError(
      504,
      "chatgpt_web_navigation_timeout",
      `The tab did not reach ${wanted} in time`
    )
  }

  /** The conversation the tab is on, if it is on one. */
  private async currentConversationId(
    session: CdpSession
  ): Promise<string | undefined> {
    const path = await session
      .evaluate<string>("location.pathname")
      .catch(() => "")
    const match = /^\/c\/([0-9a-f-]{8,})$/i.exec(path || "")
    return match?.[1]
  }

  private async *runTurnExclusive(
    request: BrowserTurnRequest
  ): AsyncGenerator<string, void, unknown> {
    const session = await this.ensurePage()
    await this.openConversation(session, request.conversationId)

    let reported = false
    let armed = await session.evaluate<string>(this.armExpression(request))
    // A composer the app replaced under us keeps the text we typed while the
    // one on screen stays empty, so the insert is retried before giving up.
    if (armed.startsWith("not-typed") || armed === "no-composer") {
      await delay(POLL_MS)
      await this.waitForComposer(session)
      armed = await session.evaluate<string>(this.armExpression(request))
    }
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
          if (drained) {
            if (!reported) {
              // The stream names the conversation in its first frames. The
              // URL says so too, but only once the app gets round to
              // rewriting it, which can be after the answer has finished —
              // and a turn short enough for that leaves no thread behind.
              const named = /"conversation_id"\s*:\s*"([^"]{8,})"/.exec(
                drained
              )?.[1]
              if (named) {
                reported = true
                request.onConversationId?.(named)
              }
            }
            yield drained
          }
        }
        if (progress.failed) {
          throw new ChatGptWebBrowserError(
            502,
            "chatgpt_web_turn_failed",
            `The page reported: ${progress.failed.slice(0, 200)}`
          )
        }
        if (progress.done) {
          // Fallback for a turn whose frames never named it: the URL, by now.
          if (!reported) {
            const landed = await this.currentConversationId(session)
            if (landed) request.onConversationId?.(landed)
          }
          return
        }
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
   * Press send, and make sure it took.
   *
   * The button has to be clicked through the browser's input pipeline; Enter
   * and synthetic events do not reach the app's handler. But a click that
   * reaches the right coordinates can still land on nothing: right after a
   * navigation the app is still settling, and a button React is about to
   * replace swallows it silently — the composer keeps its text, no request is
   * made, and the turn waits for a stream that will never start.
   *
   * So the click is confirmed rather than assumed. The page reports when the
   * app's own turn request passes through the hook; until that happens the
   * click is simply repeated.
   */
  private async clickSend(session: CdpSession): Promise<void> {
    const deadline = Date.now() + SEND_TIMEOUT_MS
    let clicks = 0
    while (Date.now() < deadline) {
      const raw = await session.evaluate<string | null>(
        `window.${HOOK_FLAG}.sendButton()`
      )
      if (raw) {
        const box = JSON.parse(raw) as { x: number; y: number }
        await session.clickAt(box.x, box.y)
        clicks += 1
        if (await this.waitForSend(session)) {
          if (clicks > 1) {
            this.logger.warn(`Send took ${clicks} clicks to land`)
          }
          return
        }
        // The composer emptying is the app's own acknowledgement. If it has
        // and the hook still saw nothing, the turn went out through a path
        // this hook does not watch — worth saying at once rather than
        // clicking an empty box for another half minute.
        const state = await this.readProgress(session)
        if (state && !state.sent && !(state.composer ?? "").trim()) {
          throw new ChatGptWebBrowserError(
            502,
            "chatgpt_web_send_unseen",
            "The composer emptied but no turn request passed the hook; the " +
              `last conversation URL it saw was ${state.lastUrl ?? "none"}`
          )
        }
      }
      await delay(POLL_MS)
    }
    const state = await this.readProgress(session)
    throw new ChatGptWebBrowserError(
      502,
      "chatgpt_web_send_unavailable",
      `The composer did not send after ${clicks} click(s); it held ` +
        `${JSON.stringify(state?.composer ?? "")}, last conversation URL ` +
        `${state?.lastUrl ?? "none"}`
    )
  }

  private armExpression(request: BrowserTurnRequest): string {
    return (
      `window.${HOOK_FLAG}.arm(` +
      `${JSON.stringify(`plugin:${request.connectorId}`)}, ` +
      `${JSON.stringify(request.prompt)}, ` +
      `${JSON.stringify(request.model ?? null)}, ` +
      `${JSON.stringify(request.thinkingEffort ?? null)})`
    )
  }

  /** Whether the app issued its turn request, checked for a short while. */
  private async waitForSend(session: CdpSession): Promise<boolean> {
    const deadline = Date.now() + SEND_CONFIRM_MS
    while (Date.now() < deadline) {
      const state = await this.readProgress(session)
      if (state?.sent) return true
      await delay(POLL_MS)
    }
    return false
  }

  private async readProgress(session: CdpSession): Promise<{
    sent?: boolean
    composer?: string
    lastUrl?: string | null
  } | null> {
    const raw = await session
      .evaluate<string>(`window.${HOOK_FLAG}.progress()`)
      .catch(() => "")
    if (!raw) return null
    try {
      return JSON.parse(raw) as {
        sent?: boolean
        composer?: string
        lastUrl?: string | null
      }
    } catch {
      return null
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
