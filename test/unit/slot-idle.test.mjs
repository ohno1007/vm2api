import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUsageProbeMonitor, isUsageProbeTarget } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { createCredentialRefreshMonitor, isCredentialRefreshTarget } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { ensureCodexCredential } from '../../src/lib/oauth/codex-credential-refresh.mjs'
import { queryOpenaiQuota, resetOpenaiQuota } from '../../src/lib/oauth/openai-quota.mjs'
import { runVmTestChat, syncCodexCatalog } from '../../src/lib/admin/vm-test-chat.mjs'
import { createModelFingerprintService } from '../../src/lib/admin/model-fingerprint.mjs'
import { createKernelWatchdog, isKernelWatchdogTarget } from '../../src/lib/transport/kernel-watchdog.mjs'
import { isCliNodeGuardTarget } from '../../src/lib/vm/cli-node-guard.mjs'
import { reviveDownSlots } from '../../src/lib/vm/slot-recovery.mjs'
import { VmTestScheduleRunner } from '../../src/lib/admin/vm-test-schedule.mjs'

const live = { id: 'vm-01', platform: 'openai', family: 'codex', status: 'running', schedulable: true,
  has_token: true, has_refresh: true, expires_at: 1, proxy: { host: '127.0.0.1', port: 1080 } }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-idle-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', 'vm-01.json')
  fs.writeFileSync(file, JSON.stringify({ ...live, schedulable: false }))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, file }
}

test('disabled slots are ineligible for automatic account and guest maintenance', () => {
  const off = { ...live, schedulable: false }
  assert.equal(isUsageProbeTarget(off), false)
  assert.equal(isCredentialRefreshTarget(off), false)
  assert.equal(isKernelWatchdogTarget(off, { inference: { engine: 'rust' } }), false)
  assert.equal(isCliNodeGuardTarget({ ...off, platform: 'anthropic', family: 'claude' }), false)
  assert.equal(isUsageProbeTarget(live), true)
  assert.equal(isCredentialRefreshTarget(live), true)
})

test('usage timer, event probes and reconciliation remain idle until re-enabled', async () => {
  let enabled = false, probes = 0, reconciles = 0
  const monitor = createUsageProbeMonitor({
    listTargets: () => [{ ...live, schedulable: enabled }],
    reconcile: () => reconciles++, probeOne: async () => { probes++; return { ok: true } },
  })
  assert.equal((await monitor.runOnce()).due, 0)
  assert.equal((await monitor.probeNow(live.id)).reason, 'not_target')
  assert.equal(probes + reconciles, 0)
  enabled = true
  await monitor.runOnce()
  assert.equal(probes, 1)
  assert.equal(reconciles, 1)
})

test('usage queue rechecks scheduling after acquiring a worker', async () => {
  let slots = [live, { ...live, id: 'vm-02' }], release, started
  const running = new Promise((resolve) => { started = resolve })
  const parked = new Promise((resolve) => { release = resolve })
  const seen = []
  const monitor = createUsageProbeMonitor({ config: { concurrency: 1 }, listTargets: () => slots,
    probeOne: async (vm) => { seen.push(vm.id); started(); await parked; return { ok: true } } })
  const pending = monitor.runOnce()
  await running
  slots = slots.map((vm) => vm.id === 'vm-02' ? { ...vm, schedulable: false } : vm)
  release()
  const result = await pending
  assert.deepEqual(seen, ['vm-01'])
  assert.equal(result.items.find((vm) => vm.vm_id === 'vm-02').reason, 'not_target')
})

test('credential queue skips a slot disabled while another refresh runs', async () => {
  let slots = [live, { ...live, id: 'vm-02' }], release, started
  const running = new Promise((resolve) => { started = resolve })
  const parked = new Promise((resolve) => { release = resolve })
  const seen = []
  const monitor = createCredentialRefreshMonitor({ config: { concurrency: 1 }, listTargets: () => slots,
    refreshOne: async (vm) => { seen.push(vm.id); started(); await parked; return { ok: true } } })
  const pending = monitor.runOnce()
  await running
  slots = slots.map((vm) => vm.id === 'vm-02' ? { ...vm, schedulable: false } : vm)
  release()
  await pending
  assert.deepEqual(seen, ['vm-01'])
})

test('disabled quota reads, resets, forced refreshes and test chats stop before network access', async (t) => {
  const { root } = fixture(t)
  const failNetwork = () => assert.fail('resting slot contacted upstream')
  for (const fn of [queryOpenaiQuota, resetOpenaiQuota]) {
    assert.equal((await fn({ projectRoot: root, vmId: live.id, fetchImpl: failNetwork })).error, 'slot_resting')
  }
  const refresh = await ensureCodexCredential(root, live.id, { force: true, refresh: failNetwork })
  assert.equal(refresh.error.code, 'slot_resting')
  const chat = await runVmTestChat({ projectRoot: root, vmId: live.id, apiKey: 'fixture', fetchImpl: failNetwork })
  assert.equal(chat.error.code, 'slot_resting')
  assert.equal(chat.status, 409)
  const catalog = await syncCodexCatalog({ projectRoot: root, vmId: live.id, fetchImpl: failNetwork })
  assert.equal(catalog.error, 'no_codex_slot')
})

test('disabled slots reject fingerprint jobs before starting', (t) => {
  const { root } = fixture(t)
  const service = createModelFingerprintService({ cfg: { paths: { project: root, data: path.join(root, 'data') } },
    targetFetch: () => assert.fail('fingerprint network request') })
  t.after(() => service.stop())
  assert.throws(() => service.start({ vmId: live.id, model: 'gpt-6.1-sol', kind: 'baseline' }), /slot_resting/)
})

test('disabled watchdog slots do not heal bridges, telemetry, kernels or revive guests', async () => {
  const seen = []
  const watchdog = createKernelWatchdog({ listTargets: () => [{ ...live, schedulable: false }],
    healBridges: (vms) => seen.push(...vms.map((v) => v.id)),
    ensureTelemetry: () => assert.fail('telemetry'), health: () => assert.fail('kernel probe'),
    revive: () => assert.fail('revive') })
  await watchdog.tick()
  assert.deepEqual(seen, [])
  assert.deepEqual(await reviveDownSlots({ vms: [{ ...live, schedulable: false }],
    inspect: () => assert.fail('guest inspect'), powerOn: () => assert.fail('guest boot') }), [])
})

test('scheduled chat preserves its plan while disabled and resumes after enable', async () => {
  let enabled = false, calls = 0
  const values = new Map()
  const settings = { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) }
  const runner = new VmTestScheduleRunner({ projectRoot: '/missing-project', settings: () => settings,
    list: () => [{ ...live, schedulable: enabled }], runTest: async () => { calls++; return { ok: true } } })
  runner.save(live.id, { enabled: true, frequency: 'hourly', minute: 0, timezone: 'UTC',
    model: 'gpt-6.1-sol', prompt: 'hello', max_tokens: null, reasoning_effort: 'medium' })
  runner.started = true
  await runner._run(live.id)
  assert.equal(calls, 0)
  enabled = true
  await runner._run(live.id)
  assert.equal(calls, 1)
  runner.stop()
})
