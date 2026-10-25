/**
 * Official Messages body shaping only.
 * The HTTP hop lives in the per-slot Go worker. This file only sanitizes the body.
 */
import {
  applyStructuredOutput,
  canonicalizeClaudeMessagesShape,
  copyOfficialAnthropicFields,
  normalizeAnthropicMessages,
  stripIllegalBodyContentFields,
} from './sanitize.mjs'
import { sanitizeAnthropicTools } from './web-search.mjs'
import { normalizeCacheTtl, removeCacheControlFields } from './cache-ttl.mjs'
import { modelSupportsMidConversationSystem } from './anthropic-policy.mjs'

/** Gateway schema fill and CLI final merge share one prompt layout and marker policy. */
export function assembleOfficialPromptBody(body, { ttl, preserveMessageMarker = false } = {}) {
  const marker = { type: 'ephemeral', ttl: normalizeCacheTtl(ttl) }
  const out = removeCacheControlFields(body)
  const blocks = Array.isArray(out.system) ? out.system : out.system ? [{ type: 'text', text: out.system }] : []
  let billing
  let identity
  const fixed = []
  const environment = []
  for (const block of blocks) {
    const text = typeof block === 'string' ? block : block?.text
    if (typeof text !== 'string' || !text.trim() || text === '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__') continue
    if (/^\s*x-anthropic-billing-header:/i.test(text)) {
      billing ??= { type: 'text', text }
    } else if (/^\s*# Environment\b/.test(text)) {
      environment.push(text)
    } else if (text.startsWith('# Text output (does not apply to tool calls)') && text.includes('\n# Environment')) {
      const at = text.indexOf('\n# Environment')
      fixed.push(text.slice(0, at).trimEnd())
      environment.push(text.slice(at).trimStart())
    } else if (
      !identity &&
      (/^You are (?:Claude Code,|a Claude agent,|Anthropic Claude Agent SDK\.)/.test(text) || text === '\u200b')
    ) {
      identity = { type: 'text', text, cache_control: { ...marker } }
    } else {
      fixed.push(text)
    }
  }
  out.system = [
    ...(billing ? [billing] : []),
    ...(identity ? [identity] : []),
    ...(fixed.length ? [{ type: 'text', text: fixed.join('\n\n'), cache_control: { ...marker } }] : []),
  ]
  const messages = out.messages || []
  let anchor = null
  const previousAnchors = []
  // Only gateway-owned markers are trusted here: a tool image tail may follow them.
  if (preserveMessageMarker) {
    for (const [i, message] of (body.messages || []).entries()) {
      if (message?.role !== 'user' || !Array.isArray(message.content)) continue
      for (const [j, block] of message.content.entries()) {
        if (block?.cache_control && !['thinking', 'redacted_thinking'].includes(block.type)) previousAnchors.push([i, j])
      }
    }
  }
  anchor = previousAnchors.at(-1) || null
  for (let i = messages.length - 1; !anchor && i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const content =
      typeof message.content === 'string'
        ? message.content
          ? [{ type: 'text', text: message.content }]
          : []
        : message.content
    if (!Array.isArray(content)) continue
    const j = content.findLastIndex((block) => block && !['thinking', 'redacted_thinking'].includes(block.type))
    if (j < 0) continue
    messages[i] = { ...message, content }
    anchor = [i, j]
  }
  if (anchor) {
    // Keep both gateway-owned user anchors from the upstream cache fix while
    // retaining our shared system/environment layout and marker normalization.
    for (const [i, j] of previousAnchors.length ? previousAnchors.slice(-2) : [anchor]) {
      messages[i].content[j] = { ...messages[i].content[j], cache_control: { ...marker } }
    }
  }
  const inboundEnvironment = []
  out.messages = messages.filter((message) => {
    if (message?.role !== 'system') return true
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((block) => block?.text || '').join('\n\n')
          : ''
    if (!/^\s*# Environment\b/.test(text)) return true
    inboundEnvironment.push(text)
    return false
  })
  // A regenerated slot environment replaces the caller's copy, never the transcript.
  const env = environment.length ? environment.join('\n\n') : inboundEnvironment.at(-1)
  if (env) {
    if (modelSupportsMidConversationSystem(out.model)) out.messages.push({ role: 'system', content: env })
    else out.system.push({ type: 'text', text: env })
  }
  return out
}

export function officialMessagesBody(body = {}, { stream = undefined, preserveContentShape = false } = {}) {
  const out = copyOfficialAnthropicFields(body)
  applyStructuredOutput(out, body)
  normalizeAnthropicMessages(out)
  stripIllegalBodyContentFields(out)
  if (Array.isArray(out.tools)) out.tools = sanitizeAnthropicTools(out.tools)
  if (stream !== undefined) out.stream = !!stream
  if (!out.max_tokens) out.max_tokens = 128000
  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools
  if (out.tool_choice && !out.tools) delete out.tool_choice
  if (out.stop_sequences) delete out.stop
  else if (out.stop != null) {
    out.stop_sequences = Array.isArray(out.stop) ? out.stop : [out.stop]
    delete out.stop
  }
  return canonicalizeClaudeMessagesShape(out, { preserveContentShape })
}

const DISABLED = {
  status: 501,
  ok: false,
  via: 'anthropic-messages-disabled',
  body: {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Direct host HTTP hop is disabled. All Anthropic I/O goes through the Go slot worker.',
    },
  },
  headers: {},
}

/** Host-process hop stays disabled. The Go slot worker owns the Anthropic HTTP hop. */
export async function callAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}

export async function streamAnthropicMessages(_opts = {}) {
  return { ...DISABLED }
}
