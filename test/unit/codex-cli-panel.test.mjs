import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexCliPanel } from '../../src/lib/admin/codex-cli-panel.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

test('disabled slots expose passive CLI status but never prepare, login or fetch models', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-panel-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms/vm-99.json'), JSON.stringify({ id: 'vm-99', platform: 'openai', family: 'codex', runtime: { type: 'kvm' }, schedulable: false, codex_cli: { enabled: true } }))
  try {
    for (const [method, action, expected] of [['GET', 'status', 200], ['POST', 'prepare', 409], ['POST', 'login', 409], ['GET', 'models', 409]]) {
      let status, value
      const handled = await codexCliPanel({ req: { method }, res: { setHeader() {} }, pathname: `/api/panel/vms/vm-99/codex-cli/${action}`, projectRoot: root, json: (_res, code, data) => { status = code; value = data }, readBody: async () => ({}) })
      assert.equal(handled, true)
      assert.equal(status, expected)
      if (expected === 409) assert.equal(value.error.code, 'slot_resting')
    }
    assert.deepEqual(fs.readdirSync(path.join(root, 'vms')), ['vm-99.json'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('CLI admin controls obey panel roles', () => {
  for (const [method, action] of [['GET', 'status'], ['GET', 'models'], ['PUT', 'settings'], ['POST', 'prepare'], ['POST', 'login'], ['POST', 'stop']]) {
    assert.equal(authorizePanelRoute(method, `/api/panel/vms/vm-01/codex-cli/${action}`, 'admin').ok, true)
    assert.equal(authorizePanelRoute(method, `/api/panel/vms/vm-01/codex-cli/${action}`, 'user').ok, true)
    if (method !== 'GET') assert.equal(authorizePanelRoute(method, `/api/panel/vms/vm-01/codex-cli/${action}`, 'super').ok, false)
  }
})
