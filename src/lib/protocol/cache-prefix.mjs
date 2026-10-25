/**
 * Detects when a continuing conversation stops being a prefix of its previous
 * turn. Anthropic only reads cache up to the first changed byte, so a break
 * here is a full rewrite upstream even when the request succeeds.
 *
 * Marker movement is not a history break: cache_control is stripped before
 * hashing. Image bytes and prompt text are never stored.
 */
import { createHash } from 'node:crypto'
import { listCacheMarkers, normalizeCacheTtl } from './cache-ttl.mjs'

const SESSION_LIMIT = 10_000
/** Longest cache TTL; an older turn cannot be read anyway. */
const SESSION_IDLE_MS = 60 * 60_000
const sessions = new Map()
const IMAGE_TYPES = new Set(['image', 'input_image', 'image_url'])

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16)
}

function firstDivergence(previous, current) {
  const shared = Math.min(previous.length, current.length)
  for (let i = 0; i < shared; i++) {
    if (previous[i] !== current[i]) return i
  }
  return previous.length > current.length ? shared : -1
}

function withoutCacheControl(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'cache_control') continue
    out[key] = withoutCacheControl(nested)
  }
  return out
}
function imageMeta(block) {
  const source = block?.source && typeof block.source === 'object' ? block.source : block
  const data = source?.data || source?.base64 || block?.data || ''
  const url = source?.url || block?.image_url?.url || block?.url || null
  return {
    type: block?.type || 'image',
    media_type: source?.media_type || block?.media_type || null,
    url: Boolean(url),
    bytes: typeof data === 'string' ? data.length : 0,
    digest: typeof data === 'string' && data ? digest(data) : url ? digest(url) : null,
  }
}

function partKind(block) {
  if (typeof block === 'string') return { kind: 'text', digest: digest(block) }
  if (!block || typeof block !== 'object') return { kind: 'structure', digest: digest(block) }
  const type = block.type
  if (IMAGE_TYPES.has(type) || block.source || block.image_url) {
    return { kind: 'image', digest: digest(imageMeta(block)) }
  }
  if (type === 'text' || type === 'input_text') return { kind: 'text', digest: digest(block.text || '') }
  return { kind: 'structure', digest: digest(withoutCacheControl(block)) }
}

// Same official reminder as outbound-attempt.mjs. Detector only: a tool result
// may legally contain this string, so nothing here rewrites it.
const VOLATILE_CONTEXT_BUDGET = /<total_tokens>\d+ tokens left<\/total_tokens>/g
const CONTEXT_BUDGET_PLACEHOLDER = '<total_tokens>0 tokens left</total_tokens>'

function stringStamp(text) {
  const stamp = { t: 's', n: text.length, d: digest(text) }
  if (!text.includes('<total_tokens>')) return stamp
  stamp.total_tokens = true
  stamp.norm = digest(text.replace(VOLATILE_CONTEXT_BUDGET, CONTEXT_BUDGET_PLACEHOLDER))
  return stamp
}

function normalizeCounters(value) {
  if (typeof value === 'string') {
    return value.includes('<total_tokens>') ? value.replace(VOLATILE_CONTEXT_BUDGET, CONTEXT_BUDGET_PLACEHOLDER) : value
  }
  if (Array.isArray(value)) return value.map(normalizeCounters)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      if (key === 'cache_control') continue
      out[key] = normalizeCounters(value[key])
    }
    return out
  }
  return value
}

function valueStamp(value, depth = 0) {
  if (typeof value === 'string') return stringStamp(value)
  if (typeof value === 'number' || typeof value === 'boolean') return { t: typeof value, v: value, d: digest(value) }
  if (value == null) return { t: 'null', d: digest(null) }
  if (Array.isArray(value)) {
    const stamp = { t: 'a', n: value.length, d: digest(value), norm: digest(normalizeCounters(value)) }
    if (depth < 3) stamp.items = value.slice(0, 6).map((item) => valueStamp(item, depth + 1))
    return stamp
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => key !== 'cache_control')
    const stamp = { t: 'o', keys, d: digest(value), norm: digest(normalizeCounters(value)) }
    if (depth < 3) {
      stamp.fields = {}
      for (const key of keys) stamp.fields[key] = valueStamp(value[key], depth + 1)
    }
    return stamp
  }
  return { t: typeof value }
}

