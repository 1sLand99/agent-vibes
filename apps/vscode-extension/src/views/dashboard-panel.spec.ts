import * as http from "http"
import type { AddressInfo } from "net"
import * as vscode from "vscode"
import { DashboardPanel } from "./dashboard-panel"

jest.mock(
  "vscode",
  () => ({
    window: {
      showErrorMessage: jest.fn(),
      showInformationMessage: jest.fn(),
      showWarningMessage: jest.fn(),
    },
  }),
  { virtual: true }
)

type EndpointProbeContext = {
  config: { caCertPath?: string }
  resolveBridgeApiKey(): string | undefined
}

type EndpointProbe = (this: EndpointProbeContext, url: string) => Promise<void>

describe("DashboardPanel endpoint probe", () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it("probes the bridge health route for an OpenAI endpoint", async () => {
    const requestedPaths: string[] = []
    const server = http.createServer((request, response) => {
      const requestPath = request.url ?? ""
      requestedPaths.push(requestPath)
      response.statusCode = requestPath === "/health" ? 200 : 404
      response.end()
    })

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })

    try {
      const address = server.address() as AddressInfo
      const endpointUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`
      const probeContext: EndpointProbeContext = {
        config: {},
        resolveBridgeApiKey: () => undefined,
      }
      const probe = (
        DashboardPanel.prototype as unknown as {
          handleTestEndpoint: EndpointProbe
        }
      ).handleTestEndpoint

      await probe.call(probeContext, endpointUrl)

      expect(requestedPaths).toEqual(["/health"])
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Endpoint reachable (HTTP 200)"
      )
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })
})
