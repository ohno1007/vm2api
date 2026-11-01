import { randomUUID } from 'node:crypto'
import { codexCliError } from '../transport/codex-app-server-rpc.mjs'
import { CodexCliUsageMeter } from './codex-cli-usage.mjs'
import { selectCodexCliTier } from './codex-cli-tier.mjs'
import { renderCodexCliPersona } from './codex-cli-persona.mjs'
import { prepareCodexCliTools, codexCliToolCall } from './codex-cli-tools.mjs'

function invalid(code) { throw codexCliError(code, 400) }

function userInput(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return invalid('invalid_input')
  return content.map((part) => {
    if (part?.type === 'input_text' && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part?.type === 'input_image' && typeof part.image_url === 'string') {
      if (!/^(https?:\/\/|data:image\/)/i.test(part.image_url)) return invalid('unsupported_image_url')
      return { type: 'image', url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) }
    }
    return invalid('unsupported_input_content')
  })
}

/** Keep history structured; never flatten assistant/tool roles into a user prompt. */
export function prepareCodexCliRequest(body = {}) {
  if (typeof body.model !== 'string' || !body.model.trim()) return invalid('model_required')
  if (body.previous_response_id) return invalid('previous_response_id_requires_stored_history')
  if (body.background === true) return invalid('background_not_supported')
  if (body.tool_choice != null && !['auto', 'none'].includes(body.tool_choice)) return invalid('unsupported_tool_choice')
  const tools = body.tool_choice === 'none' ? [] : (body.tools || [])
  const toolAdapter = prepareCodexCliTools(tools)
  const items = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : Array.isArray(body.input) ? structuredClone(body.input) : invalid('invalid_input')
  if (!items.length) return invalid('input_required')
  for (let index = 0; index < items.length; index++) {
    const item = items[index] = toolAdapter.historyItem(items[index])
    if (!item || typeof item !== 'object' || !['message', 'function_call', 'function_call_output', 'web_search_call', 'reasoning', undefined].includes(item.type)) {
      return invalid('unsupported_input_item')
    }
    if (item.type == null) item.type = 'message'
    if (item.type === 'message') {
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) return invalid('invalid_input_role')
      // The CLI history serializer drops system-role items. Its native instruction
      // role is developer; preserve the text and position using that role.
      if (item.role === 'system') item.role = 'developer'
      if (typeof item.content === 'string') {
        item.content = [{ type: item.role === 'assistant' ? 'output_text' : 'input_text', text: item.content }]
      }
    }
  }
  const last = items.at(-1)
  const input = last.type === 'message' && last.role === 'user' ? userInput(items.pop().content) : []
  return { history: items, input, dynamicTools: toolAdapter.dynamicTools, toolAdapter }
}