function stampDelta(prev, next) {
  if (!prev || !next) return { change: 'missing' }
  if (prev.d && prev.d === next.d) return null
  if (prev.norm && next.norm && prev.norm === next.norm) {
    return { change: 'counter_only', prev_n: prev.n, next_n: next.n }
  }
  if (prev.t !== next.t) return { change: 'type', prev_t: prev.t, next_t: next.t }
  if (prev.t === 's') {
    if (prev.norm && next.norm && prev.norm === next.norm) {
      return { change: 'counter_only', prev_n: prev.n, next_n: next.n }
    }
    return {
      change: prev.n === next.n ? 'value' : 'length',
      prev_n: prev.n,
      next_n: next.n,
      ...(prev.total_tokens || next.total_tokens ? { total_tokens: true } : {}),
    }
  }
  if (prev.t === 'number' || prev.t === 'boolean' || prev.t === 'null') {
    return prev.v === next.v ? null : { change: 'value' }
  }
  if (prev.t === 'a') {
    if (prev.n !== next.n) return { change: 'length', prev_n: prev.n, next_n: next.n }
    const changed = []
    const seen = Math.min(prev.items?.length || 0, next.items?.length || 0)
    for (let i = 0; i < seen; i++) {
      const delta = stampDelta(prev.items[i], next.items[i])
      if (delta) changed.push({ index: i, ...delta })
    }
    if (seen < prev.n) {
      return {
        change: 'unknown',
        capped: true,
        prev_n: prev.n,
        next_n: next.n,
        ...(changed.length ? { sampled: changed.slice(0, 8) } : {}),
      }
    }
    if (!changed.length) return { change: 'value', prev_n: prev.n, next_n: next.n }
    return { change: 'items', prev_n: prev.n, next_n: next.n, changed: changed.slice(0, 8) }
  }
  if (prev.t === 'o') {
    if (!prev.fields || !next.fields) return { change: 'unknown', capped: true }
    const added = next.keys.filter((key) => !prev.keys.includes(key))
    const removed = prev.keys.filter((key) => !next.keys.includes(key))
    const keyOrder = !added.length && !removed.length && prev.keys.join('\0') !== next.keys.join('\0')
    const changed = []
    for (const key of prev.keys) {
      if (!Object.prototype.hasOwnProperty.call(next.fields, key)) continue
      const delta = stampDelta(prev.fields[key], next.fields[key])
      if (delta) changed.push({ key, ...delta })
    }
    if (!added.length && !removed.length && !keyOrder && !changed.length) {
      return { change: 'unknown', capped: false }
    }
    const out = {}
    if (added.length) out.added = added
    if (removed.length) out.removed = removed
    if (keyOrder) out.key_order = true
    if (changed.length) out.changed = changed.slice(0, 8)
    return out
  }
  return { change: 'value' }
}

function partRecord(block) {
  const classified = partKind(block)
  const clean = typeof block === 'string' ? block : withoutCacheControl(block)
  return {
    kind: classified.kind,
    digest: classified.digest,
    type: typeof block === 'string' ? 'string' : block?.type || null,
    stamp: valueStamp(clean),
  }
}

function contentParts(content) {
  if (typeof content === 'string') return [partRecord(content)]
  if (!Array.isArray(content)) return [partRecord(content)]
  return content.map(partRecord)
}

function messageRecord(message) {
  const clean = withoutCacheControl(message)
  return {
    hash: digest(clean),
    role: message?.role || null,
    keys: clean && typeof clean === 'object' && !Array.isArray(clean) ? Object.keys(clean) : [],
    parts: contentParts(message?.content),
  }
}

function keyDelta(previous, next) {
  const prevKeys = previous || []
  const nextKeys = next || []
  const added = nextKeys.filter((key) => !prevKeys.includes(key))
  const removed = prevKeys.filter((key) => !nextKeys.includes(key))
  const keyOrder = !added.length && !removed.length && prevKeys.join('\0') !== nextKeys.join('\0')
  if (!added.length && !removed.length && !keyOrder) return null
  return {
    reason: keyOrder ? 'key_order' : 'message_fields',
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
    ...(keyOrder ? { key_order: true } : {}),
  }
}

