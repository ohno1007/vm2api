import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCliHistory, codexCliHistoryOwner } from '../../src/lib/protocol/codex-cli-history.mjs'

test('history is caller scoped, expires, and respects store=false', () => {
  let now = 0
  const cache = new CodexCliHistory({ ttlMs: 10, now: () => now })
  const owner = codexCliHistoryOwner({ authorization: 'Bearer example-a' })
  const answer = { id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: 'answer' }] }
  cache.remember({ input: 'first' }, answer, owner)
  const next = { previous_response_id: 'resp_1', input: 'next', instructions: 'new' }
  assert.equal(cache.expand(next, owner).input.length, 3)
  assert.equal(cache.expand(next, owner).instructions, 'new')
  assert.throws(() => cache.expand(next, 'another-key'), /previous_response_not_found/)
  cache.remember({ input: 'private' }, { ...answer, id: 'resp_2' }, owner, false)
  assert.equal(cache.entries.has('resp_2'), false)
  now = 11
  assert.throws(() => cache.expand(next, owner), /previous_response_not_found/)
  assert.equal(cache.bytes, 0)
})

test('history evicts oldest entries, rejects oversized entries, and copies input', () => {
  const cache = new CodexCliHistory({ maxEntries: 1, maxBytes: 400 })
  const input = [{ role: 'user', content: 'a' }]
  cache.remember({ input }, { id: 'a', status: 'completed', output: [] }, 'owner')
  input[0].content = 'changed'
  assert.equal(cache.expand({ previous_response_id: 'a', input: 'b' }, 'owner').input[0].content, 'a')
  cache.remember({ input: 'b' }, { id: 'b', status: 'completed', output: [] }, 'owner')
  assert.equal(cache.entries.has('a'), false)
  cache.remember({ input: 'x'.repeat(500) }, { id: 'c', status: 'completed', output: [] }, 'owner')
  assert.equal(cache.entries.has('c'), false)
  assert.throws(() => new CodexCliHistory({ maxEntries: 0 }), /invalid_history_limits/)
})
