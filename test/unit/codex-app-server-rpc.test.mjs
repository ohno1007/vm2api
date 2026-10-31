import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { CodexAppServerRpc } from '../../src/lib/transport/codex-app-server-rpc.mjs'

function fixture(options) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const sent = []
  child.stdin.on('data', (line) => sent.push(JSON.parse(line.toString())))
  return { child, sent, rpc: new CodexAppServerRpc(child, options) }
}

test('initializes the official protocol and sends initialized only after acknowledgment', async () => {
  const { rpc, child, sent } = fixture()
  const promise = rpc.initialize()
  assert.equal(sent[0].method, 'initialize')
  assert.equal(sent[0].params.capabilities.experimentalApi, true)
  assert.equal(sent.length, 1)
  child.stdout.write(JSON.stringify({ id: sent[0].id, result: { userAgent: 'codex/0.166.0' } }) + '\n')
  assert.equal((await promise).userAgent, 'codex/0.166.0')
  assert.equal(sent[1].method, 'initialized')
  rpc.close()
})

test('splits UTF-8 frames and routes responses independently of interleaved notifications', async () => {
  const { rpc, child, sent } = fixture()
  const notices = [], serverRequests = []
  rpc.on('notification', (m) => notices.push(m))
  rpc.on('serverRequest', (m) => serverRequests.push(m))
  const a = rpc.request('model/list'), b = rpc.request('account/read')
  const frames = Buffer.from([
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '你好' } }),
    JSON.stringify({ id: sent[1].id, result: { account: null } }),
    JSON.stringify({ id: 9, method: 'item/tool/call', params: { tool: 'lookup' } }),
    JSON.stringify({ id: sent[0].id, result: { data: [] } }), '',
  ].join('\n'))
  for (const byte of frames) child.stdout.write(Buffer.from([byte]))
  assert.deepEqual(await a, { data: [] })
  assert.deepEqual(await b, { account: null })
  assert.equal(notices[0].params.delta, '你好')
  assert.equal(serverRequests[0].id, 9)
  rpc.close()
})

test('abort removes pending request and ignores a late answer', async () => {
  const { rpc, child, sent } = fixture()
  const controller = new AbortController()
  const pending = rpc.request('thread/start', {}, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'client_cancelled' })
  child.stdout.write(JSON.stringify({ id: sent[0].id, result: {} }) + '\n')
  assert.equal(rpc.pending.size, 0)
  assert.equal(rpc.closed, false)
  rpc.close()
})

test('malformed/oversized frames and process exits reject pending operations', async () => {
  for (const [data, code] of [['not-json\n', 'codex_cli_invalid_json'], ['x'.repeat(100), 'codex_cli_frame_too_large']]) {
    const { rpc, child } = fixture({ maxFrameBytes: 80 })
    const pending = rpc.request('ping')
    child.stdout.write(data)
    await assert.rejects(pending, { code })
    assert.equal(rpc.pending.size, 0)
  }
  const { rpc, child } = fixture()
  const pending = rpc.request('ping')
  child.emit('close', 1)
  await assert.rejects(pending, { code: 'codex_cli_exited' })
})

test('remote RPC error text is not exposed in the gateway error', async () => {
  const { rpc, child, sent } = fixture()
  const pending = rpc.request('turn/start')
  child.stdout.write(JSON.stringify({ id: sent[0].id, error: { code: -32602, message: 'private-token', data: { reason: 'invalidModel' } } }) + '\n')
  await assert.rejects(pending, (e) => e.status === 400 && e.reason === 'invalidModel' && !e.message.includes('private-token'))
  rpc.close()
})
