import { ensureCodexCli, codexCliModels } from './codex-cli-supervisor.mjs'
import { streamCodexCliResponse } from '../protocol/codex-cli-responses.mjs'
import { CODEX_CLI_GUEST_WORKDIR } from '../vm/codex-cli-config.mjs'
import { CodexCliHistory, codexCliHistoryOwner } from '../protocol/codex-cli-history.mjs'
import path from 'node:path'
import { syncCodexCliAuth } from '../vm/codex-cli-auth.mjs'
import { needsNativeCodexResponse, streamNativeCodexResponse } from './codex-cli-native.mjs'

const history = new CodexCliHistory()

export async function streamCodexCli(opts = {}) {
  let runtime
  let acquired = false
  try {
    const original = opts.originalBody || opts.envelope?.body || opts.body || {}
    for (const key of ['max_output_tokens', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'logprobs', 'top_logprobs', 'seed', 'stop']) {
      if (original[key] != null) return failure(`codex_cli_unsupported_${key}`, 400)
    }
    if (original.n != null && original.n !== 1) return failure('codex_cli_unsupported_n', 400)
    const ready = await ensureCodexCli(opts.exec)
    if (!ready.ok) return failure(ready.reason, ready.reason === 'slot_resting' ? 409 : 503)
    runtime = ready.runtime
    const limit = Math.max(1, Math.min(16, Number(opts.exec.vm.codex_cli?.parallel) || 2))
    if (runtime.inFlight >= limit) return failure('no_capacity', 503)
    runtime.inFlight++
    acquired = true
    const { models, requirements } = await codexCliModels(runtime)
    const owner = codexCliHistoryOwner(opts.reqHeaders)
    const body = history.expand(opts.envelope?.body || opts.body, owner)
    const model = models.find((m) => m.id === body.model || m.model === body.model)
    if (!model) return failure('model_not_allowed', 400)
    const invoke = needsNativeCodexResponse(body) ? streamNativeCodexResponse : streamCodexCliResponse
    const result = await invoke({ ...opts, runtime, rpc: runtime.rpc, body, vm: opts.exec.vm, modelInfo: model, requirements, cwd: CODEX_CLI_GUEST_WORKDIR })
    history.remember(body, result.body, owner, opts.responseStore !== false)
    return result
  } catch (error) {
    return failure(error.code || 'codex_cli_failed', error.status || 502)
  } finally {
    if (acquired) {
      runtime.inFlight = Math.max(0, runtime.inFlight - 1)
      try { syncCodexCliAuth(opts.exec.projectRoot || path.resolve(opts.exec.homeDir, '../../..'), opts.exec.vm.id) } catch {}
    }
  }
}

function failure(code, status) {
  return { ok: false, status, committed: false, via: 'codex-cli', terminalState: 'error', body: { error: { type: status === 400 ? 'invalid_request_error' : 'api_error', code, message: code } } }
}
