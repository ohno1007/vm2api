import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { setPriceCatalogTestHooks } from '../../src/lib/admin/price-catalog.mjs'
import { codexCliUsage } from '../../src/lib/protocol/codex-cli-usage.mjs'

setPriceCatalogTestHooks({ backgroundRefresh: false, settings: { get: (_key, fallback) => fallback } })

test('Ultrafast uses published model prices while retaining exact CLI token counts', () => {
  const u = codexCliUsage({ inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 20_000, reasoningOutputTokens: 15_000 })
  const standard = calculateCost(u, 'gpt-6.1-sol')
  const fast = calculateCost({ ...u, service_tier: 'priority' }, 'gpt-6.1-sol')
  const ultra = calculateCost({ ...u, service_tier: 'ultrafast' }, 'gpt-6.1-sol')
  assert.equal(ultra.known, true)
  assert.equal(ultra.mode, 'ultrafast')
  assert.equal(ultra.service_tier, 'ultrafast')
  for (const c of [standard, fast, ultra]) {
    assert.equal(c.input_tokens, 20_000)
    assert.equal(c.cache_read_tokens, 80_000)
    assert.equal(c.output_tokens, 20_000)
  }
  assert.equal(standard.total_cost, 0.248)
  assert.equal(fast.total_cost, 0.496)
  assert.equal(ultra.total_cost, 1.488)
})

test('Ultrafast long-context and explicit 1h cache-write prices match published bands', () => {
  const c = calculateCost({ input_tokens: 300_000, output_tokens: 1_000_000, service_tier: 'ultrafast' }, 'gpt-6-astra')
  assert.equal(c.long_context, true)
  assert.equal(c.input_cost, 36)
  assert.equal(c.output_cost, 450)
  const cached = calculateCost({ input_tokens: 0, cache_creation_input_tokens: 100_000, cache_ttl: '1h', service_tier: 'ultrafast' }, 'gpt-6.1-sol')
  assert.equal(cached.cache_creation_1h_cost, 3)
})

test('models without a published Ultrafast price remain explicitly unpriced', () => {
  const c = calculateCost({ input_tokens: 1000, output_tokens: 100, service_tier: 'ultrafast' }, 'gpt-6-luna')
  assert.equal(c.known, false)
  assert.equal(c.mode, 'ultrafast')
})
