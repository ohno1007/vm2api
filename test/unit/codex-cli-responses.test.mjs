import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { streamCodexCliResponse, prepareCodexCliRequest } from '../../src/lib/protocol/codex-cli-responses.mjs'

class Fixture extends EventEmitter {
  constructor(mode = 'text') { super(); this.mode = mode; this.seq = 0; this.unsubscribed = [] }
  send(method, params) { this.emit('notification', { method, params }) }
  async request(method, params) {
    if (method === 'thread/start') return { thread: { id: `thread-${++this.seq}` }, model: params.model, serviceTier: params.serviceTier }
    if (method === 'thread/unsubscribe') { this.unsubscribed.push(params.threadId); return {} }
    if (method === 'turn/interrupt') {
      this.send('thread/tokenUsage/updated', { ...params, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 5 } } })
      this.send('turn/completed', { ...params, turn: { id: params.turnId, status: 'interrupted', durationMs: 20 } })
      return {}
    }
    if (method !== 'turn/start') return {}
    const p = { threadId: params.threadId, turnId: `turn-${params.threadId}` }
    setImmediate(() => {
      this.send('turn/started', { ...p, turn: { id: p.turnId } })
      if (this.mode === 'wait') return
      this.send('item/reasoning/summaryTextDelta', { ...p, itemId: `r-${p.threadId}`, summaryIndex: 0, delta: 'Brief summary.' })
      this.send('item/completed', { ...p, item: { id: `r-${p.threadId}`, type: 'reasoning', summary: ['Brief summary.'] } })
      this.send('item/agentMessage/delta', { ...p, itemId: `m-${p.threadId}`, delta: p.threadId })
      const tokenUsage = { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 5 } }
      this.send('thread/tokenUsage/updated', { ...p, tokenUsage })
      this.send('thread/tokenUsage/updated', { ...p, tokenUsage })
      this.send('turn/completed', { ...p, turn: { id: p.turnId, status: 'completed', durationMs: 20 } })
    })
    return { turn: { id: p.turnId } }
  }
}
const invoke = (rpc, extra = {}) => streamCodexCliResponse({ rpc, body: { model: 'fixture', input: 'test' }, modelInfo: {}, cwd: '/tmp', ...extra })

test('concurrent turns isolate deltas and counts and finish reasoning summaries', async () => {
  const rpc = new Fixture()
  const [a, b] = await Promise.all([invoke(rpc), invoke(rpc)])
  for (const [i, r] of [a, b].entries()) {
    assert.equal(r.ok, true)
    assert.equal(r.body.output[0].summary[0].text, 'Brief summary.')
    assert.equal(r.body.output[1].content[0].text, `thread-${i + 1}`)
    assert.equal(r.usage.total_tokens, 110)
    assert.equal(r.body.service_tier, null, 'configuration is not an upstream tier receipt')
  }
  assert.equal(rpc.unsubscribed.length, 2)
  assert.equal(rpc.listenerCount('notification'), 0)
})

test('cancellation interrupts and retains late actual usage without marking success', async () => {
  const rpc = new Fixture('wait')
  const controller = new AbortController()
  rpc.on('notification', m => { if (m.method === 'turn/started') controller.abort() })
  const result = await invoke(rpc, { signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.status, 499)
  assert.equal(result.usage.total_tokens, 110)
  assert.equal(rpc.unsubscribed.length, 1)
})

test('unsupported tools and malformed images fail explicitly', () => {
  assert.throws(() => prepareCodexCliRequest({ model: 'fixture', input: 'a', tools: [{ type: 'web_search' }] }), /unsupported_tool/)
  assert.throws(() => prepareCodexCliRequest({ model: 'fixture', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'file:///private' }] }] }), /unsupported_image_url/)
})
