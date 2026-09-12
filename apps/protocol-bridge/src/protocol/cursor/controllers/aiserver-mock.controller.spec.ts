import { AiserverMockController } from "./aiserver-mock.controller"

/**
 * The picker Cursor draws comes from `AvailableModels`, and every model in it
 * passes a routability check first: a model nobody can serve is worse than a
 * model nobody sees. The ChatGPT Web entries have no registry entry to consult
 * — the slug behind `web-gpt/` is chatgpt.com's — so the check has to know
 * about them explicitly, and these tests pin that it does.
 */

const dep = <T>(value: unknown): T => value as T

function controllerWith(chatGptWebAccounts: number): AiserverMockController {
  const noModels = {
    getCursorDisplayModels: () => [],
    supportsModel: () => false,
  }
  return new AiserverMockController(
    dep(null),
    dep({ getCursorDisplayModels: () => [], isValidModel: () => false }),
    dep({
      isAvailable: () => true,
      getModelTier: () => null,
      // Every Codex model routes, so the list this builds is the real one
      // minus the backends these tests do not stub.
      supportsModel: () => true,
      getChatGptWebRealtimeAccountCount: () => chatGptWebAccounts,
    }),
    dep(noModels),
    dep(noModels),
    dep({ isGoogleAvailable: false }),
    dep({ isAvailable: () => false }),
    dep(null),
    dep(null),
    dep(null)
  )
}

function listedModelNames(controller: AiserverMockController): string[] {
  const build = (
    controller as unknown as {
      buildCursorModels: () => { name: string }[]
    }
  ).buildCursorModels.bind(controller)
  return build().map((model) => model.name)
}

describe("AiserverMockController model listing", () => {
  it("offers the ChatGPT Web models once there is a login to spend", () => {
    const names = listedModelNames(controllerWith(1))
    expect(names).toContain("web-gpt/gpt-5-6-thinking")
    expect(names).toContain("web-gpt/gpt-6-pro")
  })

  it("hides them when no ChatGPT credential is configured", () => {
    // Listing a model whose every turn would fail sends the user debugging
    // their prompt instead of their accounts.
    const names = listedModelNames(controllerWith(0))
    expect(names.filter((name) => name.startsWith("web-gpt/"))).toEqual([])
  })

  it("lists them alongside the Codex models rather than in place of them", () => {
    const names = listedModelNames(controllerWith(1))
    expect(names.some((name) => name.startsWith("web-gpt/"))).toBe(true)
    expect(names.some((name) => !name.startsWith("web-gpt/"))).toBe(true)
  })
})
