import { ModelRouterService, routableModelId } from "./model-router.service"

describe("routing a `web-gpt/` model", () => {
  const router = new ModelRouterService()

  it("sends it to the browser-backed backend, prefix stripped", () => {
    expect(router.resolveModel("web-gpt/gpt-6-pro")).toEqual({
      backend: "chatgpt-web",
      model: "gpt-6-pro",
      isThinking: false,
    })
    expect(router.resolveModel("web-gpt/gpt-5-6-thinking").isThinking).toBe(
      true
    )
  })

  it("survives a round trip through a resolved route", () => {
    // The stream helpers re-enter the router with an already-resolved route to
    // derive a fresh one per attempt. Feeding back `route.model` alone asked
    // about a bare chatgpt.com slug, which the Codex path then rejected —
    // "Model gpt-6-pro is not supported by the configured Codex account".
    const route = router.resolveModel("web-gpt/gpt-6-pro")
    expect(router.resolveModel(routableModelId(route))).toEqual(route)
  })

  it("is the only thing that makes those slugs routable at all", () => {
    // Pinning the reason the helper exists: nothing local serves `gpt-6-pro`.
    // Which refusal comes back depends on whether a Codex account is
    // configured — bare here, "not supported by the configured Codex account"
    // on a bridge that has one — but it is always a refusal.
    expect(() => router.resolveModel("gpt-6-pro")).toThrow(
      /No GPT backend available|not supported by the configured Codex account/
    )
  })

  it("leaves every other backend's model id untouched", () => {
    expect(
      routableModelId({
        backend: "codex",
        model: "gpt-5.5",
        isThinking: false,
      })
    ).toBe("gpt-5.5")
    expect(
      routableModelId({
        backend: "google",
        model: "gemini-3.1-pro-high",
        isThinking: true,
      })
    ).toBe("gemini-3.1-pro-high")
  })
})
