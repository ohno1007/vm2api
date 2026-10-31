import { codexCliError } from '../transport/codex-app-server-rpc.mjs'

const FIELDS = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']

function counters(value) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  for (const name of FIELDS) {
    if (value[name] == null) continue
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) throw codexCliError('codex_cli_invalid_usage')
    out[name] = value[name]
  }
  if (out.inputTokens == null || out.outputTokens == null) return null
  if (!Number.isSafeInteger(out.inputTokens + out.outputTokens) ||
      (out.totalTokens != null && out.totalTokens !== out.inputTokens + out.outputTokens)) throw codexCliError('codex_cli_invalid_usage')
  if ((out.cachedInputTokens || 0) + (out.cacheWriteInputTokens || 0) > out.inputTokens ||
      (out.reasoningOutputTokens || 0) > out.outputTokens) throw codexCliError('codex_cli_invalid_usage')
  return out
}

/** Inclusive OpenAI usage: cache is within input, reasoning is within output. */
export function codexCliUsage(value) {
  const c = counters(value)
  if (!c) return null
  const usage = {
    input_tokens: c.inputTokens,
    output_tokens: c.outputTokens,
    total_tokens: c.inputTokens + c.outputTokens,
    input_tokens_details: {},
    output_tokens_details: {},
  }
  if (c.cachedInputTokens != null) usage.input_tokens_details.cached_tokens = c.cachedInputTokens
  if (c.cacheWriteInputTokens != null) usage.input_tokens_details.cache_write_tokens = c.cacheWriteInputTokens
  if (c.reasoningOutputTokens != null) usage.output_tokens_details.reasoning_tokens = c.reasoningOutputTokens
  return usage
}

/**
 * A CLI turn can make several upstream calls. `last` only covers the last call;
 * `total` is cumulative across the thread. Subtract a captured pre-turn baseline,
 * never add repeated notification snapshots or bill a previous turn again.
 */
export class CodexCliUsageMeter {
  constructor(baseline = null) {
    this.baseline = counters(baseline) || {}
    this.latest = null
  }

  observe(tokenUsage) {
    const current = counters(tokenUsage?.total)
    if (!current) return this.value()
    const delta = {}
    for (const field of FIELDS) {
      if (current[field] == null) continue
      const previous = this.latest?.[field] ?? this.baseline[field] ?? 0
      if (current[field] < previous) throw codexCliError('codex_cli_usage_regressed')
      delta[field] = current[field] - (this.baseline[field] || 0)
    }
    const value = codexCliUsage(delta)
    this.latest = current
    this.usage = value
    return value
  }

  value() { return this.usage || null }
}
