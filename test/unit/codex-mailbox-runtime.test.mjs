import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runMailboxSlotProcess, stagePortableMailboxRuntime, MAILBOX_BOOTSTRAP, SLOT_SUPERVISOR } from '../../src/lib/oauth/codex-mailbox-runtime.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

function fakeDocker(onJob) {
  const calls = []
  return { calls, spawnImpl(bin, argv, options) {
    const child = new EventEmitter()
    child.stdin = new PassThrough();child.stdout = new PassThrough();child.stderr = new PassThrough()
    child.kill = () => child.emit('close', 130)
    let buf = ''
    child.stdin.on('data', (data) => {
      buf += data
      const lines = buf.split('\n');buf = lines.pop()
      for (const line of lines) { const job = JSON.parse(line);calls.push({ bin, argv, options, job });onJob(job, child) }
    })
    return child
  } }
}
test('Docker and KVM use slot exec, secret only on stdin, callback NDJSON is buffered', async () => {
  for (const type of ['docker', 'kvm']) {
    const mock = fakeDocker((job, child) => {
      if (job.action !== 'login') return
      queueMicrotask(() => {
        child.stdout.write('{"event":"stage","stage":"waiting_email_code"}\n{"event":"call')
        child.stdout.write('back","callback_url":"http://localhost:1455/auth/callback?code=fixture"}\n')
        child.emit('close', 0)
      })
    })
    const stages = []
    const result = await runMailboxSlotProcess({ projectRoot: process.cwd(),
      vm: { id: 'vm-01', runtime: { type } }, action: 'login',
      payload: { password: 'test-secret-only-stdin' }, onStage: (s) => stages.push(s), ...mock })
    assert.match(result.callback, /code=fixture/)
    assert.deepEqual(stages, ['waiting_email_code'])
    assert.ok(!JSON.stringify(mock.calls[0].argv).includes('test-secret-only-stdin'))
    assert.equal(mock.calls[0].job.payload.password, 'test-secret-only-stdin')
    assert.equal(mock.calls[0].argv.includes('/usr/local/bin/kin-guest-exec'), type === 'kvm')
  }
})
test('abort forwards a cancel message to the supervisor inside slot', async () => {
  const controller = new AbortController()
  const mock = fakeDocker((job, child) => {
    if (job.action) queueMicrotask(() => controller.abort())
    if (job.cancel) queueMicrotask(() => child.emit('close', 130))
  })
  await assert.rejects(runMailboxSlotProcess({ projectRoot: process.cwd(), vm: { id: 'vm-01' },
    action: 'prepare', signal: controller.signal, ...mock }), /login_cancelled/)
  assert.equal(mock.calls.at(-1).job.cancel, true)
  assert.match(SLOT_SUPERVISOR, /os\.killpg/)
})
test('browser failure details are not returned to callers', async () => {
  const mock = fakeDocker((_job, child) => queueMicrotask(() => {
    child.stderr.write('test-sensitive-url-and-password')
    child.stdout.write('{"event":"stage","stage":"failed","code":"mailbox_password_rejected"}\n')
    child.emit('close', 1)
  }))
  await assert.rejects(runMailboxSlotProcess({ projectRoot: process.cwd(), vm: { id: 'vm-01' }, action: 'login', ...mock }),
    (e) => e.code === 'mailbox_password_rejected' && !e.message.includes('sensitive'))
})

test('remote screenshot RPC larger than the old output cap is delivered without requiring an OAuth callback', async () => {
  const id = '00000000-0000-0000-0000-000000000000'
  const events = []
  const mock = fakeDocker((_job, child) => queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ event: 'rpc', id, ok: true, data: { image: 'x'.repeat(100_000) } }) + '\n')
    child.emit('close', 0)
  }))
  const result = await runMailboxSlotProcess({ projectRoot: process.cwd(), vm: { id: 'vm-01' },
    action: 'remote', onEvent: event => events.push(event), ...mock })
  assert.equal(result.ok, true)
  assert.equal(events[0].data.image.length, 100_000)
})

