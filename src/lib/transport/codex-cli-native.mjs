import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { slotExecArgv } from '../vm/slot-exec.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { CODEX_CLI_GUEST_HOME, CODEX_CLI_VERSION, canRunCodexCli } from '../vm/codex-cli-config.mjs'
import { getVm } from '../vm/vm-registry.mjs'
import { codexCliTokenNeedsRefresh } from '../vm/codex-cli-auth.mjs'
import { renderCodexCliPersona } from '../protocol/codex-cli-persona.mjs'
import { selectCodexCliTier } from '../protocol/codex-cli-tier.mjs'
import { codexCliError } from './codex-app-server-rpc.mjs'

// Only the guest reads the CLI credential. No caller-controlled URL or headers.
// stdin stays open while serving: losing the gateway kills the guest worker.
export const CODEX_NATIVE_WORKER = String.raw`
import json,os,sys,threading,urllib.request,urllib.error
job=json.loads(sys.stdin.readline())
def disconnect():
 sys.stdin.read();os._exit(0)
threading.Thread(target=disconnect,daemon=True).start()
def emit(value):
 print(json.dumps(value,separators=(',',':')),flush=True)
try:
 with open(job['auth']) as f:tokens=json.load(f).get('tokens',{})
 if not tokens.get('access_token'):raise ValueError('missing_auth')
 headers={'Authorization':'Bearer '+tokens['access_token'],'Content-Type':'application/json','Accept':'text/event-stream','User-Agent':'codex_cli_rs/'+job['version'],'originator':'codex_cli_rs'}
 if tokens.get('account_id'):headers['ChatGPT-Account-Id']=tokens['account_id']
 request=urllib.request.Request('https://chatgpt.com/backend-api/codex/responses',data=json.dumps(job['body']).encode(),headers=headers)
 # Egress is enforced by the slot network, never by inherited host proxy vars.
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 try:response=opener.open(request,timeout=job['idle_seconds'])
 except urllib.error.HTTPError as error:
  raw=error.read(1048576)
  try:body=json.loads(raw)
  except Exception:body={'error':{'code':'upstream_http_error','message':'Upstream HTTP '+str(error.code)}}
  emit({'status':error.code,'body':body});sys.exit(0)
 with response:
  headers={k.lower():v for k,v in response.headers.items() if k.lower().startswith('x-codex-') or k.lower()=='retry-after'}
  emit({'status':response.status,'headers':headers})
  data=[]
  for raw in response:
   line=raw.decode('utf-8').rstrip('\r\n')
   if line.startswith('data:'):data.append(line[5:].lstrip(' '))
   elif not line and data:
    joined='\n'.join(data);data=[]
    if joined=='[DONE]':break
    emit({'event':json.loads(joined)})
  if data and '\n'.join(data)!='[DONE]':emit({'event':json.loads('\n'.join(data))})
except Exception:
 emit({'failure':'codex_native_transport_error'})
`

export function needsNativeCodexResponse(body = {}) {
  return !!body.tools?.length || (body.tool_choice != null && body.tool_choice !== 'auto') ||
    body.parallel_tool_calls === false || (Array.isArray(body.input) && body.input.some(i => i?.type && !['message', 'reasoning'].includes(i.type)))
}

export function prepareNativeCodexBody({ body, modelInfo, requirements, routing, vm }) {
  if (!body || typeof body.model !== 'string' || !body.model.trim()) throw codexCliError('model_required', 400)
  if (body.background) throw codexCliError('background_not_supported', 400)
  if (body.tools != null && !Array.isArray(body.tools)) throw codexCliError('invalid_tools', 400)
  const selected = selectCodexCliTier(modelInfo, body.service_tier, requirements)
  const persona = renderCodexCliPersona({ body, routing, vm })
  const input = typeof persona.body.input === 'string' ? [{ role: 'user', content: persona.body.input }] : persona.body.input
  if (!Array.isArray(input) || !input.length) throw codexCliError('input_required', 400)
  const result = { ...persona.body, input, instructions: [persona.baseInstructions, persona.body.instructions].filter(Boolean).join('\n\n'),
    service_tier: selected.serviceTier, stream: true, store: false }
  if (result.tools) result.tools = result.tools.map(tool => tool?.type === 'namespace' && tool.description == null ? { ...tool, description: '' } : tool)
  delete result.previous_response_id
  return result
}

