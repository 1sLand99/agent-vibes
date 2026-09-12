import { ConfigService } from "@nestjs/config"
import type { ChatGptWebBrowserService } from "../../llm/openai/chatgpt-web-browser.service"
import { ChatGptWebError } from "../../llm/openai/chatgpt-web-conversation.service"
import { ChatGptWebTransportSelector } from "./chatgpt-web-transport.selector"

const configWith = (env: Record<string, string>) =>
  ({
    get: (key: string, fallback = "") => env[key] ?? fallback,
  }) as unknown as ConfigService

function browserYielding(chunks: string[]): ChatGptWebBrowserService {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamTurn() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as ChatGptWebBrowserService
}

describe("ChatGptWebTransportSelector", () => {
  describe("choosing a transport", () => {
    it("defaults to http, because the browser path is the fragile one", () => {
      const selector = new ChatGptWebTransportSelector(
        configWith({}),
        browserYielding([])
      )
      expect(selector.resolve("gpt-5.5")).toBe("http")
    })

    it("honours the deployment default", () => {
      const selector = new ChatGptWebTransportSelector(
        configWith({ CHATGPT_WEB_TRANSPORT: "browser" }),
        browserYielding([])
      )
      expect(selector.resolve("gpt-5.5")).toBe("browser")
    })

    it("lets one request opt in without changing the default", () => {
      const selector = new ChatGptWebTransportSelector(
        configWith({}),
        browserYielding([])
      )
      expect(selector.resolve("browser/gpt-5-6-thinking")).toBe("browser")
      expect(selector.resolve("browser:gpt-5-6-thinking")).toBe("browser")
    })

    it("strips the prefix so upstream sees a model it knows", () => {
      expect(ChatGptWebTransportSelector.stripPrefix("browser/gpt-5-6")).toBe(
        "gpt-5-6"
      )
      expect(ChatGptWebTransportSelector.stripPrefix(" gpt-5-6 ")).toBe(
        "gpt-5-6"
      )
    })
  })

  describe("streaming a turn", () => {
    const fixture =
      'data: {"p":"","o":"add","c":0,"v":{"message":{"author":{"role":"assistant"},' +
      '"metadata":{"recipient":"all"},"content":{"content_type":"text","parts":["hello"]}}}}\n' +
      'data: {"p":"/message/content/parts/0","o":"append","c":0,"v":" world"}\n' +
      "data: [DONE]\n"

    it("turns decoded browser output into transport-neutral events", async () => {
      const selector = new ChatGptWebTransportSelector(
        configWith({ CHATGPT_WEB_CONNECTOR_ID: "asdk_app_x" }),
        browserYielding([fixture])
      )
      const events = []
      for await (const event of selector.stream("gpt-5-6", [
        { role: "user", content: "hi" },
      ])) {
        events.push(event)
      }
      expect(events).toEqual([
        { kind: "text", delta: "hello" },
        { kind: "text", delta: " world" },
        { kind: "done", conversationId: undefined },
      ])
    })

    it("refuses to run without a connector rather than silently losing tools", async () => {
      const selector = new ChatGptWebTransportSelector(
        configWith({}),
        browserYielding([fixture])
      )
      const iterator = selector.stream("gpt-5-6", [
        { role: "user", content: "hi" },
      ])
      await expect(iterator.next()).rejects.toThrow(ChatGptWebError)
      await expect(
        selector.stream("gpt-5-6", [{ role: "user", content: "hi" }]).next()
      ).rejects.toThrow(/CHATGPT_WEB_CONNECTOR_ID/)
    })

    it("passes a single message through untouched", async () => {
      let seen = ""
      const browser = {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *streamTurn(request: { prompt: string }) {
          seen = request.prompt
          yield "data: [DONE]\n"
        },
      } as unknown as ChatGptWebBrowserService
      const selector = new ChatGptWebTransportSelector(
        configWith({ CHATGPT_WEB_CONNECTOR_ID: "asdk_app_x" }),
        browser
      )
      for await (const _ of selector.stream("gpt-5-6", [
        { role: "user", content: "just this" },
      ])) {
        // drain
      }
      expect(seen).toBe("just this")
    })

    it("folds a history into one prompt, since a turn is one submission", async () => {
      let seen = ""
      const browser = {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *streamTurn(request: { prompt: string }) {
          seen = request.prompt
          yield "data: [DONE]\n"
        },
      } as unknown as ChatGptWebBrowserService
      const selector = new ChatGptWebTransportSelector(
        configWith({ CHATGPT_WEB_CONNECTOR_ID: "asdk_app_x" }),
        browser
      )
      for await (const _ of selector.stream("gpt-5-6", [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ])) {
        // drain
      }
      expect(seen).toContain("[Instructions]")
      expect(seen).toContain("be terse")
      expect(seen).toContain("hello")
    })
  })
})
