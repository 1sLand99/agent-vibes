import type { ConfigService } from "@nestjs/config"
import { ChatGptWebBrowserService } from "./src/llm/openai/chatgpt-web-browser.service"
import { ChatGptWebCursorBridge } from "./src/llm/openai/chatgpt-web-cursor-bridge.service"
import { McpCursorToolsProvider } from "./src/protocol/mcp/mcp-cursor-tools.provider"
import { McpService } from "./src/protocol/mcp/mcp.service"

const env: Record<string, string> = {
  CHATGPT_WEB_BROWSER_PORT: "9333",
  CHATGPT_WEB_BROWSER_PROFILE: `${process.env.HOME}/.agent-vibes/chatgpt-browser-profile`,
  CHATGPT_WEB_CONNECTOR_ID: "asdk_app_6aa4c00eaf08819183653b8cd2e4c7c2",
}
const config = {
  get: (key: string, fallback = "") => env[key] ?? fallback,
} as unknown as ConfigService

async function main() {
  const browser = new ChatGptWebBrowserService(config)
  const tools = new McpCursorToolsProvider(new McpService())
  const bridge = new ChatGptWebCursorBridge(config, browser, tools)
  const started = Date.now()
  const events: string[] = []
  for await (const frame of bridge.stream({
    conversationId: "repro-1",
    model: "gpt-5-6",
    prompt: "Reply with exactly: SEGMENT-OK",
    toolResults: [],
  })) {
    const event = /^event: (\S+)/.exec(frame)?.[1] ?? "?"
    events.push(event)
    console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${event}`)
  }
  console.log(
    "segment ended after",
    ((Date.now() - started) / 1000).toFixed(1),
    "s"
  )
  console.log("events:", events.join(","))
  console.log("sink still attached:", tools.attached)
  process.exit(0)
}
void main()
