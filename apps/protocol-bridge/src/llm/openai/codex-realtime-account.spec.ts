import {
  deriveChatGptWebDeviceId,
  resolveChatGptWebDeviceId,
} from "./codex-realtime-account"

describe("ChatGPT Web device identity", () => {
  it("derives a stable UUID without exposing the slot key", () => {
    const first = deriveChatGptWebDeviceId("codex-slot:v1:secret-material")
    const second = deriveChatGptWebDeviceId("codex-slot:v1:secret-material")

    expect(first).toBe(second)
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(first).not.toContain("secret-material")
  })

  it("keeps a configured UUID and replaces malformed values", () => {
    const configured = "58c4f084-baa7-43ed-897e-92497a1d26f0"
    expect(resolveChatGptWebDeviceId(configured, "slot")).toBe(configured)
    expect(resolveChatGptWebDeviceId("not-a-uuid", "slot")).not.toBe(
      "not-a-uuid"
    )
  })
})
