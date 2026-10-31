import { createHash } from 'node:crypto'
import { codexCliError } from '../transport/codex-app-server-rpc.mjs'

/** Bounded, caller-scoped Responses history. API keys are hashed, never stored. */
export class CodexCliHistory {
  constructor({ maxBytes = 32 * 1024 * 1024, maxEntries = 256, ttlMs = 15 * 60_000, now = Date.now } = {}) {
    Object.assign(this, { maxBytes, maxEntries, ttlMs, now })
    if (maxBytes < 1 || maxEntries < 1 || ttlMs < 1) throw new Error('invalid_history_limits')
    this.entries = new Map(); this.bytes = 0
  }

  drop(id) {
    const old = this.entries.get(id)
    if (old) { this.bytes -= old.bytes; this.entries.delete(id) }
  }

  expand(body, owner) {
    if (!body.previous_response_id) return body
    const previous = this.entries.get(body.previous_response_id)
    if (!owner || !previous || previous.owner !== owner || previous.expires <= this.now()) {
      if (previous?.expires <= this.now()) this.drop(body.previous_response_id)
      throw codexCliError('previous_response_not_found', 404)
    }
    const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input || []
    const result = { ...body, input: [...structuredClone(previous.items), ...input] }
    delete result.previous_response_id
    return result
  }

  remember(body, response, owner, store = true) {
    if (!store || !owner || response?.status !== 'completed') return
    const input = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : body.input || []
    const items = [...input, ...response.output]
    const bytes = Buffer.byteLength(JSON.stringify(items))
    if (bytes > this.maxBytes) return
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.drop(id)
    this.drop(response.id)
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.drop(this.entries.keys().next().value)
    this.entries.set(response.id, { owner, items: structuredClone(items), bytes, expires: this.now() + this.ttlMs })
    this.bytes += bytes
  }
}

export function codexCliHistoryOwner(headers = {}) {
  const authorization = headers.authorization || headers['x-api-key'] || headers['x-goog-api-key']
  return typeof authorization === 'string' && authorization ? createHash('sha256').update(authorization).digest('hex') : null
}
