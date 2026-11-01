import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { collectNativeCodexResponse, prepareNativeCodexBody, needsNativeCodexResponse } from '../../src/lib/transport/codex-cli-native.mjs'
import { cacheCodexCliCatalog, clearCodexCliCatalog, codexCliRoutingCatalog, codexCliTierSupport } from '../../src/lib/protocol/codex-cli-tier.mjs'
import { orderCodexSessionSlots, isCodexFailoverError } from '../../src/lib/pool/codex-slot-pool.mjs'

test('native tools preserve all declarations, options, custom grammars and result history', () => {
  const tools = ['function', 'custom', 'namespace', 'web_search', 'image_generation', 'file_search', 'code_interpreter', 'mcp', 'computer', 'shell', 'apply_patch', 'tool_search'].map(type => ({ type, name: type, fixture: { retained: true } }))
  tools[1].format = { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' }
  tools[2].description = 'fixture namespace'
  const body = { model: 'fixture', tools, input: [{ type: 'custom_tool_call_output', call_id: 'one', output: 'done' }], tool_choice: 'required', parallel_tool_calls: false, service_tier: 'fast' }
  const prepared = prepareNativeCodexBody({ body, modelInfo: { serviceTiers: [{ id: 'priority' }] } })
  assert.deepEqual(prepared.tools, tools)
  assert.deepEqual(prepared.input, body.input)
  assert.equal(prepared.tool_choice, 'required')
  assert.equal(prepared.parallel_tool_calls, false)
  assert.equal(prepared.service_tier, 'priority')
  assert.equal(body.service_tier, 'fast')
  assert.equal(needsNativeCodexResponse(body), true)
  assert.equal(needsNativeCodexResponse({ input: 'hi' }), false)
})

test('native stream preserves hosted output/citations, usage, tiers and arbitrary events exactly', async () => {
  const response = { id: 'resp_fixture', status: 'completed', service_tier: 'ultrafast', usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 10, total_tokens: 130 },
    output: [{ type: 'image_generation_call', result: 'fixture' }, { type: 'file_search_call', results: [{ text: '引用' }] }] }
  const events = [{ type: 'response.created', response: { id: response.id } }, { type: 'response.custom_tool_call_input.delta', delta: '中文' }, { type: 'response.completed', response }]
  const raw = [{ status: 200 }, ...events.map(event => ({ event }))].map(x => JSON.stringify(x) + '\n').join('')
  const seen = []
  const result = await collectNativeCodexResponse(Readable.from([raw.slice(0, 31), raw.slice(31)]), { onEvent: async s => seen.push(JSON.parse(s.slice(6))) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.body, response)
  assert.deepEqual(result.usage, response.usage)
  assert.deepEqual(seen, events)
})

test('native errors and truncated streams never become successful responses', async () => {
  const failure = { error: { code: 'unsupported_tool', message: 'upstream rejection' } }
  const r = await collectNativeCodexResponse(Readable.from([JSON.stringify({ status: 400, body: failure }) + '\n']))
  assert.equal(r.status, 400); assert.equal(r.committed, false); assert.deepEqual(r.body, failure)
  const truncated = await collectNativeCodexResponse(Readable.from(['{"status":200}\n']))
  assert.equal(truncated.ok, false); assert.equal(truncated.body.error.code, 'upstream_incomplete_stream')
})

test('sparse terminal events retain streamed output; UTF-8 byte boundaries and tier mismatches survive', async () => {
  const item = { id: 'msg', type: 'message', content: [{ type: 'output_text', text: '中文', annotations: [] }] }
  const wire = Buffer.from([{ status: 200 }, { event: { type: 'response.output_item.done', output_index: 0, item } },
    { event: { type: 'response.completed', response: { status: 'completed', output: [], service_tier: 'default' } } }].map(x => JSON.stringify(x) + '\n').join(''))
  const split = wire.indexOf(Buffer.from('中文')) + 1
  const r = await collectNativeCodexResponse(Readable.from([wire.subarray(0,split),wire.subarray(split)]), { requestedServiceTier: 'priority' })
  assert.deepEqual(r.body.output, [item])
  assert.equal(r.body.metadata.gateway_tier_mismatch, true)
  assert.equal(r.body.service_tier, 'default')
})

test('routing hints survive restart, expire, and cannot transfer to another account', () => {
  const catalog = codexCliRoutingCatalog({ models: [{ id: 'fixture', serviceTiers: [{ id: 'ultrafast' }] }] }, 'account-a', 1000)
  const vm = { id: 'uncached-fixture', org_uuid: 'account-a', codex_cli: { routing_catalog: catalog } }
  assert.equal(codexCliTierSupport(vm, 'fixture', 'ultrafast', 2000), true)
  assert.equal(codexCliTierSupport(vm, 'fixture', 'ultrafast', 1000 + 16 * 60_000), null)
  assert.equal(codexCliTierSupport({ ...vm, org_uuid: 'account-b' }, 'fixture', 'ultrafast', 2000), null)
})

test('ultrafast routing skips unsupported sticky accounts, discovers unknown accounts, never downgrades', () => {
  const vm = id => ({ id, platform: 'openai', family: 'codex', has_token: true, schedulable: true, status: 'running', codex_cli: { enabled: true } })
  cacheCodexCliCatalog('fixture-fast', { models: [{ id: 'fixture', serviceTiers: [{ id: 'priority' }] }] })
  cacheCodexCliCatalog('fixture-ultra', { models: [{ id: 'fixture', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }] })
  try {
    const opts = { model: 'fixture', serviceTier: 'ultrafast', boundVmId: 'fixture-fast', roundRobinCursor: 0 }
    const picked = orderCodexSessionSlots([vm('fixture-fast'), vm('fixture-ultra')], opts)
    assert.deepEqual(picked.ids, ['fixture-ultra'])
    assert.equal(orderCodexSessionSlots([vm('fixture-fast')], opts).error, 'service_tier_unavailable')
    assert.ok(orderCodexSessionSlots([vm('fixture-unknown')], opts).ids.includes('fixture-unknown'))
    assert.equal(isCodexFailoverError({ status: 400, body: { error: { code: 'service_tier_unavailable' } } }), true)
    assert.equal(isCodexFailoverError({ status: 400, committed: true, body: { error: { code: 'service_tier_unavailable' } } }), false)
  } finally { clearCodexCliCatalog('fixture-fast'); clearCodexCliCatalog('fixture-ultra') }
})
