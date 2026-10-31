import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canRunCodexCli } from '../../src/lib/vm/codex-cli-config.mjs'
import { completeCodexCliLogin } from '../../src/lib/vm/codex-cli-auth.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'
import { ensureSlotInferenceRuntime } from '../../src/lib/vm/slot-runtime.mjs'
import { codexCliPanel } from '../../src/lib/admin/codex-cli-panel.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'

const empty = { id: 'vm-91', platform: 'openai', family: 'codex', runtime: { type: 'kvm' },
  codex_cli: { enabled: true }, schedulable: false, unschedulable: { reason: 'no_credential' } }

test('only explicit first-login setup can use an uncredentialed slot', () => {
  assert.equal(canRunCodexCli(empty), false)
  assert.equal(canRunCodexCli(empty, { loginSetup: true }), true)
  for (const patch of [{ schedule_off: true }, { schedule_manual: true }, { schedule_hold: { reason: 'maintenance' } }, { unschedulable: { reason: 'oauth_revoked' } }]) {
    assert.equal(canRunCodexCli({ ...empty, ...patch }, { loginSetup: true }), false)
  }
})

test('guest boot does not start CLI before explicit preparation or while resting', async () => {
  for (const vm of [empty, { ...empty, schedulable: true, unschedulable: null }]) {
    const result = await ensureSlotInferenceRuntime(vm, path.join(os.tmpdir(), 'cli-absent-payload'), {
      ops: { writeCodexKernelConfig() { assert.fail('must not configure old kernel') }, ensureCodexKernel() { assert.fail('must not start a CLI') } },
    })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
  }
})

test('successful explicit login persists credentials and clears only a missing-credential hold', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-first-login-'))
  const dir = path.join(root, 'vms/vm-91/cli-home/.codex-vm2api')
  fs.mkdirSync(dir, { recursive: true })
  const record = path.join(root, 'vms/vm-91.json')
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' } }))
  try {
    for (const patch of [{ schedule_off: true }, { schedule_hold: { reason: 'maintenance' } }, { unschedulable: { reason: 'oauth_revoked' } }]) {
      atomicWriteJson(record, { ...empty, ...patch })
      assert.equal(completeCodexCliLogin(root, empty.id), false)
      assert.equal(fs.existsSync(path.join(root, 'vms/vm-91/codex-credentials.json')), false)
    }
    atomicWriteJson(record, empty)
    assert.equal(completeCodexCliLogin(root, empty.id), true)
    assert.equal(getVm(root, empty.id).schedulable, true)
    assert.equal(fs.existsSync(path.join(root, 'vms/vm-91/codex-credentials.json')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('passive status identifies first-login readiness without preparing or starting anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-first-status-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms/vm-91.json'), JSON.stringify(empty))
  try {
    let reply
    await codexCliPanel({ req: { method: 'GET' }, res: { setHeader() {} }, pathname: '/api/panel/vms/vm-91/codex-cli/status', projectRoot: root,
      json: (_res, status, value) => { assert.equal(status, 200); reply = value } })
    assert.equal(reply.data.setupAllowed, true)
    assert.equal(reply.data.ok, false)
    assert.deepEqual(fs.readdirSync(path.join(root, 'vms')), ['vm-91.json'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