/** Preserve all Responses items/events, including hosted tools, CFGs and future types. */
export async function collectNativeCodexResponse(source, { onEvent = async () => {}, signal, requestedServiceTier, maxFrameBytes = 64 * 1024 * 1024 } = {}) {
  let pending = '', status = 502, headers = {}, response = null, committed = false, firstTokenAt = null, firstByteAt = null
  const decoder = new StringDecoder('utf8'), output = new Map()
  const start = Date.now()
  try {
    for await (const chunk of source) {
      if (signal?.aborted) throw codexCliError('client_cancelled', 499)
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (Buffer.byteLength(pending) > maxFrameBytes) throw codexCliError('upstream_frame_too_large', 502)
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1)
        if (!line) continue
        const frame = JSON.parse(line)
        if (frame.failure) throw codexCliError(frame.failure, 502)
        if (frame.status) {
          status = frame.status; headers = frame.headers || {}
          if (status !== 200) {
            const body = frame.body?.error ? frame.body : { error: { type: status < 500 ? 'invalid_request_error' : 'api_error',
              code: /unsupported tool type/i.test(frame.body?.detail || '') ? 'upstream_unsupported_tool' : 'upstream_http_error', message: typeof frame.body?.detail === 'string' ? frame.body.detail : `Upstream HTTP ${status}` } }
            return { ok: false, status, headers, body, committed, via: 'codex-cli', terminalState: 'error' }
          }
        }
        const event = frame.event
        if (!event) continue
        firstByteAt ??= Date.now()
        if (event.type?.endsWith('.delta')) firstTokenAt ??= Date.now()
        if (event.type === 'response.output_item.done' && Number.isInteger(event.output_index)) output.set(event.output_index, event.item)
        if (event.response && ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
          response = event.response
          if (requestedServiceTier) response.metadata = { ...response.metadata, gateway_requested_service_tier: requestedServiceTier,
            gateway_tier_source: 'upstream_response', gateway_tier_mismatch: !!response.service_tier && response.service_tier !== requestedServiceTier }
          // Codex often omits output from its terminal event; retain emitted items.
          if (!response.output?.length && output.size) response.output = [...output.entries()].sort((a, b) => a[0] - b[0]).map(([,item]) => item)
        }
        if (event.type === 'error') response = { status: 'failed', error: event.error || { code: event.code, message: event.message } }
        committed = true
        await onEvent(`data: ${JSON.stringify(event)}\n\n`)
      }
    }
    if (!response || pending.trim()) throw codexCliError('upstream_incomplete_stream', 502)
    return { ok: response.status === 'completed', status: response.status === 'failed' ? 502 : status, headers, body: response,
      usage: response.usage || null, committed, via: 'codex-cli', terminalState: response.status,
      firstTokenAt, firstByteAt, ttftMs: firstTokenAt == null ? null : firstTokenAt - start, generationMs: Date.now() - start }
  } catch (error) {
    const code = error.code || 'codex_native_transport_error'
    if (committed) { try { await onEvent(`data: ${JSON.stringify({ type: 'error', error: { code, message: code } })}\n\n`) } catch {} }
    return { ok: false, status: error.status || 502, headers, committed, via: 'codex-cli', terminalState: 'error',
      usage: response?.usage || null, body: { error: { code, message: code } } }
  }
}

export async function streamNativeCodexResponse(opts) {
  const { exec, runtime, signal, timeoutMs = 600_000, idleTimeoutMs = 180_000 } = opts
  const root = exec.projectRoot || path.resolve(exec.homeDir, '../../..')
  const body = prepareNativeCodexBody({ ...opts, vm: exec.vm })
  if (signal?.aborted) throw codexCliError('client_cancelled', 499)
  if (!canRunCodexCli(getVm(root, exec.vm.id))) throw codexCliError('slot_resting', 409)
  // Official CLI owns refresh and account state; never independently rotate OAuth.
  if (codexCliTokenNeedsRefresh(root, exec.vm.id)) {
    if (!runtime.nativeRefresh) runtime.nativeRefresh = runtime.rpc.request('account/read', { refreshToken: true }).finally(() => { runtime.nativeRefresh = null })
    await runtime.nativeRefresh
  }
  if (!canRunCodexCli(getVm(root, exec.vm.id))) throw codexCliError('slot_resting', 409)
  const host = slotHost(exec.vm)
  const child = spawn('docker', slotExecArgv(exec.vm, ['python3', '-u', '-c', CODEX_NATIVE_WORKER],
    { user: host.execUser(exec.vm), interactive: true }), { env: host.dockerEnv() || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.resume() // Never expose guest credential/errors through logs.
  child.stdin.on('error', () => {})
  child.on('error', error => child.stdout.destroy(error))
  runtime.nativeChildren ??= new Set()
  runtime.nativeChildren.add(child)
  let timedOut = false
  const stop = () => { child.stdin.end(); child.kill('SIGTERM') }
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  signal?.addEventListener('abort', stop, { once: true })
  child.stdin.write(JSON.stringify({ auth: CODEX_CLI_GUEST_HOME + '/auth.json', version: CODEX_CLI_VERSION,
    body, idle_seconds: Math.max(1, idleTimeoutMs / 1000) }) + '\n')
  try {
    const result = await collectNativeCodexResponse(child.stdout, { ...opts, requestedServiceTier: body.service_tier })
    result.requestedServiceTier = body.service_tier
    if (timedOut || signal?.aborted) { result.ok = false; result.status = timedOut ? 504 : 499; result.terminalState = 'error'; result.body = { error: { code: timedOut ? 'codex_native_timeout' : 'client_cancelled' } } }
    return result
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); runtime.nativeChildren.delete(child); stop() }
}
