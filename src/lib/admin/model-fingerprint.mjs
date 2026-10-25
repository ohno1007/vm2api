/** Active behavioral fingerprints. No identity claims are taken from answer text or response.model. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import nodeFetch from 'node-fetch'
import { getVm } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { CODEX_USER_AGENT } from '../protocol/codex-models.mjs'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { ensureCodexCredential } from '../oauth/codex-credential-refresh.mjs'

// Inspired by LLMmap's fixed query/response classification. This is an independent
// small-sample classifier, not LLMmap's pretrained network or published accuracy.
export const FINGERPRINT_PROBES = Object.freeze([
  'Reply with only the next eight terms: 2, 3, 5, 9, 17, ...',
  'A box says "The prize is not in this box." The statement is false. Where is the prize? Answer in exactly one short sentence.',
  'Translate into natural Chinese, with no explanation: "The old man the boats."',
  'Write one sentence about a lighthouse using none of these words: light, sea, ship, tower. No introduction.',
  'Reply only with JSON containing keys "value" and "reason": Is 9.11 greater than 9.9? Keep the reason under twelve words.',
  'Give three distinct English words beginning with "qu", separated only by commas. No other text.',
  'Compress this into exactly six English words: A robot learns to garden after everyone has left Earth. No title.',
  '用一句不超过二十字的中文解释：为什么镜子交换左右而不交换上下？只写解释。',
])
export const FINGERPRINT_SPEC = crypto.createHash('sha256').update(JSON.stringify({
  version: 1, probes: FINGERPRINT_PROBES, reasoning: 'medium', instructions: '', tools: [], feature: 'char-trigram-cosine-v1',
})).digest('hex')
const TTL = 6 * 3600_000
const BASELINE_TTL = 7 * 86400_000
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const cached = new Map()
const services = new Map()
const fileOf = (dataDir) => path.join(dataDir || process.env.KIN_DATA_DIR || path.join(process.cwd(), 'data'), 'model-fingerprints.json')
const keyOf = (vmId, model) => `${vmId}:${model}`
const empty = () => ({ version: 1, baselines: [], results: [], jobs: [] })

function readStore(dataDir) {
  const file = fileOf(dataDir)
  try {
    const stat = fs.statSync(file)
    const hit = cached.get(file)
    if (hit?.mtime === stat.mtimeMs) return hit.value
    if (stat.size > 4 * 1024 * 1024) return empty()
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(value.baselines) || !Array.isArray(value.results)) return empty()
    cached.set(file, { mtime: stat.mtimeMs, value })
    return value
  } catch { return empty() }
}

function saveStore(dataDir, state) {
  const file = fileOf(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(tmp, file)
  cached.delete(file)
}

function feature(text) {
  const value = String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const out = new Float64Array(512)
  const chars = Array.from(`^${value}$`)
  for (let i = 0; i < chars.length; i++) {
    const gram = chars.slice(i, i + 3).join('')
    let h = 2166136261
    for (const c of gram) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0
    out[h % out.length] += 1
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1
  return Array.from(out, (v) => v / norm)
}
function mean(vectors) {
  return vectors[0].map((_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length)
}
function cosineDistance(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2 }
  return Math.max(0, Math.min(1, 1 - dot / (Math.sqrt(na * nb) || 1)))
}
function distance(a, b) {
  return a.reduce((s, v, i) => s + cosineDistance(v, b[i]), 0) / a.length
}
function vectors(samples) {
  return samples.map((rows) => mean(rows.map(feature)))
}

export function validSamples(samples, repeats = 3) {
  return Array.isArray(samples) && samples.length === FINGERPRINT_PROBES.length && samples.every((rows) =>
    Array.isArray(rows) && rows.length >= repeats && rows.every((s) => typeof s === 'string' && s.trim() && s.length <= 4000),
  )
}

export function classifyFingerprint(samples, baselines, expectedModel, now = Date.now()) {
  if (!validSamples(samples)) throw new Error('incomplete_probe_samples')
  const valid = baselines.filter((b) => b.spec === FINGERPRINT_SPEC && b.trusted === true &&
    now - Date.parse(b.createdAt) >= 0 && now - Date.parse(b.createdAt) <= BASELINE_TTL && validSamples(b.samples, 4))
  const target = vectors(samples)
  const candidates = valid.map((b) => {
    const center = vectors(b.samples)
    const splits = b.samples[0].map((_, n) => {
      const test = b.samples.map((rows) => feature(rows[n]))
      const train = vectors(b.samples.map((rows) => rows.filter((_, i) => i !== n)))
      return distance(test, train)
    })
    const radius = Math.min(0.45, Math.max(0.08, Math.max(...splits) + 0.08))
    const d = distance(target, center)
    return { model: b.model, baselineId: b.id, distance: d, similarity: 1 - d, radius,
      baselineAt: b.createdAt, source: b.source }
  }).sort((a, b) => a.distance - b.distance)
  const first = candidates[0]
  const second = candidates[1]
  let verdict = 'unknown', reason = 'no_trusted_baseline', identifiedModel = null
  // Require an expected-model baseline and at least one competing model before
  // making a model distinction. Similar outputs remain ambiguous.
  if (first) {
    if (!candidates.some((c) => c.model === expectedModel)) reason = 'expected_baseline_missing'
    else if (!second) reason = 'competitor_baseline_missing'
    else if (first.distance > first.radius) reason = 'outside_reference_distribution'
    else if (second.distance - first.distance < Math.max(0.05, first.radius * 0.5)) reason = 'models_not_separable'
    else {
      verdict = first.model === expectedModel ? 'consistent' : 'suspected_mismatch'
      reason = 'behavioral_nearest_reference'
      identifiedModel = first.model
    }
  }
  return { verdict, reason, identifiedModel, expectedModel, candidates, method: 'fixed-probe-char-trigram-v1',
    confidence: verdict === 'unknown' ? 'insufficient' : 'experimental', spec: FINGERPRINT_SPEC,
    note: '相似度不是身份概率；识别只覆盖已校准模型，不能证明模型权重或判定降智。' }
}

export function latestModelFingerprint(vmId, model, dataDir, now = Date.now()) {
  if (!vmId || !model) return null
  const state = readStore(dataDir)
  const result = state.results.find((r) => r.vmId === vmId && r.expectedModel === model && r.spec === FINGERPRINT_SPEC)
  if (!result) return null
  const { samples, candidates, ...summary } = result
  const currentIds = new Set(state.baselines.map((b) => b.id))
  const invalidated = candidates.some((c) => !currentIds.has(c.baselineId) || now - Date.parse(c.baselineAt) > BASELINE_TTL)
  return { ...summary, candidates, stale: invalidated || now > Date.parse(result.expiresAt) }
}

function modelId(value) {
  const s = String(value || '').trim()
  if (!/^gpt-[a-zA-Z0-9.\-]{1,90}$/.test(s)) throw new Error('invalid_model')
  return s
}

const promptBody = (model, prompt) => ({ model, instructions: '', input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
  stream: true, store: false, tools: [], reasoning: { effort: 'medium' } })

async function readAnswer(response) {
  if (!response.ok) throw new Error(`upstream_http_${response.status}`)
  const body = await response.text()
  if (body.length > 2 * 1024 * 1024) throw new Error('probe_response_too_large')
  let delta = '', complete = '', reported = null, done = false
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') continue
    let e; try { e = JSON.parse(data) } catch { continue }
    if (e.type === 'error' || e.type === 'response.failed') throw new Error('probe_response_failed')
    if (e.type === 'response.output_text.delta') delta += e.delta || ''
    if (e.type === 'response.completed') {
      done = true;reported = e.response?.model || null
      complete = (e.response?.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text || '').join('')
    }
  }
  const text = (complete || delta).trim()
  if (!done || !text || text.length > 4000) throw new Error('probe_response_incomplete')
  return { text, reported }
}

export function createModelFingerprintService({ cfg, targetFetch = globalThis.fetch, referenceFetch, now = () => Date.now() } = {}) {
  const dataDir = cfg.paths.data || path.join(cfg.paths.project, 'data')
  let state = structuredClone(readStore(dataDir))
  let active = null
  let cancel = null
  let monitor = null
  for (const job of state.jobs || []) if (job.status === 'running') { job.status = 'error';job.error = 'service_restarted' }
  const persist = () => saveStore(dataDir, state)
  const publicJob = (job) => job ? { ...job } : null
  const publicBaseline = ({ samples, ...b }) => ({ ...b, sampleCount: samples.reduce((n, v) => n + v.length, 0) })
  function status(vmId, model) {
    return { spec: FINGERPRINT_SPEC, probeCount: FINGERPRINT_PROBES.length,
      baselines: state.baselines.map(publicBaseline), jobs: (state.jobs || []).map(publicJob),
      result: latestModelFingerprint(vmId, model, dataDir, now()) }
  }
  async function sample({ vmId, model, kind }, signal, job) {
    const vm = getVm(cfg.paths.project, vmId)
    if (!vm || !isCodexVm(vm)) throw new Error('codex_slot_required')
    if (vm.schedulable === false) throw new Error('slot_resting')
    let request
    if (kind === 'baseline') {
      await ensureCodexCredential(cfg.paths.project, vmId)
      const a = readCodexAccounts(cfg.paths.project, vmId)[0]
      if (!a?.access_token || !a?.chatgpt_account_id) throw new Error('credential_missing')
      const proxyUrl = hostProxyUrlForVm(vm)
      const agent = proxyUrl ? createProxyAgent(proxyUrl) : undefined
      const fetcher = referenceFetch || nodeFetch
      request = (body) => fetcher(ENDPOINT, { method: 'POST', redirect: 'error', agent,
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        headers: { authorization: `Bearer ${a.access_token}`, 'chatgpt-account-id': a.chatgpt_account_id,
          'user-agent': CODEX_USER_AGENT, originator: 'codex_cli_rs', version: '0.160.0',
          'content-type': 'application/json', accept: 'text/event-stream', 'openai-beta': 'responses=experimental' },
        body: JSON.stringify(body) })
    } else {
      let host = String(cfg.host || '127.0.0.1')
      if (host === '0.0.0.0') host = '127.0.0.1'
      if (host === '::') host = '[::1]'
      const endpoint = `http://${host}:${cfg.port || 8787}/v1/responses`
      request = (body) => targetFetch(endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        headers: { authorization: `Bearer ${cfg.api_key}`, 'content-type': 'application/json',
          'x-kin-vm': vmId, 'x-kin-fingerprint-probe': '1', 'user-agent': CODEX_USER_AGENT }, body: JSON.stringify(body) })
    }
    const repeats = kind === 'baseline' ? 4 : 3
    const samples = FINGERPRINT_PROBES.map(() => [])
    const tasks = FINGERPRINT_PROBES.flatMap((prompt, i) => Array.from({ length: repeats }, () => ({ prompt, i })))
    let index = 0
    let stopped = false
    const worker = async () => {
      while (index < tasks.length && !stopped) {
        if (signal.aborted) throw new Error('probe_cancelled')
        if (getVm(cfg.paths.project, vmId)?.schedulable === false) throw new Error('slot_resting')
        const { prompt, i } = tasks[index++]
        const result = await readAnswer(await request(promptBody(model, prompt)))
        // The declared model only validates reference provenance, never predicts a target's identity.
        if (kind === 'baseline' && result.reported !== model && !String(result.reported || '').startsWith(`${model}-`)) throw new Error('reference_model_unconfirmed')
        samples[i].push(result.text)
        job.completed++;persist()
      }
    }
    const guarded = () => worker().catch((error) => { stopped = true;throw error })
    const workers = await Promise.allSettled([guarded(), guarded()])
    const failed = workers.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason
    return samples
  }
  function start({ vmId, model, kind = 'probe' }) {
    model = modelId(model)
    if (!['probe', 'baseline'].includes(kind)) throw new Error('invalid_kind')
    if (!getVm(cfg.paths.project, vmId)) throw new Error('slot_not_found')
    if (getVm(cfg.paths.project, vmId)?.schedulable === false) throw new Error('slot_resting')
    if (active) return { job: publicJob(active), busy: true }
    if (kind === 'probe' && state.baselines.filter((b) => b.spec === FINGERPRINT_SPEC && b.trusted &&
      now() - Date.parse(b.createdAt) < BASELINE_TTL).length < 2) throw new Error('two_trusted_baselines_required')
    const job = { id: crypto.randomUUID(), vmId, model, kind, status: 'running', completed: 0,
      total: FINGERPRINT_PROBES.length * (kind === 'baseline' ? 4 : 3), startedAt: new Date(now()).toISOString() }
    active = job;cancel = new AbortController()
    state.jobs = [job, ...(state.jobs || [])].slice(0, 10);persist()
    const controller = cancel
    const timer = setTimeout(() => controller.abort(), 15 * 60_000);timer.unref?.()
    void sample({ vmId, model, kind }, controller.signal, job).then((samples) => {
      if (controller.signal.aborted) throw new Error('probe_cancelled')
      const at = new Date(now()).toISOString()
      if (kind === 'baseline') {
        const baseline = { id: crypto.randomUUID(), model, spec: FINGERPRINT_SPEC, trusted: true,
          source: 'official-chatgpt-direct-tls', createdAt: at, vmId, samples }
        state.baselines = [baseline, ...state.baselines.filter((b) => b.model !== model)].slice(0, 12)
      } else {
        const result = { ...classifyFingerprint(samples, state.baselines, model, now()), vmId,
          sampleCount: job.total, testedAt: at, expiresAt: new Date(now() + TTL).toISOString() }
        state.results = [result, ...state.results.filter((r) => keyOf(r.vmId, r.expectedModel) !== keyOf(vmId, model))].slice(0, 200)
      }
      job.status = 'complete';job.finishedAt = at
    }).catch((error) => {
      job.status = 'error';job.error = /^[a-z_0-9]+$/.test(error.message) ? error.message : 'probe_failed'
      if (kind === 'probe') {
        const result = { verdict: 'error', reason: 'probe_failed', error: job.error, identifiedModel: null,
          expectedModel: model, vmId, spec: FINGERPRINT_SPEC, confidence: 'insufficient', candidates: [], sampleCount: job.completed,
          testedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 15 * 60_000).toISOString() }
        state.results = [result, ...state.results.filter((r) => keyOf(r.vmId, r.expectedModel) !== keyOf(vmId, model))].slice(0, 200)
      }
    })
      .finally(() => { clearTimeout(timer);active = null;cancel = null;persist() })
    return { job: publicJob(job), busy: false }
  }
  const tick = () => {
    if (active) {
      if (getVm(cfg.paths.project, active.vmId)?.schedulable === false) cancel?.abort()
      return
    }
    for (const result of state.results) {
      if (now() <= Date.parse(result.expiresAt)) continue
      const vm = getVm(cfg.paths.project, result.vmId)
      if (!vm || !isCodexVm(vm) || vm.schedulable === false || !['running', 'ok'].includes(vm.status)) continue
      if (Number(vm.temp_unschedulable_until || 0) > now() || result.error === 'probe_cancelled') continue
      try { start({ vmId: result.vmId, model: result.expectedModel });break } catch {}
    }
  }
  return { status, start, cancel: () => { cancel?.abort();return { ok: true } },
    startMonitor: () => { if (!monitor) { monitor = setInterval(tick, 60_000);monitor.unref?.();queueMicrotask(tick) } },
    stop: () => { clearInterval(monitor);monitor = null;cancel?.abort() },
  }
}

export function modelFingerprintService(cfg) {
  const key = fileOf(cfg.paths.data || path.join(cfg.paths.project, 'data'))
  if (!services.has(key)) services.set(key, createModelFingerprintService({ cfg }))
  return services.get(key)
}
