import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeCodexCliQuota, persistCodexCliQuota, readCodexCliQuota, consumeCodexCliResetCredit } from '../../src/lib/protocol/codex-cli-quota.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { syncCodexCliAuth } from '../../src/lib/vm/codex-cli-auth.mjs'
import { readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'

const snapshot = { rateLimits: { primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1800600000 }, credits: { hasCredits: true, unlimited: false, balance: '12.3456789' }, planType: 'pro' },
  rateLimitResetCredits: { availableCount: 4, credits: [{ id: 'fixture', status: 'available', resetType: 'codexRateLimits', expiresAt: 1800700000 }, { id: 'perpetual', status: 'available', resetType: 'codexRateLimits', expiresAt: null }] } }

test('CLI quota retains both reset clocks, credit count, capped detail rows and paid balance', () => {
  const result = normalizeCodexCliQuota(snapshot)
  assert.equal(result.public.quota.utilization_5h, 0.32)
  assert.equal(result.public.quota.utilization_7d, 0.63)
  assert.equal(result.public.quota.reset_5h, new Date(1800000000 * 1000).toISOString())
  assert.equal(result.public.quota.reset_7d, new Date(1800600000 * 1000).toISOString())
  assert.equal(result.resetCredits.available_count, 4)
  assert.equal(result.resetCredits.credits[0].expires_at, new Date(1800700000 * 1000).toISOString())
  assert.equal(result.resetCredits.credits[1].expires_at, null)
  assert.equal(result.credits.balance, '12.3456789')
  assert.equal(normalizeCodexCliQuota({ rateLimits: {} }).resetCredits, null)
})

test('query asks for details and never invokes consumption', async () => {
  const calls = []
  const rpc = { async request(method, params) { calls.push({ method, params }); return snapshot } }
  await readCodexCliQuota(rpc, value => normalizeCodexCliQuota(value).public)
  assert.deepEqual(calls, [{ method: 'account/rateLimits/read', params: { excludeResetCreditDetails: false } }])
})

test('redemption uses one idempotency key and reads back; non-success outcomes stay explicit', async () => {
  for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
    const calls = []
    const rpc = { async request(method, params) { calls.push({ method, params }); return method.endsWith('/consume') ? { outcome } : snapshot } }
    const result = await consumeCodexCliResetCredit(rpc, value => normalizeCodexCliQuota(value).public)
    assert.match(calls[0].params.idempotencyKey, /^[a-f0-9-]{36}$/)
    assert.equal(calls.filter(c => c.method.endsWith('/consume')).length, 1)
    assert.equal(result.ok, ['reset', 'alreadyRedeemed'].includes(outcome))
    assert.equal(calls.length, result.ok ? 2 : 1)
  }
})

test('successful redemption with failed readback stays successful; ambiguous failures never retry', async () => {
  let calls = 0
  const result = await consumeCodexCliResetCredit({ async request() { if (++calls === 1) return { outcome: 'reset' }; throw new Error('offline') } }, () => {})
  assert.equal(result.warning, 'reset_credit_cache_refresh_failed')
  assert.equal(result.ok, true)
  calls = 0
  await assert.rejects(consumeCodexCliResetCredit({ async request() { calls++; throw new Error('timeout') } }, () => {}))
  assert.equal(calls, 1)
})

test('quota persistence retains window and credit data; disabled slots reject updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-quota-'))
  const file = path.join(root, 'vms/vm-01.json')
  const vm = { id: 'vm-01', platform: 'openai', family: 'codex', schedulable: true, codex_cli: { enabled: true } }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    atomicWriteJson(file, vm)
    persistCodexCliQuota(root, vm.id, snapshot)
    const stored = JSON.parse(fs.readFileSync(file))
    assert.equal(stored.codex.reset_credits.available_count, 4)
    assert.equal(stored.codex.plan_type, 'pro')
    assert.equal(stored.codex.credits.balance, '12.3456789')
    atomicWriteJson(file, { ...vm, schedulable: false })
    assert.throws(() => persistCodexCliQuota(root, vm.id, snapshot), /slot_resting/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('CLI token mirroring updates subscription claims and retains them when refresh omits metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-subscription-'))
  const file = path.join(root, 'vms/vm-01/cli-home/.codex-vm2api/auth.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const jwt = expiry => ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_subscription_active_until: expiry } })).toString('base64url'), 'fixture'].join('.')
  try {
    writeCodexAccounts(root, 'vm-01', [{ access_token: 'access', refresh_token: 'refresh', id_token: jwt('2026-11-20T00:00:00Z'), chatgpt_account_id: 'fixture-account' }])
    atomicWriteJson(file, { tokens: { access_token: 'access', refresh_token: 'refresh', id_token: jwt('2026-12-20T00:00:00Z'), account_id: 'fixture-account' } })
    assert.equal(syncCodexCliAuth(root, 'vm-01'), true)
    assert.equal(readCodexAccounts(root, 'vm-01')[0].chatgpt_subscription_active_until, '2026-12-20T00:00:00Z')
    atomicWriteJson(file, { tokens: { access_token: 'next-access', refresh_token: 'next-refresh', account_id: 'fixture-account' } })
    syncCodexCliAuth(root, 'vm-01')
    assert.ok(readCodexAccounts(root, 'vm-01')[0].id_token)
    assert.equal(readCodexAccounts(root, 'vm-01')[0].chatgpt_subscription_active_until, '2026-12-20T00:00:00Z')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
