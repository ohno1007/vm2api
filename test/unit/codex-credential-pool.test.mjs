import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMailboxStore, normalizeTotpSecret, parseLoginBatch } from '../../src/lib/oauth/codex-mailbox-store.mjs'
import { createCodexMailboxService } from '../../src/lib/oauth/codex-mailbox-service.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { Readable } from 'node:stream'

process.env.VM2API_DB_SECRET = 'credential-pool-unit-test-only'
const email = 'pool@example.com', password = 'fixture-GPT-password', secret = 'JBSWY3DPEHPK3PXP'
const row = `${email}----${password}----${secret}`
const owner = { id: 'tenant-one' }, other = { id: 'tenant-two' }, admin = { id: 'admin', admin: true }
function harness(t, extra = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-pool-'))
  const store = createMailboxStore(projectRoot), calls = []
  const slots = ['vm-01', 'vm-02'].map(id => ({ id, platform: 'openai', schedulable: true, status: 'running', proxy: { id: 'px-fixture', host: '127.0.0.1', port: 1080 } }))
  const token = `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`
  const service = createCodexMailboxService({ projectRoot, store, getSlot: id => slots.find(vm => vm.id === id), accountFor: () => ({}),
    checkNetwork: async vm => calls.push(['network', vm.id]), refresh: async () => { calls.push(['refresh']); return { ok: false, refresh_class: 'fatal' } },
    runSlot: async ({ vm, action, payload }) => { calls.push([action, vm.id, payload]); return { callback: 'http://localhost:1455/auth/callback?state=fixture&code=fixture' } },
    generate: () => ({ session_id: 'fixture', auth_url: 'https://auth.openai.com/start?state=fixture' }),
    exchange: async () => ({ access_token: token, refresh_token: 'fixture-refresh' }), commit: async id => calls.push(['commit', id]), ...extra })
  t.after(async () => { service.stop(); await service.settle(); fs.rmSync(projectRoot, { recursive: true, force: true }) })
  return { projectRoot, store, service, slots, calls }
}

test('batch parsing validates all rows, normalizes secrets and rejects duplicate or OTP input', () => {
  assert.equal(parseLoginBatch(row)[0].totp_secret, secret)
  assert.equal(parseLoginBatch(`${email},${password},otpauth://totp/Fixture?secret=${secret}`)[0].email, email)
  assert.throws(() => parseLoginBatch(`${row}\n${row.toUpperCase()}`), /duplicate_login_email/)
  assert.throws(() => parseLoginBatch(`${email}----password----123456`), /invalid_totp_secret/)
  assert.throws(() => parseLoginBatch(Array(101).fill(row).join('\n')), /batch_limit/)
  assert.throws(() => parseLoginBatch(`${email}----password----${secret}----extra`), /batch_requires/)
})

test('two-column Microsoft mailbox imports accept three/four dashes or comma without mixing password modes', () => {
  for (const separator of ['---', '----', ',']) {
    const record = parseLoginBatch(`Mailbox@Outlook.de${separator} mailbox-password `)[0]
    assert.equal(record.mode, 'microsoft_mailbox')
    assert.equal(record.email, 'mailbox@outlook.de')
    assert.equal(record.password, 'mailbox-password')
    assert.equal(record.totp_secret, undefined)
  }
  assert.equal(parseLoginBatch(`${row}\nmailbox@outlook.de---mailbox-password`).length, 2)
  assert.throws(() => parseLoginBatch('mailbox@example.com---mailbox-password'), /microsoft_email_required/)
  assert.throws(() => parseLoginBatch('mailbox@outlook.de---  '), /mailbox_password_required/)
  assert.throws(() => parseLoginBatch(`${email}----password----`), /invalid_totp_secret/)
})

test('mailbox pool credentials bind idle and only explicit login passes the mailbox mode to the selected slot', async t => {
  const h = harness(t)
  h.service.poolImport('mailbox@outlook.de---mailbox-password', owner)
  const id = h.service.poolList(owner, ['vm-01'])[0].id
  h.service.bind('vm-01', id, owner)
  assert.equal(h.store.read('vm-01').mode, 'microsoft_mailbox')
  assert.equal(h.service.status('vm-01').has_totp, false)
  await h.service.tick(); assert.deepEqual(h.calls, [])
  h.service.start('vm-01'); await h.service.settle()
  const login = h.calls.find(call => call[0] === 'login')
  assert.equal(login[1], 'vm-01')
  assert.equal(login[2].mode, 'microsoft_mailbox')
  assert.equal(login[2].password, 'mailbox-password')
  assert.equal(login[2].totp_secret, undefined)
})
test('2fa.run links are parsed locally and normalize like raw TOTP secrets', () => {
  for (const input of [
    `https://2fa.run/2fa/${secret}`,
    `  https://2fa.run/2fa/${secret.toLowerCase()}/  `,
    `https://2FA.RUN/2fa/%4ABSWY3DPEHPK3PXP`,
  ]) assert.equal(normalizeTotpSecret(input), secret)
  assert.equal(parseLoginBatch(`${email}----${password}---- https://2fa.run/2fa/${secret}`)[0].totp_secret, secret)
  assert.equal(parseLoginBatch(`${email},${password},https://2fa.run/2fa/${secret}`)[0].totp_secret, secret)
})