function messageDiff(previous, current) {
  if (!previous || !current) {
    return {
      reason: 'missing',
      prev_n: previous?.parts.length ?? 0,
      next_n: current?.parts.length ?? 0,
      prev_types: (previous?.parts || []).map((part) => part.type || part.kind),
      next_types: (current?.parts || []).map((part) => part.type || part.kind),
    }
  }
  if (previous.role !== current.role) return { reason: 'role', prev: previous.role, next: current.role }
  if (previous.parts.length !== current.parts.length) {
    return {
      reason: 'part_count',
      prev_n: previous.parts.length,
      next_n: current.parts.length,
      prev_types: previous.parts.map((part) => part.type || part.kind),
      next_types: current.parts.map((part) => part.type || part.kind),
    }
  }
  for (let i = 0; i < previous.parts.length; i++) {
    const left = previous.parts[i]
    const right = current.parts[i]
    if (left.kind !== right.kind) {
      return { reason: 'part_kind', part: i, prev: left.type || left.kind, next: right.type || right.kind }
    }
    if (left.digest !== right.digest) {
      return {
        reason: 'part',
        part: i,
        type: left.type || left.kind,
        fields: stampDelta(left.stamp, right.stamp) || { change: 'digest' },
      }
    }
  }
  return keyDelta(previous.keys, current.keys) || { reason: 'digest' }
}

function messageCacheBoundary(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j]?.cache_control?.type === 'ephemeral') return { message: i, block: j }
    }
  }
  return null
}

function snapshotBody(body, boundary = null) {
  let messages = Array.isArray(body?.messages) ? body.messages : []
  if (boundary) {
    messages = messages.slice(0, boundary.message + 1)
    const last = messages[boundary.message]
    if (Array.isArray(last?.content)) {
      messages[boundary.message] = { ...last, content: last.content.slice(0, boundary.block + 1) }
    }
  }
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return {
    tools: digest(withoutCacheControl(body?.tools)),
    tool_names: tools.map((tool) => tool?.name || null),
    system: digest(withoutCacheControl(body?.system)),
    messages: messages.map(messageRecord),
  }
}

function toolsDiff(previous, current) {
  const prevNames = previous?.tool_names || []
  const nextNames = current?.tool_names || []
  const added = nextNames.filter((name) => !prevNames.includes(name))
  const removed = prevNames.filter((name) => !nextNames.includes(name))
  return {
    reason: added.length || removed.length ? 'tool_names' : 'tool_fields',
    prev_n: prevNames.length,
    next_n: nextNames.length,
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
  }
}

function messageBreak(previous, current) {
  const prevHashes = previous.messages.map((message) => message.hash)
  const currHashes = current.messages.map((message) => message.hash)
  const index = firstDivergence(prevHashes, currHashes)
  if (index < 0) return null
  return {
    section: 'messages',
    index,
    kind: classifyParts(previous.messages[index], current.messages[index]),
    diff: messageDiff(previous.messages[index], current.messages[index]),
  }
}

function sectionDiffs(previous, current) {
  const sections = []
  if (previous.tools !== current.tools) {
    sections.push({ section: 'tools', index: null, kind: 'structure', diff: toolsDiff(previous, current) })
  }
  if (previous.system !== current.system) sections.push({ section: 'system', index: null, kind: 'text' })
  const messages = messageBreak(previous, current)
  if (messages) sections.push(messages)
  return sections
}

function comparePrefix(previous, current) {
  if (!previous) return { turn: 1, break: null }
  const turn = (previous.turn || 0) + 1
  const sections = sectionDiffs(previous, current)
  if (!sections.length) return { turn, break: null }
  return { turn, break: sections.length > 1 ? { ...sections[0], sections } : sections[0] }
}

function classifyParts(previous, current) {
  if (!previous || !current) return 'structure'
  if (previous.role !== current.role || previous.parts.length !== current.parts.length) return 'structure'
  for (let i = 0; i < previous.parts.length; i++) {
    const left = previous.parts[i]
    const right = current.parts[i]
    if (left.kind !== right.kind) return 'structure'
    if (left.digest !== right.digest) return left.kind
  }
  return 'structure'
}

/**
 * Same-request inbound vs Node outbound differences. No prompt/image bytes.
 * Every changed section is returned. A tools difference must not hide a
 * message difference. `kind=structure` is not a wire field and does not prove
 * the block list changed: a tool_result body edit, an extra key, or key order
 * also land here.
 */
