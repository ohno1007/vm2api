import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureBillingAttribution } from '../../src/lib/identity/crs-persona.mjs'
import { prepareCliHopBody, prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { computeClaudeCodeCch, projectClaudeCodeCchText } from '../../src/lib/identity/cch.mjs'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'

const sessionId = '11111111-1111-4111-8111-111111111111'
const identity = { deviceId: 'd'.repeat(64), accountUuid: sessionId, callerSessionId: sessionId }
const base = () => ({ model: 'claude-sonnet-5', max_tokens: 1024, messages: [{ role: 'user', content: 'hello' }] })
const billing = (body) =>
  (typeof body.system === 'string' ? body.system : body.system.map((b) => b.text ?? b).join('\n')).match(
    /^\s*x-anthropic-billing-header:[^\r\n]*/im,
  )?.[0]

test('missing billing is added for absent, string and array systems without mutating caller blocks', () => {
  for (const system of [
    undefined,
    '',
    'caller rules',
    [{ type: 'text', text: 'caller rules', cache_control: { type: 'ephemeral' } }],
  ]) {
    const input = { ...base(), ...(system === undefined ? {} : { system }) }
    const before = structuredClone(input)
    const out = ensureBillingAttribution(input, { sessionId })
    assert.match(billing(out), /cc_version=2\.1\.303\.[0-9a-f]{3};/)
    assert.match(billing(out), /cc_entrypoint=sdk-cli;/)
    assert.match(billing(out), /cch=00000;/)
    assert.match(billing(out), new RegExp(`cc_prompt_id=${sessionId};`))
    assert.deepEqual(input, before)
    if (Array.isArray(system)) assert.strictEqual(out.system[1], system[0])
    assert.strictEqual(ensureBillingAttribution(out, { sessionId }), out)
  }
})

test('existing complete billing and its cache anchors stay untouched; partial billing is completed', () => {
  const complete = ensureBillingAttribution({ ...base(), system: 'caller rules' }, { sessionId })
  assert.strictEqual(ensureBillingAttribution(complete), complete)
  const partial = {
    ...base(),
    system: 'x-anthropic-billing-header: cc_version=2.1.303.abc; custom=value;\ncaller rules',
  }
  const out = ensureBillingAttribution(partial, { sessionId })
  assert.match(out.system, /cc_version=2\.1\.303\.abc;/)
  assert.match(out.system, /custom=value;/)
  assert.match(out.system, /cc_entrypoint=sdk-cli;/)
  assert.match(out.system, /\ncaller rules$/)
  assert.equal((out.system.match(/x-anthropic-billing-header:/g) || []).length, 1)
})

test('final worker payload restores billing stripped by cli-hop and leaves sealing to native CLI', () => {
  const prepared = prepareCliHopBody({ ...base(), system: [{ type: 'text', text: 'caller rules' }] })
  const out = finalizeWorkerPayload({
    body: prepared,
    reqHeaders: {},
    exec: { vm: { claude: { mode: 'oauth' } } },
    identity,
    cliHop: true,
  })
  assert.match(billing(out.body), /cc_version=/)
  assert.match(billing(out.body), /cch=00000;/)
  assert.match(out.body.system[0].text, /^x-anthropic-billing-header:/)
  assert.equal(out.body.system[1].text, 'caller rules')
  assert.equal(out.body.system[0].cache_control, undefined)
})

test('HTTP envelopes add billing before calculating final CCH for every credential mode', () => {
  for (const credentialMode of ['oauth', 'api-key', 'setup-token']) {
    const input = { ...base(), system: 'caller rules' }
    const out = prepareOutboundEnvelope({
      canonicalBody: input,
      inbound: input,
      identity: { ...identity },
      unofficial: true,
      credentialMode,
    })
    const cch = billing(out.body)?.match(/cch=([0-9a-f]{5});/)?.[1]
    assert.ok(cch, credentialMode)
    assert.equal(cch, computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(JSON.stringify(out.body)))))
  }
})

test('classifier worker requests also carry billing without changing verdict or cache contract', () => {
  const system = [{ type: 'text', text: '<block>rules</block>', cache_control: { type: 'ephemeral', ttl: '5m' } }]
  const body = {
    ...base(),
    system,
    messages: [{ role: 'user', content: '<transcript>action</transcript>' }],
    thinking: { type: 'disabled' },
  }
  const out = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    exec: {},
    identity,
    cliHop: true,
    requestContext: { purpose: 'auto_mode_classifier', format: 'xml' },
  })
  assert.ok(billing(out.body))
  assert.strictEqual(out.body.system[1], system[0])
  assert.deepEqual(out.body.thinking, body.thinking)
  assert.deepEqual(out.body.messages, body.messages)
})

test('API forwarding seals missing Anthropic billing but does not add it to OpenAI systems', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-billing-api-'))
  fs.mkdirSync(path.join(root, 'run'))
  const socketPath = path.join(root, 'run', 'api-kernel.sock')
  const captured = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    captured.push(JSON.parse(JSON.parse(raw).body))
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'fixture' } }))
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const protocol of ['anthropic', 'openai']) {
    await runApiInference({
      cfg: { dataDir: root },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: {
            protocol,
            kind: protocol === 'openai' ? 'openai' : 'claude',
            base_url: 'https://upstream.invalid',
          },
          key: { api_key: 'fixture' },
          upstream_model: 'claude-sonnet-5',
        }),
      },
      convertedBody: { ...base(), system: 'caller rules' },
    })
  }
  assert.match(billing(captured[0]), /cc_version=/)
  const cch = billing(captured[0]).match(/cch=([0-9a-f]{5});/)[1]
  assert.equal(cch, computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(JSON.stringify(captured[0])))))
  assert.doesNotMatch(JSON.stringify(captured[1]), /x-anthropic-billing-header:/)
})