test('2FA link import rejects unexpected destinations, unsupported URLs and invalid secrets', () => {
  for (const input of [
    `http://2fa.run/2fa/${secret}`, `https://2fa.run.evil.example/2fa/${secret}`,
    `https://127.0.0.1/2fa/${secret}`, `https://2fa.run@evil.example/2fa/${secret}`,
    `https://user@2fa.run/2fa/${secret}`, `https://2fa.run:8443/2fa/${secret}`,
    `https://2fa.run/2fa/${secret}?secret=other`, `https://2fa.run/2fa/${secret}#fragment`,
    'https://2fa.run/2fa/', `https://2fa.run/2fa/${secret}/extra`,
    'https://2fa.run/2fa/123456', 'https://2fa.run/2fa/%ZZ',
    `https://2fa.run/2fa/${secret}%2F`, 'https://2fa.run/2fa/otpauth%3A%2F%2Ftotp%2F',
  ]) assert.throws(() => normalizeTotpSecret(input), /invalid_totp_secret/)
})

test('importing a 2FA link saves only its encrypted secret and binding stays idle', async t => {
  const h = harness(t)
  const link = `https://2fa.run/2fa/${secret}`
  h.service.poolImport(`${email}----${password}---- ${link}`, owner)
  const id = h.service.poolList(owner, ['vm-01'])[0].id
  assert.equal(h.service.poolReveal(id, owner).totp_secret, secret)
  const disk = fs.readFileSync(path.join(h.projectRoot, 'data/codex-login-pool/credentials.json'), 'utf8')
  for (const value of [link, secret, password]) assert.ok(!disk.includes(value))
  h.service.bind('vm-01', id, owner)
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  assert.equal(h.store.read('vm-01').totp_secret, secret)
  assert.equal(h.store.read('vm-01').login_armed, false)
  h.service.start('vm-01'); await h.service.settle()
  assert.equal(h.calls.find(call => call[0] === 'login')[2].totp_secret, secret)
})

test('import only stores encrypted credentials, exposes no secrets and isolates tenant owners', async t => {
  const h = harness(t)
  assert.deepEqual(h.service.poolImport(row, owner), { created: 1, updated: 0, total: 1 })
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  const list = h.service.poolList(owner, ['vm-01'])
  assert.equal(list[0].has_totp, true)
  assert.deepEqual(h.service.poolList(other, ['vm-01']), [])
  assert.equal(h.service.poolList(admin, ['vm-01']).length, 1)
  assert.throws(() => h.service.poolReveal(list[0].id, other), /credential_not_found/)
  const disk = fs.readFileSync(path.join(h.projectRoot, 'data/codex-login-pool/credentials.json'), 'utf8')
  for (const value of [email, password, secret]) { assert.ok(!disk.includes(value)); assert.ok(!JSON.stringify(list).includes(value) || value === email) }
  assert.equal(h.service.poolReveal(list[0].id, owner).password, password)
})
test('binding to a resting slot does not login, refresh, probe or activate scheduling', async t => {
  const h = harness(t); h.slots[0].schedulable = false
  h.service.poolImport(row, owner)
  const id = h.service.poolList(owner, ['vm-01'])[0].id
  h.service.bind('vm-01', id, owner)
  await h.service.tick()
  assert.deepEqual(h.calls, [])
  assert.equal(h.slots[0].schedulable, false)
  assert.equal(h.service.status('vm-01').email, email)
  assert.equal(h.service.status('vm-01').login_armed, false)
  assert.throws(() => h.service.start('vm-01'), /slot_resting/)
  assert.throws(() => h.service.remote('vm-01'), /slot_resting/)
  assert.throws(() => h.service.control('vm-01', { op: 'frame' }), /slot_resting/)
})
test('binding an enabled slot remains idle until explicit login; worker uses selected slot and password/TOTP', async t => {
  const h = harness(t)
  h.service.poolImport(row, owner)
  const id = h.service.poolList(owner, ['vm-02'])[0].id
  h.service.bind('vm-02', id, owner)
  await h.service.tick(); assert.deepEqual(h.calls, [])
  h.service.start('vm-02'); await h.service.settle()
  const login = h.calls.find(call => call[0] === 'login')
  assert.equal(login[1], 'vm-02'); assert.equal(login[2].mode, 'password_totp')
  assert.equal(login[2].password, password); assert.equal(login[2].totp_secret, secret)
  assert.equal(h.service.status('vm-02').state.status, 'succeeded')
  assert.equal(h.service.status('vm-02').login_armed, true)
  assert.ok(h.calls.some(call => call[0] === 'commit' && call[1] === 'vm-02'))
})
test('updating imported credentials requires another manual login and never auto-starts', async t => {
  const h = harness(t)
  h.service.poolImport(row, owner)
  const id = h.service.poolList(owner, ['vm-01'])[0].id
  h.service.bind('vm-01', id, owner); h.service.start('vm-01'); await h.service.settle()
  h.calls.length = 0
  h.service.poolImport(row.replace(password, 'updated-fixture-password'), owner)
  assert.equal(h.store.read('vm-01').password, 'updated-fixture-password')
  assert.equal(h.service.status('vm-01').login_armed, false)
  await h.service.tick(); assert.deepEqual(h.calls, [])
})
test('mode changes cannot retain mailbox password; a credential binds to one slot and must be unbound before delete', t => {
  const h = harness(t)
  h.store.save('vm-01', { email: 'fixture@outlook.com', password: 'mailbox-only' })
  assert.throws(() => h.store.save('vm-01', { mode: 'password_totp', email: 'fixture@outlook.com', totp_secret: secret }), /mailbox_password_required/)
  h.service.poolImport(row, owner)
  const id = h.service.poolList(owner, ['vm-01'])[0].id
  assert.throws(() => h.service.bind('vm-01', id, other), /credential_not_found/)
  h.service.bind('vm-01', id, owner)
  assert.throws(() => h.service.bind('vm-02', id, owner), /credential_bound_elsewhere/)
  assert.throws(() => h.service.poolRemove(id, owner), /credential_bound/)
  h.service.remove('vm-01'); h.service.poolRemove(id, owner)
  assert.deepEqual(h.service.poolList(owner, ['vm-01']), [])
})
test('pool APIs permit tenants and admins but deny schedule-only operators', () => {
  for (const [method, path] of [['GET', '/api/panel/login-credentials'], ['POST', '/api/panel/login-credentials/import'],
    ['POST', '/api/panel/login-credentials/cred-00000000-0000-0000-0000-000000000000/reveal'], ['POST', '/api/panel/vms/vm-01/oauth/login/bind']]) {
    assert.equal(authorizePanelRoute(method, path, 'user').ok, true)
    assert.equal(authorizePanelRoute(method, path, 'admin').ok, true)
    assert.equal(authorizePanelRoute(method, path, 'super').ok, false)
  }
})

