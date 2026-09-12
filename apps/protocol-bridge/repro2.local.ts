import * as fs from "node:fs"
import type { ConfigService } from "@nestjs/config"
import { ChatGptWebBrowserService } from "./src/llm/openai/chatgpt-web-browser.service"
import { ChatGptWebCursorBridge } from "./src/llm/openai/chatgpt-web-cursor-bridge.service"
import { McpCursorToolsProvider } from "./src/protocol/mcp/mcp-cursor-tools.provider"
import { McpService } from "./src/protocol/mcp/mcp.service"

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
  CHATGPT_WEB_CONNECTOR_ID: "asdk_app_6aa4c00eaf08819183653b8cd2e4c7c2",
}
const config = {
  get: (key: string, fallback = "") => env[key] ?? fallback,
} as unknown as ConfigService

async function main() {
  say("start")
  const browser = new ChatGptWebBrowserService(config)
  const tools = new McpCursorToolsProvider(new McpService())
  const bridge = new ChatGptWebCursorBridge(config, browser, tools)
  say("constructed")
  for await (const frame of bridge.stream({
    conversationId: "repro-2",
    model: "gpt-5-6",
    prompt: "Reply with exactly: SEGMENT-OK",
    toolResults: [],
  })) {
    say("frame " + (/^event: (\S+)/.exec(frame)?.[1] ?? "?"))
  }
  say("segment ended; sink attached=" + String(tools.attached))
  process.exit(0)
}
main().catch((error) => {
  say("ERROR " + String(error))
  process.exit(1)
})
