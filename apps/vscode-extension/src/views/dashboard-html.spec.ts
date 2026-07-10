import * as fs from "fs"
import * as path from "path"
import * as vm from "vm"

type ClipboardMessage = {
  type: string
  text: string
}

describe("dashboard endpoint copy", () => {
  it("posts the bridge origin for every endpoint URL", () => {
    const dashboardHtml = fs.readFileSync(
      path.resolve(__dirname, "../../resources/dashboard.html"),
      "utf8"
    )
    const copyStart = dashboardHtml.indexOf(
      "      function endpointCopy(url) {"
    )
    const copyEnd = dashboardHtml.indexOf("      function endpointTest(url) {")
    expect(copyStart).toBeGreaterThanOrEqual(0)
    expect(copyEnd).toBeGreaterThan(copyStart)

    const messages: ClipboardMessage[] = []
    const context = vm.createContext({
      URL,
      vscode: {
        postMessage(message: ClipboardMessage) {
          messages.push(message)
        },
      },
    })
    vm.runInContext(dashboardHtml.slice(copyStart, copyEnd), context)

    const endpointCopy = context.endpointCopy as (url: string) => void
    const endpointUrls = [
      "https://localhost:2026/health",
      "https://localhost:2026/{agent,aiserver}.v1.*",
      "https://localhost:2026/v1/messages",
      "https://localhost:2026/v1/chat/completions",
      "https://localhost:2026/v1beta/models/{model}:generateContent",
    ]

    for (const endpointUrl of endpointUrls) {
      expect(() => endpointCopy(endpointUrl)).not.toThrow()
    }
    expect(messages).toEqual(
      endpointUrls.map(() => ({
        type: "copyToClipboard",
        text: "https://localhost:2026",
      }))
    )
  })
})