test('short session and subscription tasks return structured results over stdin/stdout inside Docker or KVM', async () => {
  for (const type of ['docker', 'kvm']) for (const action of ['session', 'subscription']) {
    const fixture = action === 'session' ? { accessToken: 'fixture-only', user: { email: 'fixture@example.com' } }
      : { enabled: false, period_end: '2030-12-01T00:00:00+00:00' }
    const mock = fakeDocker((_job, child) => queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ event: 'result', data: fixture }) + '\n')
      child.emit('close', 0)
    }))
    const result = await runMailboxSlotProcess({ projectRoot: process.cwd(), vm: { id: 'vm-01', runtime: { type } },
      action, payload: { operation: action, email: 'fixture@example.com' }, ...mock })
    assert.deepEqual(result, fixture)
    assert.equal(mock.calls[0].argv.includes('/usr/local/bin/kin-guest-exec'), type === 'kvm')
    assert.ok(!JSON.stringify(mock.calls[0].argv).includes('fixture@example.com'))
  }
})

test('resting slots are rejected before portable staging and missing optional bundle leaves legacy preparation available', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-browser-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => stagePortableMailboxRuntime(root, { id: 'vm-02', schedulable: false }), /slot_resting/)
  assert.doesNotThrow(() => stagePortableMailboxRuntime(root, { id: 'vm-01', schedulable: true }))
  assert.deepEqual(fs.readdirSync(root), [])
  assert.ok(MAILBOX_BOOTSTRAP.includes('/home/kincli/.local/share/kin-mailbox'))
})

test('prepare reports safe structured failure codes and never exposes raw installer output', async () => {
  const mock = fakeDocker((_job, child) => queueMicrotask(() => {
    child.stderr.write('private-proxy-url secret-fixture')
    child.stdout.write('{"event":"stage","stage":"failed","code":"browser_launch_failed"}\n{"event":"prepared","ok":false}\n')
    child.emit('close', 1)
  }))
  await assert.rejects(runMailboxSlotProcess({ projectRoot: process.cwd(), vm: { id: 'vm-01' }, action: 'prepare', ...mock }),
    error => error.code === 'browser_launch_failed' && !error.message.includes('private'))
})

test('portable staging verifies its archive, installs into the existing slot home and preserves profiles on reuse', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-stage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'fixture'), share = path.join(root, 'share/kin-mailbox-runtime')
  const home = path.join(root, 'vms/vm-01/cli-home')
  for (const dir of [source, share, home]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(source, 'portable.json'), JSON.stringify({ version: '1.64.1' }))
  const archive = path.join(share, 'ubuntu24.04-amd64.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', source, 'portable.json'])
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  const manifest = path.join(share, 'manifest.json')
  fs.writeFileSync(manifest, JSON.stringify({ version: '1.64.1', sha256 }))
  const vm = { id: 'vm-01', schedulable: true }
  stagePortableMailboxRuntime(root, vm)
  const runtime = path.join(home, '.local/share/kin-mailbox')
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'portable.json'))).bundle_sha256, sha256)
  const profile = path.join(runtime, 'profiles/existing-profile')
  fs.writeFileSync(profile, 'fixture-state')
  stagePortableMailboxRuntime(root, vm)
  assert.equal(fs.readFileSync(profile, 'utf8'), 'fixture-state')
  fs.writeFileSync(manifest, JSON.stringify({ version: '1.64.1', sha256: 'bad-sha' }))
  assert.throws(() => stagePortableMailboxRuntime(root, vm), /browser_runtime_invalid/)
  assert.equal(fs.readFileSync(profile, 'utf8'), 'fixture-state')
  fs.writeFileSync(path.join(source, 'portable.json'), JSON.stringify({ version: '1.64.1', revision: 2 }))
  execFileSync('tar', ['-czf', archive, '-C', source, 'portable.json'])
  const upgradedSha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  fs.writeFileSync(manifest, JSON.stringify({ version: '1.64.1', sha256: upgradedSha }))
  stagePortableMailboxRuntime(root, vm)
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'portable.json'))).revision, 2)
  assert.equal(fs.readFileSync(profile, 'utf8'), 'fixture-state')
  assert.deepEqual(fs.readdirSync(path.dirname(runtime)), ['kin-mailbox'])
})
