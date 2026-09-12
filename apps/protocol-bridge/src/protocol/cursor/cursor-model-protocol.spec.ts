import {
  getCursorDisplayModels,
  isWebGptModel,
  readWebGptModel,
  WEB_GPT_CURSOR_DISPLAY_MODELS,
} from "../../llm/shared/model-registry"
import {
  buildCursorAvailableModel,
  buildLegacyCursorAvailableModels,
  CURSOR_FAST_PARAMETER_ID,
} from "./cursor-model-protocol"

const webModel = () => {
  const model = WEB_GPT_CURSOR_DISPLAY_MODELS.find(
    (candidate) => candidate.name === "web-gpt/gpt-5-6-thinking"
  )
  if (!model) throw new Error("expected a thinking model in the web catalogue")
  return model
}

describe("the `web-gpt/` prefix", () => {
  it("names the chatgpt.com model behind it", () => {
    expect(readWebGptModel("web-gpt/gpt-5-6-thinking")).toBe("gpt-5-6-thinking")
    expect(readWebGptModel("web-gpt:gpt-6-pro")).toBe("gpt-6-pro")
    expect(readWebGptModel(" web-gpt/gpt-5-5 ")).toBe("gpt-5-5")
  })

  it("does not read one into a model that merely mentions the web", () => {
    // The prefix is the switch that spends a different quota, so it has to be
    // asked for exactly — never inferred from a name that looks similar.
    expect(readWebGptModel("gpt-5-6-thinking")).toBeNull()
    expect(readWebGptModel("web-gpt")).toBeNull()
    expect(readWebGptModel("my-web-gpt/gpt-5-6")).toBeNull()
    expect(isWebGptModel("gpt-5.6-web")).toBe(false)
  })
})

describe("ChatGPT Web models in the picker", () => {
  it("are listed even when the Codex backend is absent", () => {
    // They are served by chatgpt.com's web app, so a missing Codex backend
    // says nothing about whether they can run.
    const names = getCursorDisplayModels({ includeCodex: false }).map(
      (model) => model.name
    )
    expect(names).toContain("web-gpt/gpt-5-6-thinking")
    expect(names).toContain("web-gpt/gpt-6-pro")
  })

  it("keep the prefix in the name, because that is the routing switch", () => {
    for (const model of WEB_GPT_CURSOR_DISPLAY_MODELS) {
      expect(model.name.startsWith("web-gpt/")).toBe(true)
    }
  })

  it("survive the dedup that merges dynamic model metadata", () => {
    const listed = getCursorDisplayModels().filter((model) =>
      isWebGptModel(model.name)
    )
    expect(listed).toHaveLength(WEB_GPT_CURSOR_DISPLAY_MODELS.length)
  })
})

describe("projecting a ChatGPT Web model onto Cursor's protocol", () => {
  it("does not offer fast mode, which is a Codex-only tier", () => {
    const projected = buildCursorAvailableModel(webModel(), 0)
    const parameterIds = projected.parameterDefinitions.map(
      (definition) => definition.id
    )
    expect(parameterIds).not.toContain(CURSOR_FAST_PARAMETER_ID)
  })

  it("keeps agent mode on, since Cursor's own tools run the turn", () => {
    const projected = buildCursorAvailableModel(webModel(), 0)
    expect(projected.supportsAgent).toBe(true)
    expect(projected.name).toBe("web-gpt/gpt-5-6-thinking")
    expect(projected.serverModelName).toBe("web-gpt/gpt-5-6-thinking")
  })

  it("refuses images rather than dropping them in the transport", () => {
    const projected = buildCursorAvailableModel(webModel(), 0)
    expect(projected.supportsImages).toBe(false)
  })

  it("stays a single entry on the legacy picker path", () => {
    // The legacy path explodes a gpt model into one top-level entry per
    // reasoning effort and fast-mode combination. A web model has neither, so
    // exploding it would mint ids like `web-gpt/gpt-5-6-thinking-high-fast`
    // that chatgpt.com's catalogue has never heard of.
    const legacy = buildLegacyCursorAvailableModels(webModel(), 0)
    expect(legacy).toHaveLength(1)
    expect(legacy[0]!.name).toBe("web-gpt/gpt-5-6-thinking")
  })
})