test('remote RPC shares the job lock and disables all control when the slot rests', async t => {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const h = harness(t, { runSlot: async ({ action, signal, onControl, onEvent, onStage }) => {
    if (action === 'prepare') return { ok: true }
    return new Promise((_resolve, reject) => {
      onControl(request => {
        if (request.op === 'frame') queueMicrotask(() => onEvent({ event: 'rpc', id: request.id, ok: true, data: { image: 'fixture-image' } }))
        if (request.op === 'session') queueMicrotask(() => onEvent({ event: 'rpc', id: request.id, ok: false, error_code: 'session_not_authenticated' }))
      })
      onStage('remote_ready');ready()
      signal.addEventListener('abort', () => reject(Object.assign(new Error('login_cancelled'), { code: 'login_cancelled' })), { once: true })
    })
  } })
  h.service.remote('vm-01'); await started
  assert.equal(h.service.status('vm-01').browser.remote, true)
  assert.deepEqual(await h.service.control('vm-01', { op: 'frame' }), { image: 'fixture-image' })
  await assert.rejects(h.service.control('vm-01', { op: 'session' }), /session_not_authenticated/)
  assert.throws(() => h.service.remote('vm-02'), /mailbox_login_busy/)
  h.slots[0].schedulable = false
  assert.throws(() => h.service.control('vm-01', { op: 'frame' }), /slot_resting/)
  h.service.guardJobs(); await h.service.settle()
  assert.equal(h.service.status('vm-01').browser.active, false)
})

test('real panel import and list routes store only credentials and enforce tenant ownership', async t => {
  const h = harness(t)
  let response, userId = owner.id
  const handle = createPanelHandler({ cfg: { paths: { project: h.projectRoot } }, readBody,
    requireAuth(req) { req.panelUser = 'fixture-user'; req.panelRole = 'user'; req.panelUserId = userId; return true },
    json(_res, status, body) { response = { status, body } },
  })
  const request = async (method, suffix, body) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    req.method = method
    await handle(req, { setHeader() {} }, new URL(`http://localhost/api/panel/login-credentials${suffix}`))
    return response
  }
  assert.equal((await request('POST', '/import', { text: row })).status, 200)
  assert.deepEqual(h.calls, [])
  assert.ok(!fs.existsSync(path.join(h.projectRoot, 'data/codex-mailbox')))
  const list = await request('GET', '')
  assert.equal(list.body.data.credentials.length, 1)
  const id = list.body.data.credentials[0].id
  userId = other.id
  assert.equal((await request('GET', '')).body.data.credentials.length, 0)
  assert.equal((await request('POST', `/${id}/reveal`, {})).status, 404)
})
