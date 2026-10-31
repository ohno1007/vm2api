import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCliUsageMeter, codexCliUsage } from '../../src/lib/protocol/codex-cli-usage.mjs'
import { disjointOpenaiUsage, openaiChatUsageFromExtract, extractOpenaiUsage } from '../../src/lib/protocol/openai-usage.mjs'

const sample = { inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 200, reasoningOutputTokens: 150, totalTokens: 1200 }

test('official CLI usage preserves inclusive input and reasoning inside output', () => {
  const usage = codexCliUsage(sample)
  assert.equal(usage.input_tokens, 1000)
  assert.equal(usage.output_tokens, 200)
  assert.equal(usage.total_tokens, 1200)
  assert.deepEqual(usage.input_tokens_details, { cached_tokens: 600, cache_write_tokens: 100 })
  assert.equal(usage.output_tokens_details.reasoning_tokens, 150)
  const disjoint = disjointOpenaiUsage(usage)
  assert.equal(disjoint.input_tokens, 300)
  assert.equal(disjoint.cache_read_input_tokens, 600)
  assert.equal(disjoint.cache_creation_input_tokens, 100)
  assert.equal(disjoint.output_tokens, 200)
  assert.deepEqual(disjointOpenaiUsage(disjoint), disjoint)
  const chat = openaiChatUsageFromExtract(extractOpenaiUsage(usage))
  assert.equal(chat.prompt_tokens, 1000)
  assert.equal(chat.completion_tokens, 200)
  assert.equal(chat.total_tokens, 1200)
})

test('duplicate total snapshots are not summed and last-call usage does not replace turn totals', () => {
  const meter = new CodexCliUsageMeter()
  const snapshot = { total: sample, last: { ...sample, inputTokens: 900 } }
  meter.observe(snapshot)
  assert.deepEqual(meter.observe(snapshot), codexCliUsage(sample))
  const next = Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, v * 2]))
  assert.equal(meter.observe({ total: next, last: sample }).input_tokens, 2000)
  assert.equal(meter.value().total_tokens, 2400)
})

test('subtracts the captured pre-turn baseline so previous turns are not billed again', () => {
  const meter = new CodexCliUsageMeter(sample)
  const next = Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, v * 2]))
  assert.deepEqual(meter.observe({ total: next }), codexCliUsage(sample))
  assert.throws(() => meter.observe({ total: sample }), { code: 'codex_cli_usage_regressed' })
})

test('missing usage stays unknown and impossible counters are rejected', () => {
  assert.equal(codexCliUsage(null), null)
  assert.equal(new CodexCliUsageMeter().observe({ last: sample }), null)
  assert.throws(() => codexCliUsage({ ...sample, cachedInputTokens: 1001 }), { code: 'codex_cli_invalid_usage' })
  assert.throws(() => codexCliUsage({ ...sample, reasoningOutputTokens: 201 }), { code: 'codex_cli_invalid_usage' })
  assert.throws(() => codexCliUsage({ ...sample, inputTokens: -1 }), { code: 'codex_cli_invalid_usage' })
})
