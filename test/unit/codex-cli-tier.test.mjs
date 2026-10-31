import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCodexCliTier, selectCodexCliTier } from '../../src/lib/protocol/codex-cli-tier.mjs'

const model = { id: 'gpt-6.1-sol', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }
test('standard aliases do not inherit a paid catalog default', () => {
  for (const value of [undefined, 'auto', 'default', 'standard']) {
    assert.deepEqual(selectCodexCliTier({ ...model, defaultServiceTier: 'ultrafast' }, value), { tier: 'standard', serviceTier: 'default' })
  }
})
test('Fast and Ultrafast use the model catalog ids', () => {
  assert.deepEqual(selectCodexCliTier(model, 'fast'), { tier: 'fast', serviceTier: 'priority' })
  assert.deepEqual(selectCodexCliTier(model, 'priority'), { tier: 'fast', serviceTier: 'priority' })
  assert.deepEqual(selectCodexCliTier(model, 'ultrafast'), { tier: 'ultrafast', serviceTier: 'ultrafast' })
  assert.equal(normalizeCodexCliTier(' FAST '), 'fast')
})
test('unavailable or disabled modes fail explicitly instead of downgrading', () => {
  assert.throws(() => selectCodexCliTier({ serviceTiers: [{ id: 'fast' }] }, 'ultrafast'), { code: 'service_tier_unavailable' })
  assert.throws(() => selectCodexCliTier(model, 'fast', { featureRequirements: { fast_mode: false } }), { code: 'service_tier_disabled' })
  assert.throws(() => normalizeCodexCliTier('imaginary'), { code: 'unsupported_service_tier' })
})
