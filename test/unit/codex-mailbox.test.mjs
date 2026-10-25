import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMailboxStore, mailboxError, normalizeMicrosoftEmail } from '../../src/lib/oauth/codex-mailbox-store.mjs'
import { createCodexMailboxService } from '../../src/lib/oauth/codex-mailbox-service.mjs'
import { recordMailboxAuthFailure } from '../../src/lib/oauth/codex-mailbox-events.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

process.env.VM2API_DB_SECRET = 'mailbox-unit-test-only-key'
const email = 'test@outlook.com', password = 'test-only-password'
const jwt = (e = email) => `x.${Buffer.from(JSON.stringify({ email: e })).toString('base64url')}.x`
const tokens = (e = email) => ({ access_token: jwt(e), refresh_token: 'test-refresh', id_token: jwt(e) })
function harness(t, opts = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-test-'))
  const store = createMailboxStore(projectRoot)
  const vm = { id: 'vm-01', platform: 'openai', status: 'running', schedulable: true,
    proxy: { id: 'px-test', host: '127.0.0.1', port: 1080 } }
  const calls = []
  let clock = Date.now()
  const account = { access_token: jwt(), refresh_token: 'test-refresh', expires_at: clock - 1 }
  store.save(vm.id, { email, password })
  const service = createCodexMailboxService({ projectRoot, store, getSlot: () => vm, accountFor: () => account,
    now: () => clock, checkNetwork: async () => calls.push('network'),
    runSlot: async ({ action }) => { calls.push(action); return { callback: 'http://localhost:1455/auth/callback?code=mock&state=test-state' } },
    generate: () => ({ session_id: 'test', auth_url: 'https://auth.openai.com/oauth/authorize?state=test-state' }),
    exchange: async () => { calls.push('exchange');return tokens() },
    commit: async () => { calls.push('commit') }, refresh: async () => { calls.push('refresh');return { ok: true } },
    ...opts,
  })
  t.after(async () => { service.stop();await service.settle();fs.rmSync(projectRoot, { recursive: true, force: true }) })
  return { projectRoot, store, service, vm, calls, account, advance: (ms) => { clock += ms } }
}

