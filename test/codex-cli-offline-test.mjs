// Runs the genuine, pinned CLI against an in-process loopback fixture.
// Intended for an isolated --network none container; no real account is loaded.
import http from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CodexAppServerRpc } from '../src/lib/transport/codex-app-server-rpc.mjs'
import { streamCodexCliResponse } from '../src/lib/protocol/codex-cli-responses.mjs'
import { codexCliAppServerArgs } from '../src/lib/vm/codex-cli-config.mjs'

const requests = []
let nextReply = 'text'
const upstream = http.createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return }
  const body = JSON.parse(text)
  requests.push(body)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const item = nextReply.startsWith('tool')
    ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'lookup', arguments: '{"city":"Boston"}', status: 'completed' }
    : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
  const response = { id: 'resp_fixture', object: 'response', model: body.model, status: 'completed', output: [item], usage: {
    input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 8 }, total_tokens: 130,
  } }
  const events = nextReply.startsWith('tool') ? [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ] : [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  if (nextReply === 'tools') {
    const second = { ...item, id: 'fc_second', call_id: 'call_second', arguments: '{"city":"Seattle"}' }
    response.output.push(second)
    events.splice(-1, 0,
      { type: 'response.output_item.added', output_index: 1, item: { ...second, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: second.id, delta: second.arguments },
      { type: 'response.output_item.done', output_index: 1, item: second },
    )
  }
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const dir = fs.mkdtempSync('/tmp/codex-offline-')
const base = `http://127.0.0.1:${upstream.address().port}`
// Offline provider metadata, not an entitlement override on a real account.
const catalogPath = `${dir}/fixture-models.json`
fs.writeFileSync(catalogPath, JSON.stringify({ models: [{
  slug: 'gpt-6.1-sol', display_name: 'Offline fixture', description: 'Protocol test',
  supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
  shell_type: 'disabled', visibility: 'list', supported_in_api: true, priority: 0,
  base_instructions: 'You are a helpful assistant.', support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
  service_tiers: ['priority', 'ultrafast'].map(id => ({ id, name: id, description: 'Offline test only' })),
}] }))
const flags = [
  ...codexCliAppServerArgs().slice(2),
  '-c', `model_catalog_json="${catalogPath}"`,
  '-c', 'model_provider="vm2api_fixture"',
  '-c', `model_providers.vm2api_fixture={ name="Offline fixture", base_url="${base}", wire_api="responses", requires_openai_auth=false }`,
  '-c', 'web_search="disabled"',
  ...['shell_tool', 'apply_patch_freeform', 'unified_exec', 'multi_agent', 'code_mode', 'code_mode_host', 'plugins', 'apps', 'memories', 'view_image'].flatMap((f) => ['-c', `features.${f}=false`]),
]
const child = spawn(process.env.CODEX_BIN, ['app-server', ...flags], {
  env: { ...process.env, CODEX_HOME: dir, HOME: dir }, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
})
const rpc = new CodexAppServerRpc(child)
// This fixture has no credentials; preserve server errors for protocol debugging.
if (process.env.CODEX_TEST_TRACE === '1') child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    try { const value = JSON.parse(line); if (value.error) console.log('fixture_rpc_error', JSON.stringify(value)) } catch {}
  }
})
const notifications = []
rpc.on('notification', (m) => { notifications.push(m); if (process.env.CODEX_TEST_TRACE === '1') console.log(m.method, JSON.stringify(m.params).slice(0, 1700)) })
try {
  const init = await rpc.initialize()
  console.log('initialized', JSON.stringify(init))
  const account = await rpc.request('account/read', { refreshToken: false })
  assert.equal(account.requiresOpenaiAuth, false)
  const start = await rpc.request('thread/start', { model: 'gpt-6.1-sol', ephemeral: true, cwd: dir, approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Answer briefly.', allowProviderModelFallback: false })
  const threadId = start.thread.id
  await rpc.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier question' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer' }] }] })
  let timeout
  const finished = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('fixture turn timeout')), 30_000)
    const onEvent = (m) => { if (m.method === 'turn/completed' && m.params.threadId === threadId) { rpc.off('notification', onEvent); resolve(m.params.turn) } }
    rpc.on('notification', onEvent)
  })
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply OK.' }] })
  const turn = await finished
  clearTimeout(timeout)
  assert.equal(turn.status, 'completed')
  assert.equal(requests.length, 1)
  assert.ok(requests[0].input.some((m) => m.role === 'assistant' && JSON.stringify(m).includes('Earlier answer')))
  assert.ok(notifications.some((m) => m.method === 'item/agentMessage/delta' && m.params.delta === 'OK'))
  const usage = notifications.findLast((m) => m.method === 'thread/tokenUsage/updated')?.params.tokenUsage
  assert.equal(usage.total.inputTokens, 120)
  assert.equal(usage.total.cachedInputTokens, 80)
  assert.equal(usage.total.outputTokens, 10)
  console.log('request_tools', JSON.stringify(requests[0].tools))
  console.log('usage', JSON.stringify(usage))
  console.log('PASS: official CLI initialize, injected history, streaming and authoritative usage')
  const events = []
  const modelInfo = (await rpc.request('model/list', { includeHidden: false })).data.find(m => m.id === 'gpt-6.1-sol')
  assert.ok(modelInfo.serviceTiers.some(t => t.id === 'ultrafast'))
  const invoke = (body) => streamCodexCliResponse({ rpc, body: { model: 'gpt-6.1-sol', ...body }, modelInfo, cwd: dir,
    timeoutMs: 20_000, idleTimeoutMs: 10_000, onEvent: async (line) => events.push(JSON.parse(line.slice(6))) })
  const text = await invoke({ input: 'Reply OK.' })
  assert.equal(text.ok, true, JSON.stringify(text))
  assert.equal(text.body.output[0].content[0].text, 'OK')
  assert.equal(text.usage.input_tokens, 120)
  assert.equal(text.usage.output_tokens, 10)
  assert.ok(events.some((e) => e.type === 'response.output_text.delta' && e.delta === 'OK'))
  assert.ok(events.some((e) => e.type === 'response.completed'))
  assert.ok(!requests.at(-1).tools?.length, 'the API must not expose local execution tools')
  console.log('fixture_context_sizes', JSON.stringify({ instructions: requests.at(-1).instructions?.length, input: requests.at(-1).input.map(i => ({ role: i.role, type: i.type, chars: JSON.stringify(i.content || '').length })) }))
  console.log('PASS: gateway Responses stream and counts through the genuine CLI')
  nextReply = 'tool'
  const tools = [{ type: 'function', name: 'lookup', description: 'Get the weather.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } }]
  const tool = await invoke({ input: 'Use lookup to find the weather in Boston.', tools })
  assert.equal(tool.ok, true, JSON.stringify(tool))
  assert.equal(tool.body.output[0].type, 'function_call')
  assert.equal(tool.body.output[0].call_id, 'call_fixture')
  assert.equal(tool.usage.input_tokens, 120)
  assert.equal(tool.usage.output_tokens, 10)
  assert.equal(requests.length, 3, 'tool handoff must not cause an extra upstream inference')
  console.log('PASS: external function tools handed back without executing them in the guest')
  nextReply = 'text'
  const continued = await invoke({ input: [
    { role: 'user', content: 'Use lookup to find the weather in Boston.' },
    tool.body.output[0],
    { type: 'function_call_output', call_id: 'call_fixture', output: 'Sunny, 20 C' },
  ], tools })
  assert.equal(continued.ok, true, JSON.stringify(continued))
  assert.equal(continued.usage.input_tokens, 120)
  assert.ok(requests.at(-1).input.some((i) => i.type === 'function_call_output' && i.output.includes('Sunny')))
  console.log('PASS: caller tool output history continues with no fabricated user message')
  nextReply = 'tools'
  const parallel = await invoke({ input: 'Look up both cities.', tools })
  assert.equal(parallel.ok, true, JSON.stringify(parallel))
  assert.equal(parallel.body.output.filter(i => i.type === 'function_call').length, 2, 'parallel tool handoff must retain every call')
  console.log('PASS: parallel external tool calls remain complete')
  nextReply = 'text'
  for (const tier of ['priority', 'ultrafast']) {
    const result = await invoke({ input: 'Reply OK.', service_tier: tier })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(requests.at(-1).service_tier, tier, 'configured tier must reach the actual CLI upstream request')
    assert.equal(result.body.service_tier, null, 'configuration is not a billed-tier receipt')
    assert.equal(result.usage.total_tokens, 130)
    console.log('PASS: genuine CLI upstream tier', tier)
  }
} finally {
  rpc.close()
  child.kill('SIGTERM')
  upstream.closeAllConnections()
  upstream.close()
}
