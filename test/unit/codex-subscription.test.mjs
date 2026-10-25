import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMailboxStore } from '../../src/lib/oauth/codex-mailbox-store.mjs'
import { createCodexMailboxService } from '../../src/lib/oauth/codex-mailbox-service.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

process.env.VM2API_DB_SECRET = 'subscription-fixture-only'
const email = 'fixture@outlook.com'
const session = { accessToken: 'fixture-session-only', user: { email } }
const period_end = '2030-12-01T00:00:00+00:00'
function harness(t, opts = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-'))
  const store = createMailboxStore(projectRoot)
  const vm = { id: 'vm-01', platform: 'openai', schedulable: true, status: 'running', proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 } }
  const calls = []
  store.save(vm.id, { email, password: 'mailbox-fixture', auto_reauthorize: false })
  const service = createCodexMailboxService({ projectRoot, store, getSlot: () => vm,
    checkNetwork: async () => calls.push('network'),
    runSlot: async ({ action, payload }) => {
      calls.push({ action, payload })
      if (action === 'prepare') return { ok: true }
      return action === 'session' ? session : { enabled: payload.enabled ?? true, period_end }
    }, ...opts })
  t.after(async () => { service.stop(); await service.settle(); fs.rmSync(projectRoot, { force: true, recursive: true }) })
  return { store, service, vm, calls, projectRoot }
}

test('one-click session export uses the selected slot profile without login or OAuth and does not persist session', async t => {
  const h = harness(t)
  assert.deepEqual(await h.service.session('vm-01'), session)
  assert.deepEqual(h.calls.filter(x => typeof x !== 'string').map(x => x.action), ['prepare', 'session'])
  assert.equal(h.calls.at(-1).payload.email, email)
  assert.equal(h.calls.at(-1).payload.password, undefined)
  assert.equal(h.service.status('vm-01').browser.active, false)
  assert.ok(!JSON.stringify(h.service.status('vm-01')).includes(session.accessToken))
  for (const name of fs.readdirSync(path.join(h.projectRoot, 'data/codex-mailbox'))) {
    assert.ok(!fs.readFileSync(path.join(h.projectRoot, 'data/codex-mailbox', name), 'utf8').includes(session.accessToken))
  }
})

test('subscription read and on/off only persist verified provider results; never start login', async t => {
  const h = harness(t)
  assert.equal(h.service.status('vm-01').subscription, null)
  assert.equal((await h.service.subscription('vm-01')).enabled, true)
  assert.equal((await h.service.subscription('vm-01', { enabled: false })).enabled, false)
  assert.equal(h.service.status('vm-01').subscription.enabled, false)
  assert.ok(!fs.readFileSync(path.join(h.projectRoot, 'data/codex-mailbox/vm-01.subscription.json'), 'utf8').includes(email))
  assert.equal((await h.service.subscription('vm-01', { enabled: true })).enabled, true)
  assert.ok(h.calls.filter(x => typeof x !== 'string').every(x => ['prepare', 'subscription'].includes(x.action)))
  assert.equal(h.store.read('vm-01').auto_reauthorize, false)
  assert.throws(() => h.service.subscription('vm-01', { enabled: 'true' }), /invalid_subscription_setting/)
  h.store.save('vm-01', { email: 'other@outlook.com', password: 'other-fixture' })
  assert.equal(h.service.status('vm-01').subscription, null)
})

test('unconfirmed or expired subscription results cannot be recorded as successful', async t => {
  for (const result of [{ enabled: false, period_end }, { enabled: true }, { enabled: true, period_end: '2000-01-01' }]) {
    const h = harness(t, { runSlot: async () => result })
    await assert.rejects(h.service.subscription('vm-01', { enabled: true }), /subscription_verification_failed/)
    assert.equal(h.service.status('vm-01').subscription, null)
    assert.equal(h.service.status('vm-01').browser.active, false)
  }
})

test('resting slots reject session export and subscription reads/changes without any slot work', async t => {
  const h = harness(t); h.vm.schedulable = false
  await assert.rejects(h.service.session('vm-01'), /slot_resting/)
  await assert.rejects(h.service.subscription('vm-01'), /slot_resting/)
  await assert.rejects(h.service.subscription('vm-01', { enabled: false }), /slot_resting/)
  assert.deepEqual(h.calls, [])
})

test('slot disable aborts a subscription job and prevents storing a stale result', async t => {
  let release, ready
  const begun = new Promise(resolve => { ready = resolve })
  const h = harness(t, { runSlot: async ({ action }) => {
    if (action === 'prepare') return { ok: true }
    ready(); return new Promise(resolve => { release = resolve })
  } })
  const task = h.service.subscription('vm-01', { enabled: true })
  await begun
  h.vm.schedulable = false; h.service.guardJobs(); release({ enabled: true, period_end })
  await assert.rejects(task, /login_cancelled|slot_resting/)
  assert.equal(h.service.status('vm-01').subscription, null)
})

test('session identity mismatch is rejected and subscription endpoints obey panel roles', async t => {
  const h = harness(t, { runSlot: async () => ({ accessToken: 'fixture', user: { email: 'other@example.com' } }) })
  await assert.rejects(h.service.session('vm-01'), /authorized_email_mismatch/)
  for (const action of ['session', 'subscription']) {
    const endpoint = `/api/panel/vms/vm-01/oauth/login/${action}`
    assert.equal(authorizePanelRoute('POST', endpoint, 'user').ok, true)
    assert.equal(authorizePanelRoute('POST', endpoint, 'admin').ok, true)
    assert.equal(authorizePanelRoute('POST', endpoint, 'super').ok, false)
  }
})