test('mailbox password and email encrypted at rest; summary never returns secret', (t) => {
  const h = harness(t)
  const disk = fs.readFileSync(path.join(h.projectRoot, 'data/codex-mailbox/vm-01.login.json'), 'utf8')
  assert.ok(!disk.includes(password));assert.ok(!disk.includes(email));assert.match(disk, /enc:v1:/)
  assert.equal(h.store.read('vm-01').password, password)
  assert.ok(!JSON.stringify(h.service.status('vm-01')).includes(password))
  assert.equal(h.store.summary('vm-01').has_password, true)
  assert.deepEqual(h.store.ids(), ['vm-01'])
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.projectRoot, 'data/codex-mailbox/vm-01.login.json')).mode & 0o777, 0o600)
})
test('password may be retained only for same email; traversal and invalid domains rejected', (t) => {
  const h = harness(t)
  h.store.save('vm-01', { email: email.toUpperCase(), password: '' })
  assert.equal(h.store.read('vm-01').password, password)
  assert.throws(() => h.store.save('vm-01', { email: 'other@outlook.com' }), /mailbox_password_required/)
  assert.throws(() => h.store.read('../escape'), /invalid_vm_id/)
  assert.throws(() => normalizeMicrosoftEmail('test@example.com'), /microsoft_email_required/)
})
test('saving requires encryption; wrong encryption key cannot read credentials', (t) => {
  const h = harness(t), old = process.env.VM2API_DB_SECRET
  try {
    delete process.env.VM2API_DB_SECRET
    assert.throws(() => h.store.save('vm-01', { email, password }), /mailbox_encryption_required/)
    process.env.VM2API_DB_SECRET = 'wrong-key'
    assert.throws(() => h.store.read('vm-01'), /mailbox_decryption_failed/)
  } finally { process.env.VM2API_DB_SECRET = old }
})
test('disabled slot performs no refresh, browser preparation or login', async (t) => {
  const h = harness(t);h.vm.schedulable = false
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  assert.throws(() => h.service.start('vm-01'), /slot_resting/)
  assert.deepEqual(h.calls, [])
})
test('auto-off, stopped and fresh accounts stay idle', async (t) => {
  const h = harness(t)
  h.store.save('vm-01', { email, password, auto_reauthorize: false })
  await h.service.tick();assert.deepEqual(h.calls, [])
  h.store.save('vm-01', { email, password });h.account.expires_at = Date.now() + 3600_000
  await h.service.tick();assert.deepEqual(h.calls, [])
  h.service.stop();h.account.expires_at = 1
  await h.service.tick();assert.deepEqual(h.calls, [])
})
test('normal token refresh precedes browser login', async (t) => {
  const h = harness(t);await h.service.tick();assert.deepEqual(h.calls, ['refresh'])
})
test('transient refresh error does not launch browser', async (t) => {
  const h = harness(t, { refresh: async () => ({ ok: false, refresh_class: 'retryable' }) })
  await h.service.tick();await h.service.settle();assert.deepEqual(h.calls, [])
})
test('fatal refresh falls back to slot browser and commits same email', async (t) => {
  const h = harness(t, { refresh: async () => ({ ok: false, refresh_class: 'fatal' }) })
  await h.service.tick();await h.service.settle()
  assert.deepEqual(h.calls, ['network', 'prepare', 'network', 'login', 'exchange', 'commit'])
  assert.equal(h.service.status('vm-01').state.status, 'succeeded')
  assert.ok(!JSON.stringify(h.service.status('vm-01')).includes(password))
})
test('401 signals force refreshing otherwise fresh credentials', async (t) => {
  let force
  const h = harness(t, { refresh: async (_id, f) => { force = f;return { ok: true } } })
  h.account.expires_at = Date.now() + 3600_000
  recordMailboxAuthFailure(h.projectRoot, 'vm-01')
  await h.service.tick();assert.equal(force, true)
})
test('mismatched email and OAuth state cannot replace credentials', async (t) => {
  for (const mismatch of ['email', 'state']) {
    const h = harness(t, mismatch === 'email' ? { exchange: async () => tokens('other@outlook.com') }
      : { runSlot: async () => ({ callback: 'http://localhost:1455/auth/callback?code=mock&state=wrong' }) })
    h.service.start('vm-01');await h.service.settle()
    assert.ok(!h.calls.includes('commit'))
    assert.equal(h.service.status('vm-01').state.error_code, mismatch === 'email' ? 'authorized_email_mismatch' : 'oauth_state_mismatch')
  }
})
test('captcha pauses retries; ordinary failures apply backoff', async (t) => {
  for (const code of ['captcha_required', 'email_code_timeout']) {
    let attempts = 0
    const h = harness(t, { runSlot: async () => { attempts++;throw mailboxError(code) } })
    h.account.refresh_error = 'invalid_grant'
    h.service.start('vm-01');await h.service.settle()
    await h.service.tick();assert.equal(attempts, 1)
    assert.equal(h.service.status('vm-01').state.status, code === 'captcha_required' ? 'needs_attention' : 'failed')
    h.advance(3600_001);await h.service.tick();await h.service.settle()
    assert.equal(attempts, code === 'captcha_required' ? 1 : 2)
  }
})
test('disable mid-login aborts slot job and prevents exchange/commit', async (t) => {
  let started
  const ready = new Promise((r) => { started = r })
  const h = harness(t, { runSlot: ({ signal }) => new Promise((_resolve, reject) => {
    started();signal.addEventListener('abort', () => reject(mailboxError('login_cancelled')), { once: true })
  }) })
  h.service.start('vm-01');await ready
  h.vm.schedulable = false;h.service.guardJobs();await h.service.settle()
  assert.equal(h.service.status('vm-01').state.status, 'cancelled')
  assert.ok(!h.calls.includes('exchange'));assert.ok(!h.calls.includes('commit'))
})
test('deleting config during a job prevents stale credentials from being committed', async (t) => {
  let finish
  const h = harness(t, { runSlot: async () => new Promise((r) => { finish = r }) })
  h.service.start('vm-01');await new Promise((r) => setImmediate(r))
  h.service.remove('vm-01');finish({ ok: true });await h.service.settle()
  assert.equal(h.store.read('vm-01'), null);assert.equal(h.store.state('vm-01'), null)
  assert.ok(!h.calls.includes('commit'))
})
test('stopping service while refresh awaits cannot start a new login', async (t) => {
  let finish
  const h = harness(t, { refresh: () => new Promise((r) => { finish = r }) })
  const pending = h.service.tick();h.service.stop();finish({ ok: false, refresh_class: 'fatal' });await pending
  assert.deepEqual(h.calls, [])
})
test('mailbox management respects existing panel roles', () => {
  const p = '/api/panel/vms/vm-01/oauth/microsoft-mailbox'
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['POST', '/start'], ['POST', '/verify'], ['POST', '/cancel'], ['DELETE', '']]) {
    assert.equal(authorizePanelRoute(method, p + suffix, 'admin').ok, true)
    assert.equal(authorizePanelRoute(method, p + suffix, 'user').ok, true)
    if (method !== 'GET') assert.equal(authorizePanelRoute(method, p + suffix, 'super').ok, false)
  }
})
