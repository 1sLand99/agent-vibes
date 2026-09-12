import {
  getCursorDisplayModels,
  isWebGptModel,
  readWebGptModel,
  webGptCursorEffortLevels,
  webGptThinkingEffort,
  WEB_GPT_CURSOR_DISPLAY_MODELS,
} from "../../llm/shared/model-registry"
import {
  buildCursorAvailableModel,
  buildLegacyCursorAvailableModels,
  CURSOR_FAST_PARAMETER_ID,
  CURSOR_REASONING_PARAMETER_ID,
  parseCursorVariantString,
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

  it("explodes into one entry per depth on the legacy picker path", () => {
    // The legacy path has no parameters, so a depth can only be expressed as
    // its own entry. Every name it mints has to survive the trip back through
    // parseCursorVariantString to the same model and effort.
    const legacy = buildLegacyCursorAvailableModels(webModel(), 0)
    expect(legacy.map((entry) => entry.name)).toEqual([
      "web-gpt/gpt-5-6-thinking",
      "web-gpt/gpt-5-6-thinking-low",
      "web-gpt/gpt-5-6-thinking-high",
      "web-gpt/gpt-5-6-thinking-xhigh",
    ])
    // No fast-mode entries: that tier is Codex's and does not exist here.
    expect(legacy.some((entry) => entry.name.includes("fast"))).toBe(false)
    for (const entry of legacy.slice(1)) {
      const parsed = parseCursorVariantString(entry.name)
      expect(parsed?.baseModel).toBe("web-gpt/gpt-5-6-thinking")
    }
  })
})

describe("thinking depth on a ChatGPT Web model", () => {
  /**
   * chatgpt.com publishes a `thinking_efforts` list per model at
   * /backend-api/models: min / standard / extended / max for the thinking
   * models, fewer for Pro, none for the instant and mini ones. These pin the
   * two ladders against each other.
   */
  it("offers the depths the web app itself offers", () => {
    expect(webGptCursorEffortLevels("web-gpt/gpt-5-6-thinking")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    expect(webGptCursorEffortLevels("web-gpt/gpt-5-5-pro")).toEqual([
      "medium",
      "high",
    ])
  })

  it("offers none where there is nothing to choose", () => {
    // One depth is not a choice, and a model with no depths would reject one.
    expect(webGptCursorEffortLevels("web-gpt/gpt-6-pro")).toEqual([])
    expect(webGptCursorEffortLevels("web-gpt/gpt-5-6")).toEqual([])
    expect(webGptCursorEffortLevels("web-gpt/o3-pro")).toEqual([])
  })

  it("translates a Cursor effort into ChatGPT's own word for it", () => {
    const effort = (level: string) =>
      webGptThinkingEffort("web-gpt/gpt-5-6-thinking", level)
    expect(effort("low")).toBe("min")
    expect(effort("medium")).toBe("standard")
    expect(effort("high")).toBe("extended")
    expect(effort("xhigh")).toBe("max")
  })

  it("caps a request at the deepest the model actually has", () => {
    // gpt-5-5-pro stops at extended. Sending `max` would be a value the web
    // app never offers for it.
    expect(webGptThinkingEffort("web-gpt/gpt-5-5-pro", "xhigh")).toBe(
      "extended"
    )
    expect(webGptThinkingEffort("web-gpt/gpt-6-pro", "xhigh")).toBe("standard")
  })

  it("says nothing when there is nothing to say", () => {
    // A null leaves the web app's own default in place, which is what a model
    // with no depths and a turn with no preference both want.
    expect(webGptThinkingEffort("web-gpt/gpt-5-6", "high")).toBeNull()
    expect(
      webGptThinkingEffort("web-gpt/gpt-5-6-thinking", undefined)
    ).toBeNull()
  })

  it("offers no Max toggle, which would be wired to nothing", () => {
    // Max mode buys a bigger context and a longer leash inside Cursor. The web
    // transport can ask chatgpt.com for neither.
    const projected = buildCursorAvailableModel(webModel(), 0)
    expect(projected.supportsMaxMode).toBe(false)
    expect(projected.supportsNonMaxMode).toBe(true)
    expect(projected.variants.every((variant) => !variant.isMaxMode)).toBe(true)
  })

  it("shows a single-depth model as one entry, not a toggle", () => {
    // GPT-6 Pro publishes exactly one depth. Two variants differing only by a
    // switch nothing reads is noise.
    const pro = WEB_GPT_CURSOR_DISPLAY_MODELS.find(
      (model) => model.name === "web-gpt/gpt-6-pro"
    )!
    const projected = buildCursorAvailableModel(pro, 0)
    expect(projected.variants).toHaveLength(1)
    expect(
      projected.parameterDefinitions.map((definition) => definition.id)
    ).not.toContain(CURSOR_REASONING_PARAMETER_ID)
  })

  it("reaches Cursor's picker as a reasoning parameter", () => {
    const projected = buildCursorAvailableModel(webModel(), 0)
    const reasoning = projected.parameterDefinitions.find(
      (definition) => definition.id === CURSOR_REASONING_PARAMETER_ID
    )
    expect(reasoning).toBeDefined()
    expect(projected.variants.length).toBeGreaterThan(1)
  })
})
