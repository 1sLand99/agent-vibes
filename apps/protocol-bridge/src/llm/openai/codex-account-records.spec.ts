import {
  buildCodexFileSlotRecordFields,
  upsertCodexPersistedAccountRecord,
} from "./codex-account-records"

describe("Codex Web Live account metadata", () => {
  it("loads and persists deviceId with the existing Codex account", () => {
    const deviceId = "58c4f084-baa7-43ed-897e-92497a1d26f0"
    const fields = buildCodexFileSlotRecordFields(
      {
        configPath: "/tmp/codex-accounts.json",
        email: "voice@example.com",
        accessToken: "old-token",
        deviceId,
      },
      "https://chatgpt.com/backend-api/codex",
      ""
    )

    expect(fields.deviceId).toBe(deviceId)
    const records = upsertCodexPersistedAccountRecord({
      accounts: [],
      account: fields,
      tokenData: {
        accessToken: "new-token",
        refreshToken: "refresh-token",
        idToken: "id-token",
        workspaceId: "workspace",
        expire: "2099-01-01T00:00:00.000Z",
      },
    })
    expect(records[0]?.deviceId).toBe(deviceId)
  })
})
