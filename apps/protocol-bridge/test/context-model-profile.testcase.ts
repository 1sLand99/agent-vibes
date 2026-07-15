import assert from "node:assert/strict"
import test from "node:test"
import {
  buildContextProjectionBudgetSignature,
  isContextAccountingProfileCompatible,
  resolveContextModelProfile,
} from "../src/context/context-model-profile"
import { ContextRequestPlannerService } from "../src/context/context-request-planner.service"
import { TokenCounterService } from "../src/context/token-counter.service"

void test("isolates equal-sized GPT and Claude context profiles", () => {
  const gptProfile = resolveContextModelProfile({
    backend: "codex",
    model: "gpt-5.6-sol",
    family: "gpt",
    maxTokens: 200_000,
  })
  const claudeProfile = resolveContextModelProfile({
    backend: "claude-api",
    model: "claude-opus-4.8",
    family: "claude",
    maxTokens: 200_000,
  })

  assert.equal(gptProfile.tokenizer, "openai")
  assert.equal(claudeProfile.tokenizer, "claude")
  assert.notEqual(gptProfile.key, claudeProfile.key)

  const commonBudget = {
    maxTokens: 200_000,
    systemPromptTokens: 12_000,
    autoCompactTokenLimit: 180_000,
    predictiveCompactTokenLimit: undefined,
  }
  assert.notEqual(
    buildContextProjectionBudgetSignature({
      ...commonBudget,
      contextProfile: gptProfile,
    }),
    buildContextProjectionBudgetSignature({
      ...commonBudget,
      contextProfile: claudeProfile,
    })
  )
})

void test("keeps tokenizer caches isolated across model switches", () => {
  const counter = new TokenCounterService()
  counter.onModuleInit()

  try {
    const text = "你好，世界！这是一个跨模型 tokenizer 测试。"
    const claudeTokens = counter.countText(text, true, "claude")
    const openaiTokens = counter.countText(text, true, "openai")
    const conservativeTokens = counter.countText(text, true, "conservative")

    assert.notEqual(claudeTokens, openaiTokens)
    assert.equal(conservativeTokens, Math.max(claudeTokens, openaiTokens))
    assert.equal(counter.countText(text, true, "claude"), claudeTokens)
    assert.equal(counter.countText(text, true, "openai"), openaiTokens)

    const message = { role: "user" as const, content: text }
    const claudeMessageTokens = counter.countMessages([message], true, "claude")
    const openaiMessageTokens = counter.countMessages([message], true, "openai")
    assert.notEqual(claudeMessageTokens, openaiMessageTokens)
    assert.equal(
      counter.countMessages([message], true, "claude"),
      claudeMessageTokens
    )
  } finally {
    counter.onModuleDestroy()
  }
})

void test("builds the budget profile after applying backend clamps", () => {
  const counter = new TokenCounterService()
  const planner = new ContextRequestPlannerService(counter, null as never)
  const budget = planner.resolveBudget({
    backend: "codex",
    model: "gpt-5.6-sol",
    modelFamily: "gpt",
    protocolMaxTokens: 400_000,
    backendMaxTokens: 200_000,
    defaultMaxTokens: 200_000,
  })

  assert.equal(budget.maxTokens, 200_000)
  assert.equal(budget.contextProfile.maxTokens, 200_000)
  assert.equal(budget.contextProfile.tokenizer, "openai")
  assert.ok(/gpt-5\.6-sol/.test(budget.contextProfile.key))
})

void test("rejects token-derived state from another context profile", () => {
  assert.equal(
    isContextAccountingProfileCompatible(
      "codex:gpt-5.6-sol:gpt:openai:200000",
      "codex:gpt-5.6-sol:gpt:openai:200000"
    ),
    true
  )
  assert.equal(
    isContextAccountingProfileCompatible(
      "claude-api:claude-opus-4.8:claude:claude:200000",
      "codex:gpt-5.6-sol:gpt:openai:200000"
    ),
    false
  )
  assert.equal(
    isContextAccountingProfileCompatible(
      undefined,
      "codex:gpt-5.6-sol:gpt:openai:200000"
    ),
    false
  )
})
