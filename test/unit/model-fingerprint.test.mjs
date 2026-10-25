import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyFingerprint, validSamples, FINGERPRINT_SPEC, FINGERPRINT_PROBES, createModelFingerprintService,
  latestModelFingerprint } from '../../src/lib/admin/model-fingerprint.mjs'
import { upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'

const now = Date.parse('2026-10-23T12:00:00Z')
const samples = (text, n = 4) => FINGERPRINT_PROBES.map((_, i) => Array.from({ length: n }, () => `${text} ${i}`))
const base = (model, text) => ({ id: model, model, trusted: true, spec: FINGERPRINT_SPEC,
  createdAt: new Date(now).toISOString(), source: 'official-chatgpt-direct-tls', samples: samples(text) })
const a = base('gpt-a', '海边灯塔 甲乙丙 丁戊己')
const b = base('gpt-b', 'Quartz violet zigzag western cupcake')

test('behavioral matching identifies a separated calibrated candidate and flags disagreement', () => {
  const same = classifyFingerprint(samples('海边灯塔 甲乙丙 丁戊己', 3), [a, b], 'gpt-a', now)
  assert.equal(same.verdict, 'consistent')
  assert.equal(same.identifiedModel, 'gpt-a')
  assert.equal(same.confidence, 'experimental')
  const mismatch = classifyFingerprint(samples('Quartz violet zigzag western cupcake', 3), [a, b], 'gpt-a', now)
  assert.equal(mismatch.verdict, 'suspected_mismatch')
  assert.equal(mismatch.identifiedModel, 'gpt-b')
})

test('unknown, untrusted, expired, incomplete and indistinguishable references cannot certify identity', () => {
  assert.equal(classifyFingerprint(samples('foreign', 3), [], 'gpt-a', now).verdict, 'unknown')
  assert.equal(classifyFingerprint(samples('foreign', 3), [a], 'gpt-a', now).reason, 'competitor_baseline_missing')
  assert.equal(classifyFingerprint(samples('foreign', 3), [{ ...a, trusted: false }, b], 'gpt-a', now).reason, 'expected_baseline_missing')
  const twin = { ...a, model: 'gpt-c', id: 'twin' }
  assert.equal(classifyFingerprint(samples('海边灯塔 甲乙丙 丁戊己', 3), [a, twin], 'gpt-a', now).reason, 'models_not_separable')
  assert.equal(classifyFingerprint(samples('foreign', 3), [a, b], 'gpt-a', now + 8 * 86400_000).reason, 'no_trusted_baseline')
  assert.equal(validSamples([['x']]), false)
  assert.throws(() => classifyFingerprint([['x']], [a, b], 'gpt-a', now), /incomplete/)
})

async function waitJob(service) {
  for (let i = 0; i < 200; i++) {
    const job = service.status().jobs[0]
    if (job.status !== 'running') return job
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('test job stalled')
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fingerprint-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms', 'vm-a'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms/vm-a.json'), JSON.stringify({ id: 'vm-a', platform: 'openai', family: 'codex', status: 'running' }))
  upsertCodexAccount(root, 'vm-a', { access_token: 'secret-at', refresh_token: 'secret-rt', chatgpt_account_id: 'account', expires_at: Date.now() + 86400_000 })
  return { paths: { project: root, data: path.join(root, 'data') }, host: '172.18.0.1', port: 8787, api_key: 'private-master' }
}
const reply = (model, text) => ({ ok: true, status: 200, text: async () => `data: ${JSON.stringify({
  type: 'response.completed', response: { model, output: [{ content: [{ type: 'output_text', text }] }] },
})}\n\n` })

test('trusted references bypass the gateway; targets use the pinned normal ingress; logs receive no credentials', async (t) => {
  const cfg = fixture(t)
  const referenceCalls = [], targetCalls = []
  const service = createModelFingerprintService({ cfg, now: () => now,
    referenceFetch: async (url, opts) => { referenceCalls.push({ url, opts });const body = JSON.parse(opts.body);return reply(body.model, body.model === 'gpt-a' ? '海边灯塔 甲乙丙 丁戊己' : 'Quartz violet zigzag western cupcake') },
    targetFetch: async (url, opts) => { targetCalls.push({ url, opts });return reply('misleading-declaration', '海边灯塔 甲乙丙 丁戊己') },
  })
  for (const model of ['gpt-a', 'gpt-b']) {
    assert.equal(service.start({ vmId: 'vm-a', model, kind: 'baseline' }).busy, false)
    assert.equal(service.start({ vmId: 'vm-a', model }).busy, true)
    assert.equal((await waitJob(service)).status, 'complete')
  }
  assert.equal(referenceCalls.length, 64)
  assert.ok(referenceCalls.every((r) => r.url === 'https://chatgpt.com/backend-api/codex/responses'))
  service.start({ vmId: 'vm-a', model: 'gpt-a' })
  assert.equal((await waitJob(service)).status, 'complete')
  assert.equal(targetCalls.length, 24)
  assert.ok(targetCalls.every((r) => r.opts.headers['x-kin-vm'] === 'vm-a' && r.url === 'http://172.18.0.1:8787/v1/responses'))
  const result = latestModelFingerprint('vm-a', 'gpt-a', cfg.paths.data, now)
  assert.equal(result.verdict, 'consistent', 'response.model is deliberately wrong and must not decide identity')
  assert.equal(result.sampleCount, 24)
  assert.equal(result.stale, false)
  assert.equal(latestModelFingerprint('vm-a', 'gpt-a', cfg.paths.data, now + 7 * 3600_000).stale, true)
  const persisted = fs.readFileSync(path.join(cfg.paths.data, 'model-fingerprints.json'), 'utf8')
  assert.ok(!persisted.includes('secret-at') && !persisted.includes('private-master'))
  service.stop()
})

test('rejected or partial calls are errors and cannot produce a behavioral match', async (t) => {
  const cfg = fixture(t)
  fs.mkdirSync(cfg.paths.data)
  fs.writeFileSync(path.join(cfg.paths.data, 'model-fingerprints.json'), JSON.stringify({ version: 1, baselines: [a, b], results: [], jobs: [] }))
  const service = createModelFingerprintService({ cfg, now: () => now, targetFetch: async () => ({ ok: false, status: 429 }) })
  service.start({ vmId: 'vm-a', model: 'gpt-a' })
  const job = await waitJob(service)
  assert.equal(job.status, 'error')
  assert.equal(job.error, 'upstream_http_429')
  assert.equal(latestModelFingerprint('vm-a', 'gpt-a', cfg.paths.data, now).verdict, 'error')
  assert.throws(() => service.start({ vmId: 'vm-a', model: 'https://bad/' }), /invalid_model/)
  service.stop()
})
