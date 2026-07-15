import assert from "node:assert/strict"
import test from "node:test"
import { resolveSessionContextWindowTransition } from "../src/protocol/cursor/session/context-window-transition"

void test("drops a conversation-state window when the model changes", () => {
  const transition = resolveSessionContextWindowTransition({
    current: {
      model: "claude-opus-4.8",
      contextTokenLimit: 200_000,
      contextMaxMode: false,
    },
    incoming: {
      model: "gpt-5.6-sol",
      contextTokenLimit: 200_000,
      contextTokenLimitSource: "conversation_state",
      contextMaxMode: false,
    },
    canRefreshProvidedFields: true,
    canClearRequestScopedFields: true,
  })

  assert.equal(transition.model, "gpt-5.6-sol")
  assert.equal(transition.modelChanged, true)
  assert.equal(transition.contextTokenLimit, undefined)
  assert.equal(transition.contextMaxMode, false)
})

void test("preserves an explicit window override across a model change", () => {
  const transition = resolveSessionContextWindowTransition({
    current: {
      model: "claude-opus-4.8",
      contextTokenLimit: 200_000,
      contextMaxMode: false,
    },
    incoming: {
      model: "gpt-5.6-sol",
      contextTokenLimit: 272_000,
      contextTokenLimitSource: "requested",
      contextMaxMode: true,
    },
    canRefreshProvidedFields: true,
    canClearRequestScopedFields: true,
  })

  assert.equal(transition.contextTokenLimit, 272_000)
  assert.equal(transition.contextMaxMode, true)
})

void test("keeps a reported window for the same model", () => {
  const transition = resolveSessionContextWindowTransition({
    current: {
      model: "claude-opus-4.8",
      contextTokenLimit: 200_000,
      contextMaxMode: false,
    },
    incoming: {
      model: "claude-opus-4.8",
      contextTokenLimit: 200_000,
      contextTokenLimitSource: "conversation_state",
    },
    canRefreshProvidedFields: true,
    canClearRequestScopedFields: false,
  })

  assert.equal(transition.modelChanged, false)
  assert.equal(transition.contextTokenLimit, 200_000)
  assert.equal(transition.contextMaxMode, false)
})

void test("does not mutate context settings for control frames", () => {
  const transition = resolveSessionContextWindowTransition({
    current: {
      model: "claude-opus-4.8",
      contextTokenLimit: 200_000,
      contextMaxMode: true,
    },
    incoming: {
      model: "gpt-5.6-sol",
      contextTokenLimit: 120_000,
      contextTokenLimitSource: "conversation_state",
      contextMaxMode: false,
    },
    canRefreshProvidedFields: false,
    canClearRequestScopedFields: false,
  })

  assert.deepEqual(transition, {
    model: "claude-opus-4.8",
    modelChanged: false,
    contextTokenLimit: 200_000,
    contextMaxMode: true,
  })
})
