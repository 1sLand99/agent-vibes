import {
  getCursorOfficialPassthroughTarget,
  isCursorOfficialPassthroughEnabled,
} from "./cursor-official-passthrough"

describe("cursor official passthrough routing", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("keeps local model catalog routes on the bridge", () => {
    expect(
      getCursorOfficialPassthroughTarget(
        "/aiserver.v1.AiService/AvailableModels",
        "POST"
      )
    ).toBeNull()
    expect(
      getCursorOfficialPassthroughTarget(
        "/agent.v1.AgentService/GetUsableModels",
        "POST"
      )
    ).toBeNull()
  })

  it("keeps the agent stream on the bridge", () => {
    expect(
      getCursorOfficialPassthroughTarget("/agent.v1.AgentService/Run", "POST")
    ).toBeNull()
  })

  it("passes official account and usage routes to the Cursor API host", () => {
    expect(
      getCursorOfficialPassthroughTarget(
        "/aiserver.v1.AuthService/GetEmail",
        "POST"
      )
    ).toMatchObject({
      family: "api",
      baseUrl: "https://api2.cursor.sh",
      normalizedPath: "aiserver.v1.AuthService/GetEmail",
    })
    expect(
      getCursorOfficialPassthroughTarget(
        "/aiserver.v1.DashboardService/GetPlanInfo",
        "POST"
      )
    ).toMatchObject({
      family: "api",
      baseUrl: "https://api2.cursor.sh",
    })
  })

  it("keeps the local entitlement profile used by model gates", () => {
    expect(
      getCursorOfficialPassthroughTarget("/auth/full_stripe_profile", "GET")
    ).toBeNull()
  })

  it("passes login and billing backend auth routes to the Cursor API host", () => {
    const officialAuthPaths = [
      "/auth/poll",
      "/auth/logout",
      "/auth/stripe_profile",
      "/auth/has_valid_payment_method",
      "/auth/start-subscription-now",
      "/auth/cursor_dev_session_token?plan=pro",
    ]

    for (const path of officialAuthPaths) {
      expect(getCursorOfficialPassthroughTarget(path, "GET")).toMatchObject({
        family: "api",
        baseUrl: "https://api2.cursor.sh",
      })
    }
  })

  it("passes non-local agent service routes to the official agent host", () => {
    expect(
      getCursorOfficialPassthroughTarget(
        "/agent.v1.AgentService/SomeOfficialMethod",
        "POST"
      )
    ).toMatchObject({
      family: "agent",
      baseUrl: "https://agentn.api5.cursor.sh",
    })
  })

  it("honors explicit upstream host overrides", () => {
    process.env.CURSOR_OFFICIAL_API_BASE_URL = "https://api2geo.cursor.sh"
    process.env.CURSOR_OFFICIAL_AGENT_BASE_URL = "https://agent.api2.cursor.sh"

    expect(
      getCursorOfficialPassthroughTarget(
        "/aiserver.v1.AuthService/GetEmail",
        "POST"
      )?.baseUrl
    ).toBe("https://api2geo.cursor.sh")
    expect(
      getCursorOfficialPassthroughTarget(
        "/agent.v1.AgentService/SomeOfficialMethod",
        "POST"
      )?.baseUrl
    ).toBe("https://agent.api2.cursor.sh")
  })

  it("can be disabled by environment", () => {
    expect(isCursorOfficialPassthroughEnabled()).toBe(true)
    process.env.CURSOR_OFFICIAL_PASSTHROUGH = "false"
    expect(isCursorOfficialPassthroughEnabled()).toBe(false)
  })
})
