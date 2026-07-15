import assert from "node:assert/strict"
import test from "node:test"
import { getCursorDisplayModel } from "../src/llm/shared/model-registry"
import { buildCursorAvailableModel } from "../src/protocol/cursor/cursor-model-protocol"

function buildModel(modelId: string) {
  const model = getCursorDisplayModel(modelId)
  assert.ok(model, `missing display model: ${modelId}`)
  return buildCursorAvailableModel(model, 0)
}

void test("Claude reasoning variants only contain declared parameters", () => {
  const model = buildModel("claude-opus-4-8-thinking")
  const declaredParameterIds = new Set(
    model.parameterDefinitions.map((definition) => definition.id)
  )

  assert.deepEqual([...declaredParameterIds], ["thinking"])
  for (const variant of model.variants) {
    for (const parameter of variant.parameterValues) {
      assert.ok(
        declaredParameterIds.has(parameter.id),
        `variant contains undeclared parameter: ${parameter.id}`
      )
    }
    assert.doesNotMatch(variant.variantStringRepresentation, /(?:^|[,()])fast=/)
  }
})

void test("GPT reasoning variants retain the declared fast parameter", () => {
  const model = buildModel("gpt-5.6-sol")
  const declaredParameterIds = new Set(
    model.parameterDefinitions.map((definition) => definition.id)
  )

  assert.ok(declaredParameterIds.has("fast"))
  assert.ok(
    model.variants.every((variant) =>
      variant.parameterValues.some((parameter) => parameter.id === "fast")
    )
  )
})
