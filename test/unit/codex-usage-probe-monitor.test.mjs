import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUsageProbeMonitor, isCodexUsageProbeDue } from '../../src/lib/oauth/usage-probe-monitor.mjs'

const now = Date.parse('2026-10-23T11:00:00Z')
const slot = (id, values = [20, 30], age = 0) => ({
  id, platform: 'openai', family: 'codex', status: 'running', has_token: true,
  proxy: { host: '127.0.0.1', port: 1080, url: 'socks5h://127.0.0.1:1080' },
  codex_usage: {
    snapshot: { updated_at: new Date(now - age).toISOString() },
    windows: values.map((used_percent, i) => ({
      id: i ? '7d' : '5h', used_percent, reset_at: new Date(now + (i + 1) * 3600_000).toISOString(),
    })),
  },
})

test('Codex empty, stale and elapsed windows are probed, fresh measured zero is retained', () => {
  assert.equal(isCodexUsageProbeDue(slot('empty', [null, null]), { now }).due, true)
  assert.equal(isCodexUsageProbeDue(slot('zero', [0, 0]), { now }).due, false)
  assert.equal(isCodexUsageProbeDue(slot('stale', [20, 30], 300_000), { now }).reason, 'codex_sample_stale')
  const expired = slot('elapsed', [100, 30], 60_000)
  expired.codex_usage.windows[0].reset_at = new Date(now - 1000).toISOString()
  assert.equal(isCodexUsageProbeDue(expired, { now }).reason, 'codex_window_elapsed')
  expired.codex_usage.snapshot.updated_at = new Date(now).toISOString()
  assert.equal(isCodexUsageProbeDue(expired, { now }).due, false)
})

test('monitor uses Codex slot observations even when the Claude repository is empty', async () => {
  const vms = [slot('fresh'), slot('empty', [null, null]), slot('old', [10, 20], 300_000)]
  const calls = []
  const monitor = createUsageProbeMonitor({
    config: { stale_sec: 300 }, now: () => now, listTargets: () => vms,
    accountForVm: () => null,
    probeOne: async (vm) => { calls.push(vm.id); return { ok: true, data: { source: 'openai-wham-usage' } } },
  })
  const run = await monitor.runOnce()
  assert.equal(run.due, 2)
  assert.deepEqual(calls.sort(), ['empty', 'old'])
  assert.equal(run.items.find((i) => i.vm_id === 'empty').source, 'openai-wham-usage')
})

test('quota probe failures back off and never replace the last known sample', async () => {
  let clock = now
  const vm = slot('old', [100, 50], 600_000)
  let calls = 0
  const monitor = createUsageProbeMonitor({
    now: () => clock, listTargets: () => [vm],
    probeOne: async () => { calls++; return { ok: false } },
  })
  await monitor.runOnce()
  await monitor.runOnce()
  assert.equal(calls, 1)
  assert.deepEqual(vm.codex_usage.windows.map((w) => w.used_percent), [100, 50])
  clock += 61_000
  await monitor.runOnce()
  assert.equal(calls, 2)
})

test('either missing window triggers a quota read even with a fresh capped other window', () => {
  for (const values of [[100, null], [null, 100], [0, null], [null, 0]]) {
    assert.deepEqual(isCodexUsageProbeDue(slot('partial', values), { now }), {
      due: true, reason: 'codex_window_unmeasured',
    })
  }
})

test('fresh Responses headers cannot postpone a stale official weekly quota read', () => {
  const vm = slot('capped', [100, 58])
  vm.codex_usage.snapshot.quota_probed_at = new Date(now - 300_000).toISOString()
  assert.equal(isCodexUsageProbeDue(vm, { now }).reason, 'codex_sample_stale')
  vm.codex_usage.snapshot.quota_probed_at = new Date(now).toISOString()
  assert.equal(isCodexUsageProbeDue(vm, { now }).due, false)
})

test('5h quota restriction does not exclude the slot from a weekly quota probe', async () => {
  const vm = slot('capped', [100, null])
  Object.assign(vm, {
    schedulable: false, schedule_disabled_reason: 'quota_5h_header',
    temp_unschedulable_until: now + 3600_000,
  })
  let calls = 0
  const monitor = createUsageProbeMonitor({
    now: () => now, listTargets: () => [vm],
    probeOne: async (target) => {
      calls++
      assert.equal(target.id, vm.id)
      return { ok: true, data: { source: 'openai-wham-usage' } }
    },
  })
  const result = await monitor.runOnce()
  assert.equal(calls, 1)
  assert.equal(result.items[0].reason, 'codex_window_unmeasured')
})
