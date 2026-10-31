import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'

export function codexCliError(code, status = 502, message = code) {
  return Object.assign(new Error(message), { code, status })
}

/** JSONL transport for the official app-server. Credentials and frames are never logged. */
export class CodexAppServerRpc extends EventEmitter {
  constructor(child, { maxFrameBytes = 16 * 1024 * 1024, maxPending = 128 } = {}) {
    super()
    this.setMaxListeners(64)
    this.child = child
    this.maxFrameBytes = maxFrameBytes
    this.maxPending = maxPending
    this.pending = new Map()
    this.nextId = 0
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
    this.closed = false
    child.stdout.on('data', (data) => this.consume(data))
    child.stdout.once('end', () => this.fail(codexCliError('codex_cli_disconnected')))
    child.stdin.on('error', () => this.fail(codexCliError('codex_cli_write_failed')))
    child.once('error', () => this.fail(codexCliError('codex_cli_spawn_failed')))
    child.once('close', () => this.fail(codexCliError('codex_cli_exited')))
    // stderr can include account information or URLs. Drain without forwarding.
    child.stderr?.on('data', () => {})
  }

  consume(data) {
    if (this.closed) return
    this.buffer += this.decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (Buffer.byteLength(line) > this.maxFrameBytes) return this.fail(codexCliError('codex_cli_frame_too_large'))
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { return this.fail(codexCliError('codex_cli_invalid_json')) }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return this.fail(codexCliError('codex_cli_invalid_frame'))
      }
      if (typeof message.method === 'string') {
        this.emit(message.id == null ? 'notification' : 'serverRequest', message)
      } else if (message.id != null) {
        const pending = this.pending.get(String(message.id))
        if (!pending) continue // A late answer to a cancelled or timed-out request.
        if (message.error) {
          const error = codexCliError('codex_cli_rpc_error', message.error.code === -32602 ? 400 : 502)
          error.rpcCode = message.error.code
          // Keep machine-readable details only; the message may contain private URLs.
          error.reason = typeof message.error.data?.reason === 'string' ? message.error.data.reason : null
          pending.finish(error)
        } else if (Object.hasOwn(message, 'result')) pending.finish(null, message.result)
        else pending.finish(codexCliError('codex_cli_invalid_response'))
      } else return this.fail(codexCliError('codex_cli_invalid_frame'))
      if (this.closed) return
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) this.fail(codexCliError('codex_cli_frame_too_large'))
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw codexCliError('codex_cli_disconnected')
    const frame = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw codexCliError('codex_cli_request_too_large', 413)
    if (this.child.stdin.writableLength > this.maxFrameBytes) throw codexCliError('codex_cli_backpressure', 503)
    this.child.stdin.write(frame)
  }

  request(method, params = {}, { timeoutMs = 30_000, signal } = {}) {
    if (signal?.aborted) return Promise.reject(codexCliError('client_cancelled', 499))
    if (this.closed) return Promise.reject(codexCliError('codex_cli_disconnected'))
    if (this.pending.size >= this.maxPending) return Promise.reject(codexCliError('codex_cli_busy', 503))
    const id = `vm2api-${++this.nextId}`
    return new Promise((resolve, reject) => {
      let timer
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        error ? reject(error) : resolve(value)
      }
      const abort = () => finish(codexCliError('client_cancelled', 499))
      this.pending.set(id, { finish })
      timer = setTimeout(() => finish(codexCliError('codex_cli_rpc_timeout', 504)), Math.max(1, timeoutMs))
      timer.unref?.()
      signal?.addEventListener('abort', abort, { once: true })
      try { this.send({ id, method, params }) } catch (error) { finish(error) }
      if (signal?.aborted) abort()
    })
  }

  notify(method, params) {
    this.send({ method, ...(params === undefined ? {} : { params }) })
  }

  respond(id, result) { this.send({ id, result }) }

  rejectRequest(id, code = -32601) {
    this.send({ id, error: { code, message: 'Unsupported gateway operation' } })
  }

  async initialize(opts = {}) {
    const result = await this.request('initialize', {
      clientInfo: { name: 'vm2api_codex_cli', title: 'vm2api Codex CLI gateway', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, opts)
    this.notify('initialized')
    return result
  }

  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of [...this.pending.values()]) pending.finish(error)
    this.buffer = ''
    this.emit('failure', error)
  }

  close() {
    this.fail(codexCliError('codex_cli_closed'))
    this.child.stdin.end()
  }
}
