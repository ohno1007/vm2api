import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { costColumnsFromUsage } from '../../src/lib/admin/pricing.mjs'
import { runManagedCodexRequest } from '../../src/lib/protocol/codex-key-billing.mjs'

function fixture(t, input = {}, rate = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-bill-'))
  const store = new ApiKeyStore({ dataDir: dir })
  t.after(() => { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const key = store.create({ name: 'billing regression', ...input })
  const response = {}
  const args = {
    req: { apiKeyRecord: key }, res: response, apiKeyStore: store,
    groupsRepo: { rateMultiplier: () => rate },
    json: (_res, status, body) => Object.assign(response, { status, body }),
    logBag: { protocol: 'openai.responses', model: 'gpt-6-astra' },
  }
  return { store, key, args, response }
}

test('Codex completion records mapped-model cost, cache tokens and spend windows once', async (t) => {
  const { store, key, args } = fixture(t, {}, 2)
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 }
  args.run = async () => {
    assert.equal(store.inflight.get(key.id), 1)
    Object.assign(args.logBag, { usage, upstream_model: 'gpt-6.1-sol', final_state: 'verified' })
    return 'completed'
  }
  assert.equal(await runManagedCodexRequest(args), 'completed')
  const row = store.getById(key.id)
  const cost = costColumnsFromUsage(usage, 'gpt-6.1-sol').total_cost * 2
  assert.ok(cost > 0)
  assert.equal(row.quota_used, cost)
  assert.equal(row.requests, 1)
  assert.equal(row.quota_requests_used, 1)
  assert.equal(row.tokens_in, 100)
  assert.equal(row.tokens_out, 20)
  assert.equal(row.cache_read_tokens, 40)
  for (const window of ['5h', '1d', '7d']) assert.equal(row[`usage_${window}`], cost)
  assert.equal(store.inflight.has(key.id), false)
})

test('exhausting a USD quota blocks the next Codex hop', async (t) => {
  const { store, key, args, response } = fixture(t, { quota: 0.000001 })
  let hops = 0
  args.run = async () => {
    hops++
    Object.assign(args.logBag, { usage: { input_tokens: 100, output_tokens: 20 }, upstream_model: 'gpt-6.1-sol', final_state: 'verified' })
  }
  await runManagedCodexRequest(args)
  assert.equal(store.getById(key.id).status, 'quota_exhausted')
  args.req.apiKeyRecord = store.getById(key.id)
  await runManagedCodexRequest(args)
  assert.equal(hops, 1)
  assert.equal(response.status, 429)
  assert.equal(response.body.error.code, 'api_key_quota_exhausted')
})

test('upstream quota failure and exceptions release concurrency without billing', async (t) => {
  const { store, key, args } = fixture(t)
  args.run = async () => Object.assign(args.logBag, { final_state: 'upstream_error', error_code: 'upstream_429' })
  await runManagedCodexRequest(args)
  args.run = async () => { throw new Error('transport fixture') }
  await assert.rejects(runManagedCodexRequest(args), /transport fixture/)
  assert.equal(store.getById(key.id).quota_used, 0)
  assert.equal(store.getById(key.id).requests, 0)
  assert.equal(store.inflight.has(key.id), false)
})

test('a zero group rate records tokens and requests without charging', async (t) => {
  const { store, key, args } = fixture(t, {}, 0)
  args.run = async () => Object.assign(args.logBag, { usage: { input_tokens: 100, output_tokens: 20 }, final_state: 'verified' })
  await runManagedCodexRequest(args)
  assert.equal(store.getById(key.id).quota_used, 0)
  assert.equal(store.getById(key.id).requests, 1)
})

test('master requests pass through without managed-key accounting', async () => {
  let calls = 0
  await runManagedCodexRequest({ req: {}, run: async () => { calls++ } })
  assert.equal(calls, 1)
})

test('managed Codex concurrency gate rejects a second in-flight request', async (t) => {
  const { store, key, args, response } = fixture(t, { max_concurrency: 1 })
  let finish
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  const pending = new Promise((resolve) => { finish = resolve })
  args.run = async () => { entered(); await pending }
  const first = runManagedCodexRequest(args)
  await started
  let secondRan = false
  await runManagedCodexRequest({ ...args, logBag: {}, run: async () => { secondRan = true } })
  assert.equal(secondRan, false)
  assert.equal(response.status, 429)
  assert.equal(response.body.error.code, 'api_key_concurrency_limit')
  finish()
  await first
  assert.equal(store.inflight.has(key.id), false)
})

test('images endpoint charges the same image usage as request logs', async (t) => {
  const { store, key, args } = fixture(t)
  const usage = { input_tokens: 100, output_tokens: 50, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }
  args.logBag = { protocol: 'openai.images', model: 'gpt-image-2.5-flare', image_model: 'gpt-image-2.5-flare' }
  args.run = async () => Object.assign(args.logBag, { image_usage: usage, final_state: 'verified' })
  await runManagedCodexRequest(args)
  const cost = costColumnsFromUsage({}, 'gpt-image-2.5-flare', { usage, model: 'gpt-image-2.5-flare', only: true }).total_cost
  assert.ok(cost > 0)
  assert.equal(store.getById(key.id).quota_used, cost)
})
