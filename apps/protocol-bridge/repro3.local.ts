import * as fs from "node:fs"
import type { ConfigService } from "@nestjs/config"
import { ChatGptWebBrowserService } from "./src/llm/openai/chatgpt-web-browser.service"
import { ChatGptWebTurnSession } from "./src/llm/openai/chatgpt-web-turn-session"

const LOG = process.argv[2]!
const started = Date.now()
const say = (line: string) =>
  fs.appendFileSync(
    LOG,
    `${((Date.now() - started) / 1000).toFixed(1)}s ${line}\n`
  )

const env: Record<string, string> = {
  CHATGPT_WEB_BROWSER_PORT: "9333",
  CHATGPT_WEB_BROWSER_PROFILE: `${process.env.HOME}/.agent-vibes/chatgpt-browser-profile`,
}
const config = {
  get: (k: string, f = "") => env[k] ?? f,
} as unknown as ConfigService

async function main() {
  const browser = new ChatGptWebBrowserService(config)
  // Wrap the browser stream so every chunk and the end are visible.
  async function* traced(): AsyncGenerator<string> {
    say("source: starting")
    try {
      for await (const chunk of browser.streamTurn({
        prompt: "Reply with exactly: SEGMENT-OK",
        connectorId: "asdk_app_6aa4c00eaf08819183653b8cd2e4c7c2",
        model: "gpt-5-6",
      })) {
        say(`source: chunk ${chunk.length} bytes`)
        yield chunk
      }
      say("source: generator ended")
    } finally {
      say("source: finally")
    }
  }
  const session = new ChatGptWebTurnSession({ source: traced() })
  const peek = setInterval(() => {
    const s = session as unknown as {
      queue: unknown[]
      sourceDone: boolean
      ended: boolean
      pending: Map<string, unknown>
    }
    say(
      `state queue=${s.queue.length} sourceDone=${s.sourceDone} ended=${s.ended} pending=${s.pending.size} finished=${session.finished}`
    )
  }, 5000)
  for await (const frame of session.segment()) {
    say("frame " + (/^event: (\S+)/.exec(frame)?.[1] ?? "?"))
  }
  clearInterval(peek)
  say("segment ended; finished=" + String(session.finished))
  process.exit(0)
}
main().catch((e) => {
  say("ERROR " + String(e))
  process.exit(1)
})
