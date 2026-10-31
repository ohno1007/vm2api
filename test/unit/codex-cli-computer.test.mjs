import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureCodexCliComputer } from '../../src/lib/identity/codex-cli-computer.mjs'

test('generates a persistent ordinary KVM identity without private executables', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-computer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = { id: 'codex-test', timezone: 'America/New_York' }
  const first = ensureCodexCliComputer(root, vm)
  assert.equal(first.created, true)
  assert.match(first.hostname, /^vps-[0-9a-f]{10}$/)
  assert.match(first.guest_machine_id, /^[0-9a-f]{32}$/)
  assert.match(first.mac, /^02(:[0-9a-f]{2}){5}$/)
  const identity = JSON.parse(fs.readFileSync(path.join(first.dir, 'identity.json')))
  assert.equal(identity.timezone, 'America/New_York')
  assert.equal(identity.smbios.manufacturer, 'QEMU')
  assert.match(fs.readFileSync(path.join(first.dir, 'qemu-smbios.args'), 'utf8'), /manufacturer=QEMU/)
  assert.equal(vm.machine.mac, first.mac)
  const again = ensureCodexCliComputer(root, { ...vm, timezone: 'America/Los_Angeles' })
  assert.equal(again.created, false)
  assert.equal(again.guest_machine_id, first.guest_machine_id)
  assert.equal(again.hostname, first.hostname)
})

test('rejects path traversal and preserves existing foreign or incomplete identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-computer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => ensureCodexCliComputer(root, { id: '../other' }), /invalid_vm_id/)
  const dir = path.join(root, 'vms', 'existing', 'kvm', 'fingerprint')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'identity.json'), '{"generator":"other"}')
  assert.throws(() => ensureCodexCliComputer(root, { id: 'existing' }), /explicit_rebuild/)
  assert.equal(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'), '{"generator":"other"}')
})