/** One ephemeral thread per API request; the official app-server process is shared per slot. */
export async function streamCodexCliResponse({
  rpc, body, modelInfo, requirements, cwd, routing, vm, onEvent = async () => {}, signal,
  timeoutMs = 600_000, idleTimeoutMs = 180_000, maxBufferedBytes = 16 * 1024 * 1024,
} = {}) {
  const persona = renderCodexCliPersona({ body, routing, vm, cwd })
  const prepared = prepareCodexCliRequest(persona.body)
  const selected = selectCodexCliTier(modelInfo, body.service_tier, requirements)
  if (signal?.aborted) throw codexCliError('client_cancelled', 499)
  const startedAt = Date.now()
  const meter = new CodexCliUsageMeter()
  const response = {
    id: `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: Math.floor(startedAt / 1000),
    status: 'in_progress', model: body.model, output: [], usage: null, service_tier: null,
    metadata: { gateway_requested_service_tier: selected.serviceTier, gateway_tier_source: 'cli_configuration' },
    error: null, incomplete_details: null,
  }
  const itemMap = new Map()
  let threadId, turnId, firstTokenAt, sequence = 0, queue = Promise.resolve(), buffered = 0
  let finished = false, created = false, outputError = null, turnResult = null, interrupting = false
  let resolveDone, rejectDone, overallTimer, idleTimer
  let resolveStopped
  const stopped = new Promise(resolve => { resolveStopped = resolve })
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  // A transport failure can arrive during an awaited RPC, before we await done.
  done.catch(() => {})
  const finish = (error, turn) => {
    if (finished) return
    finished = true
    clearTimeout(overallTimer); clearTimeout(idleTimer)
    error ? rejectDone(error) : resolveDone(turn)
  }
  const emit = (type, data = {}) => {
    if (outputError) return
    const line = `data: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`
    buffered += Buffer.byteLength(line)
    if (buffered > maxBufferedBytes) {
      outputError = codexCliError('client_backpressure', 503)
      finish(outputError)
      return
    }
    queue = queue.then(() => onEvent(line)).catch((error) => {
      outputError = error
      finish(codexCliError('client_disconnected', 499))
    }).finally(() => { buffered -= Buffer.byteLength(line) })
  }
  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => finish(codexCliError('codex_cli_idle_timeout', 504)), idleTimeoutMs)
    idleTimer.unref?.()
  }
  const ensureMessage = (id) => {
    if (itemMap.has(id)) return itemMap.get(id)
    const item = { id, type: 'message', status: 'in_progress', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] }
    const record = { item, index: response.output.length, done: false }
    response.output.push(item); itemMap.set(id, record)
    emit('response.output_item.added', { output_index: record.index, item: { ...item, content: [] } })
    emit('response.content_part.added', { item_id: id, output_index: record.index, content_index: 0, part: item.content[0] })
    return record
  }
  const textDelta = (id, delta) => {
    if (!delta) return
    firstTokenAt ??= Date.now()
    const row = ensureMessage(id)
    row.item.content[0].text += delta
    emit('response.output_text.delta', { item_id: id, output_index: row.index, content_index: 0, delta })
  }
  const completeMessage = (id, text) => {
    const row = ensureMessage(id)
    if (row.done) return
    const have = row.item.content[0].text
    if (typeof text === 'string' && text !== have) {
      if (!text.startsWith(have)) throw codexCliError('codex_cli_text_mismatch')
      textDelta(id, text.slice(have.length))
    }
    row.item.status = 'completed'; row.done = true
    emit('response.output_text.done', { item_id: id, output_index: row.index, content_index: 0, text: row.item.content[0].text })
    emit('response.content_part.done', { item_id: id, output_index: row.index, content_index: 0, part: row.item.content[0] })
    emit('response.output_item.done', { output_index: row.index, item: row.item })
  }
  const reasoningPart = (id, index = 0) => {
    if (!Number.isInteger(index) || index < 0 || index > 256) throw codexCliError('invalid_reasoning_index')
    let row = itemMap.get(id)
    if (!row) {
      const item = { id, type: 'reasoning', summary: [] }
      row = { item, index: response.output.length, done: false }
      response.output.push(item); itemMap.set(id, row)
      emit('response.output_item.added', { output_index: row.index, item })
    }
    if (!row.item.summary[index]) {
      row.item.summary[index] = { type: 'summary_text', text: '' }
      emit('response.reasoning_summary_part.added', { item_id: id, output_index: row.index, summary_index: index, part: row.item.summary[index] })
    }
    return row
  }
  const completeReasoning = (item) => {
    if (!item.summary?.length && !itemMap.has(item.id)) return
    const row = reasoningPart(item.id)
    if (row.done) return
    for (const [index, text] of (item.summary || []).entries()) {
      reasoningPart(item.id, index)
      const have = row.item.summary[index].text
      if (text.startsWith(have) && text.length > have.length) {
        emit('response.reasoning_summary_text.delta', { item_id: item.id, output_index: row.index, summary_index: index, delta: text.slice(have.length) })
        row.item.summary[index].text = text
      }
    }
    for (const [index, part] of row.item.summary.entries()) {
      emit('response.reasoning_summary_text.done', { item_id: item.id, output_index: row.index, summary_index: index, text: part.text })
      emit('response.reasoning_summary_part.done', { item_id: item.id, output_index: row.index, summary_index: index, part })
    }
    row.done = true
    emit('response.output_item.done', { output_index: row.index, item: row.item })
  }
  const onNotification = (message) => {
    const p = message.params || {}
    if (p.threadId !== threadId || (turnId && p.turnId && p.turnId !== turnId)) return
    if (message.method === 'turn/completed') resolveStopped(p.turn)
    if (message.method === 'thread/tokenUsage/updated') {
      try { meter.observe(p.tokenUsage) } catch (error) { finish(error) }
    }
    if (finished) return
    touch()
    try {
      if (message.method === 'turn/started') turnId = p.turn?.id || turnId
      if (message.method === 'item/agentMessage/delta') textDelta(p.itemId, p.delta)
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage') completeMessage(p.item.id, p.item.text)
      if (message.method === 'item/reasoning/summaryPartAdded') reasoningPart(p.itemId, p.summaryIndex)
      if (message.method === 'item/reasoning/summaryTextDelta') {
        const row = reasoningPart(p.itemId, p.summaryIndex)
        row.item.summary[p.summaryIndex].text += p.delta
        emit('response.reasoning_summary_text.delta', { item_id: p.itemId, output_index: row.index, summary_index: p.summaryIndex, delta: p.delta })
      }
      if (message.method === 'item/completed' && p.item?.type === 'reasoning') completeReasoning(p.item)
      if (['item/started', 'item/completed'].includes(message.method) && p.item?.type === 'webSearch') {
        let row = itemMap.get(p.item.id)
        if (!row) {
          const item = { id: p.item.id, type: 'web_search_call', status: 'in_progress', action: p.item.action || { type: 'search', query: p.item.query } }
          row = { item, index: response.output.length, done: false }
          itemMap.set(item.id, row); response.output.push(item)
          emit('response.output_item.added', { output_index: row.index, item: { ...item } })
          emit('response.web_search_call.in_progress', { item_id: item.id, output_index: row.index })
        }
        if (message.method === 'item/completed' && !row.done) {
          row.item.status = 'completed'; row.item.action = p.item.action || row.item.action; row.done = true
          emit('response.web_search_call.completed', { item_id: row.item.id, output_index: row.index })
          emit('response.output_item.done', { output_index: row.index, item: row.item })
        }
      }
      if (message.method === 'model/rerouted') finish(codexCliError('model_rerouted', 502))
      if (message.method === 'turn/completed') finish(null, p.turn)
    } catch (error) { finish(error) }
  }
  const onServerRequest = (message) => {
    const p = message.params || {}
    if (finished || p.threadId !== threadId || (turnId && p.turnId && p.turnId !== turnId)) return
    if (message.method !== 'item/tool/call' || !prepared.toolAdapter.lookup(p.namespace, p.tool)) {
      rpc.rejectRequest(message.id)
      return finish(codexCliError('unsupported_cli_tool_request'))
    }
    touch()
    if (!itemMap.has(p.callId)) {
      let item
      try { item = codexCliToolCall(prepared.toolAdapter, p, `fc_${randomUUID().replaceAll('-', '')}`) }
      catch (error) { rpc.rejectRequest(message.id); return finish(error) }
      const row = { item, index: response.output.length, done: true }
      itemMap.set(p.callId, row); response.output.push(item)
      const field = item.type === 'custom_tool_call' ? 'input' : 'arguments'
      const event = item.type === 'custom_tool_call' ? 'custom_tool_call_input' : 'function_call_arguments'
      emit('response.output_item.added', { output_index: row.index, item: { ...item, status: 'in_progress', [field]: '' } })
      emit(`response.${event}.delta`, { item_id: item.id, output_index: row.index, delta: item[field] })
      emit(`response.${event}.done`, { item_id: item.id, output_index: row.index, [field]: item[field] })
      emit('response.output_item.done', { output_index: row.index, item })
    }
    // API callers execute their tools. Cancel this CLI turn without fabricating a tool result.
    // Defer one tick so parallel tool requests already in the frame batch are collected.
    if (!interrupting) {
      interrupting = true
      setImmediate(() => {
        if (!finished) rpc.request('turn/interrupt', { threadId, turnId: p.turnId }, { timeoutMs: 5000 }).catch(finish)
      })
    }
  }
  const onFailure = (error) => finish(error)
  const onAbort = () => finish(codexCliError('client_cancelled', 499))
  try {
    const start = await rpc.request('thread/start', {
      model: body.model, serviceTier: selected.serviceTier, cwd, ephemeral: true,
      approvalPolicy: 'never', sandbox: 'read-only', allowProviderModelFallback: false,
      baseInstructions: persona.baseInstructions,
      dynamicTools: prepared.dynamicTools,
      config: prepared.toolAdapter.config,
      ...(typeof body.instructions === 'string' ? { developerInstructions: body.instructions } : {}),
    }, { signal })
    threadId = start.thread.id
    if (start.model !== body.model) throw codexCliError('model_rerouted')
    if ((start.serviceTier || 'default') !== selected.serviceTier) throw codexCliError('service_tier_rerouted')
    rpc.on('notification', onNotification); rpc.on('serverRequest', onServerRequest); rpc.on('failure', onFailure)
    signal?.addEventListener('abort', onAbort, { once: true })
    overallTimer = setTimeout(() => finish(codexCliError('codex_cli_timeout', 504)), timeoutMs)
    overallTimer.unref?.(); touch()
    if (prepared.history.length) await rpc.request('thread/inject_items', { threadId, items: prepared.history }, { signal })
    emit('response.created', { response }); created = true
    const params = { threadId, input: prepared.input, serviceTier: selected.serviceTier }
    if (body.reasoning?.effort) params.effort = body.reasoning.effort
    if (body.reasoning?.summary) params.summary = body.reasoning.summary
    if (body.text?.format?.type === 'json_schema') params.outputSchema = body.text.format.schema
    const started = await rpc.request('turn/start', params, { signal })
    turnId ||= started.turn?.id
    if (signal?.aborted) onAbort()
    turnResult = await done
    const hasTools = response.output.some((item) => ['function_call', 'custom_tool_call'].includes(item.type))
    if (turnResult.status !== 'completed' && !(hasTools && interrupting && turnResult.status === 'interrupted')) {
      const code = typeof turnResult.error?.codexErrorInfo === 'string' ? turnResult.error.codexErrorInfo : 'codex_cli_turn_failed'
      const status = ['usageLimitExceeded', 'rateLimitExceeded'].includes(code) ? 429 : code === 'unauthorized' ? 401 : code === 'badRequest' || code === 'contextWindowExceeded' ? 400 : 502
      throw codexCliError(code, status)
    }
    for (const row of itemMap.values()) if (row.item.type === 'message') completeMessage(row.item.id)
    response.status = 'completed'; response.usage = meter.value()
    emit('response.completed', { response })
    await queue
    if (outputError) throw outputError
    return {
      ok: true, status: 200, body: response, usage: response.usage, model: response.model,
      via: 'codex-cli', terminalState: 'verified', committed: true,
      requestedServiceTier: selected.serviceTier,
      ttftMs: firstTokenAt == null ? null : firstTokenAt - startedAt,
      generationMs: turnResult.durationMs ?? null,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    finish(error)
    if (threadId && turnId && !turnResult) {
      await rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {})
      let timer
      turnResult = await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000) })])
      clearTimeout(timer)
    }
    const apiError = { type: error.status === 400 ? 'invalid_request_error' : 'api_error', code: error.code || 'codex_cli_failed', message: error.code || 'codex_cli_failed' }
    response.status = 'failed'; response.error = apiError; response.usage = meter.value()
    if (created && !signal?.aborted && !outputError) emit('response.failed', { response })
    await queue
    return { ok: false, status: error.status || 502, body: { error: apiError, service_tier: response.service_tier }, usage: response.usage, generationMs: turnResult?.durationMs ?? null, via: 'codex-cli', terminalState: 'error', committed: created }
  } finally {
    clearTimeout(overallTimer); clearTimeout(idleTimer)
    rpc.off('notification', onNotification); rpc.off('serverRequest', onServerRequest); rpc.off('failure', onFailure)
    signal?.removeEventListener('abort', onAbort)
    if (threadId) await rpc.request('thread/unsubscribe', { threadId }, { timeoutMs: 5000 }).catch(() => {})
  }
}
