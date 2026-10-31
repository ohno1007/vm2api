import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runFleetUpdate, fleetStatus, isWorkerProcessUp, applyNativeTelemetry } from '../../src/lib/vm/fleet-update.mjs'

function writeSlot(root, id, extra = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id.replace('vm-', ''),
      status: 'running',
      runtime: { type: 'docker', worker: 'go' },
      fingerprint: { device_id: id, session_id: 's' },
      ...extra,
    }),
  )
}

test('fleet roll reloads then collects every target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-'))
  writeSlot(root, 'vm-01')
  writeSlot(root, 'vm-02')
  writeSlot(root, 'vm-03', { runtime: { type: 'kvm' } })
  const reloads = []
  const collects = []
  const report = await runFleetUpdate(root, {
    action: 'roll',
    concurrency: 2,
    reloadFn: (vm) => {
      reloads.push(vm.id)
      return { ok: true, action: 'reloaded' }
    },
    collectFn: async (_root, vm) => {
      collects.push(vm.id)
      return { ok: true, id: vm.id }
    },
    healthFn: async () => ({ ok: true, status: 'ready' }),
    readyTimeoutMs: 50,
  })
  assert.equal(report.total, 3)
  assert.equal(report.ok_count, 3)
  assert.equal(report.failed_count, 0)
  assert.deepEqual(reloads.sort(), ['vm-01', 'vm-02', 'vm-03'])
  assert.deepEqual(collects.sort(), ['vm-01', 'vm-02', 'vm-03'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('fleet reload awaits engine-aware runtime and passes routing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-rust-'))
  writeSlot(root, 'vm-13', { inference_engine: 'rust' })
  const routing = { inference: { engine: 'rust' } }
  const events = []
  const report = await runFleetUpdate(root, {
    action: 'roll',
    routing,
    reloadFn: async (vm, projectRoot, opts) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(['reload', vm.id, projectRoot, opts.routing])
      return { ok: true, action: 'reloaded', rust_ok: true }
    },
    collectFn: async () => {
      events.push(['collect'])
      return { ok: true, id: 'vm-13' }
    },
    healthFn: async () => ({ ok: true, status: 'ready' }),
    readyTimeoutMs: 50,
  })
  assert.equal(report.ok_count, 1)
  assert.deepEqual(events[0], ['reload', 'vm-13', root, routing])
  assert.deepEqual(events[1], ['collect'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('degraded worker without OAuth still counts as up', () => {
  assert.equal(isWorkerProcessUp({ ok: false, status: 'degraded', vm_id: 'vm-02' }), true)
  assert.equal(isWorkerProcessUp({ code: 'worker_unavailable' }), false)
})

test('fleet collect skips reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-c-'))
  writeSlot(root, 'vm-01')
  let reloads = 0
  const report = await runFleetUpdate(root, {
    action: 'collect',
    reloadFn: () => {
      reloads += 1
      return { ok: true }
    },
    collectFn: async () => ({ ok: true, id: 'vm-01' }),
    healthFn: async () => ({ ok: true }),
  })
  assert.equal(reloads, 0)
  assert.equal(report.ok_count, 1)
  assert.equal(fleetStatus(root)[0].id, 'vm-01')
  fs.rmSync(root, { recursive: true, force: true })
})

test('fleet collection bounds concurrency and visits every slot', { timeout: 2000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-concurrency-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const id of ['vm-01', 'vm-02', 'vm-03', 'vm-04']) writeSlot(root, id)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let notifyStarted
  const started = new Promise((resolve) => {
    notifyStarted = resolve
  })
  const collected = []
  let active = 0
  let peak = 0
  const pending = runFleetUpdate(root, {
    action: 'collect',
    concurrency: 2,
    collectFn: async (_root, vm) => {
      collected.push(vm.id)
      active += 1
      peak = Math.max(peak, active)
      if (collected.length === 2) notifyStarted()
      await gate
      active -= 1
      return { ok: true, id: vm.id }
    },
  })
  try {
    await started
    assert.equal(active, 2)
    assert.equal(collected.length, 2, 'queued slots must wait for a free worker')
  } finally {
    release()
  }
  const report = await pending
  assert.equal(peak, 2)
  assert.equal(active, 0)
  assert.deepEqual(collected.sort(), ['vm-01', 'vm-02', 'vm-03', 'vm-04'])
  assert.equal(report.total, 4)
  assert.equal(report.ok_count, 4)
  assert.equal(report.failed_count, 0)
})

test('native telemetry publication uses the current stored VM kind and reports unsupported without writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-fleet-current-kind-'))
  try {
    writeSlot(root, 'vm-01', { family: 'codex', seed_policy: { telemetry_disabled: true } })
    const file = path.join(root, 'vms', 'vm-01.json')
    const before = fs.readFileSync(file, 'utf8')
    const result = await applyNativeTelemetry({
      projectRoot: root,
      vm: { id: 'vm-01', family: 'claude', seed_policy: { telemetry_disabled: false } },
    })
    assert.equal(result.ok, false)
    assert.equal(result.supported, false)
    assert.equal(result.state, 'unsupported')
    assert.equal(result.code, 'telemetry_unsupported')
    assert.equal(result.wrote, false)
    assert.equal(result.published, false)
    assert.equal(result.applied, false)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01', 'cli-home')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