export function firstHistoryDiff(inbound, outbound) {
  if (!inbound || !outbound || typeof inbound !== 'object' || typeof outbound !== 'object') {
    return { section: null, index: null, kind: null, sections: [] }
  }
  const sections = sectionDiffs(snapshotBody(inbound), snapshotBody(outbound))
  if (!sections.length) return { section: null, index: null, kind: null, sections: [] }
  return { ...sections[0], sections }
}

export function formatCacheBreak(entry) {
  const br = entry?.break
  if (!br) return ''
  const where = br.section === 'messages' ? `messages[${br.index}]` : br.section
  const diff = br.diff
  let detail = ''
  if (diff?.reason === 'part' && Array.isArray(diff.fields?.changed)) {
    detail = ` ${diff.fields.changed.map((item) => `${item.key}:${item.change}`).join(',')}`
  } else if (diff?.reason === 'part' && diff.fields?.change) {
    detail = ` ${diff.type || 'part'}:${diff.fields.change}`
  } else if (diff?.reason) {
    detail = ` ${diff.reason}`
  }
  if (Array.isArray(br.sections) && br.sections.length > 1) {
    detail += `; also ${br.sections
      .slice(1)
      .map((item) => (item.section === 'messages' ? `messages[${item.index}]` : item.section))
      .join(',')}`
  }
  return `${where} ${br.kind}${detail}`
}

export function describeCacheContinuity({
  inbound,
  outbound,
  layer = 'node_object',
  ttl = null,
  sessionId = null,
  vmId = null,
  accountId = null,
  requestId = null,
} = {}) {
  const observed = layer === 'cli_final_wire'
  const inboundToNode = firstHistoryDiff(inbound, outbound)
  return {
    layer,
    wire_observed: observed,
    ttl: ttl ? normalizeCacheTtl(ttl) : null,
    markers: listCacheMarkers(outbound),
    inbound_to_outbound: inboundToNode,
    stages: {
      inbound_to_node: inboundToNode,
      node_to_cli: { observed: false },
    },
    session_id: sessionId || null,
    vm_id: vmId || null,
    account_id: accountId || null,
    request_id: requestId || null,
  }
}

/**
 * Compare `body` with the stored turn of `sessionKey` without recording.
 * `confirmed` is true only after a successful hop called confirmCachePrefix.
 */
export function peekCachePrefix(sessionKey, body, now = Date.now()) {
  const key = String(sessionKey || '').trim()
  if (!key || !body || typeof body !== 'object') return null
  const hit = sessions.get(key)
  const previous = hit && now - hit.at < SESSION_IDLE_MS ? hit : null
  const current = snapshotBody(body, previous?.boundary)
  const compared = comparePrefix(previous, current)
  return { ...compared, confirmed: !!previous?.confirmed }
}

/**
 * Record `body` as an attempted turn of `sessionKey`. The stored snapshot is
 * unconfirmed until confirmCachePrefix: a failed/rejected hop must not make
 * the next estimate treat the session as warm.
 */
export function trackCachePrefix(sessionKey, body, now = Date.now(), { cacheOnly = false } = {}) {
  const key = String(sessionKey || '').trim()
  if (!key || !body || typeof body !== 'object') return null
  const hit = sessions.get(key)
  const previous = hit && now - hit.at < SESSION_IDLE_MS ? hit : null
  const boundary = cacheOnly ? messageCacheBoundary(body) : null
  const current = snapshotBody(body, boundary)
  const priorBoundary = previous?.boundary || null
  const sameBoundary = priorBoundary?.message === boundary?.message && priorBoundary?.block === boundary?.block
  // Images after the prior write boundary were never part of the cached prefix.
  const compared = comparePrefix(previous, !previous || sameBoundary ? current : snapshotBody(body, priorBoundary))
  sessions.delete(key)
  sessions.set(key, { ...current, boundary, turn: compared.turn, at: now, confirmed: false })
  if (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value)
  return { turn: compared.turn, break: compared.break, ...(cacheOnly ? { scope: 'cached_prefix', boundary } : {}) }
}

/** Mark the latest attempted snapshot as a confirmed cache write/read. */
export function confirmCachePrefix(sessionKey, now = Date.now()) {
  const key = String(sessionKey || '').trim()
  if (!key) return false
  const hit = sessions.get(key)
  if (!hit || now - hit.at >= SESSION_IDLE_MS) return false
  hit.confirmed = true
  return true
}

export function clearCachePrefixSessions() {
  sessions.clear()
}
