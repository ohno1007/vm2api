import { randomUUID } from 'node:crypto'
import { extraFromCodexHeaders, buildCodexUsageView, extraToCodexSnapshot, normalizeCodexCredits } from './codex-usage.mjs'
import { persistCodexQuotaSnapshot } from '../vm/codex-slot.mjs'
import { getVm, syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { canRunCodexCli } from '../vm/codex-cli-config.mjs'
import { codexCliError } from '../transport/codex-app-server-rpc.mjs'

export function normalizeCodexCliQuota(result = {}, now = Date.now()) {
  const limit = result.rateLimitsByLimitId?.codex || result.rateLimits
  if (!limit || typeof limit !== 'object') throw codexCliError('cli_quota_missing', 502)
  const headers = {}
  for (const role of ['primary', 'secondary']) {
    const win = limit[role]
    if (!win) continue
    if (win.usedPercent != null) headers[`x-codex-${role}-used-percent`] = String(win.usedPercent)
    if (win.windowDurationMins != null) headers[`x-codex-${role}-window-minutes`] = String(win.windowDurationMins)
    if (win.resetsAt != null) headers[`x-codex-${role}-reset-at`] = String(win.resetsAt)
  }
  if (limit.rateLimitReachedType) headers['x-codex-rate-limit-reached-type'] = limit.rateLimitReachedType
  const extra = extraFromCodexHeaders(headers, now)
  if (extra) extra.codex_quota_probed_at = new Date(now).toISOString()
  const usage = buildCodexUsageView(extraToCodexSnapshot(extra || {}))
  const summary = result.rateLimitResetCredits
  const resetCredits = Number.isInteger(summary?.availableCount) && summary.availableCount >= 0 ? {
    available_count: summary.availableCount,
    credits: Array.isArray(summary.credits) ? summary.credits
      .filter(row => row.status === 'available' && row.resetType === 'codexRateLimits')
      .map(row => ({ expires_at: Number.isFinite(row.expiresAt) && row.expiresAt > 0 ? new Date(row.expiresAt * 1000).toISOString() : null })) : [],
    details_available: Array.isArray(summary.credits), fetched_at: new Date(now).toISOString(),
  } : null
  return {
    extra, resetCredits, credits: normalizeCodexCredits(limit.credits, now), planType: limit.planType,
    public: { ok: true, source: 'codex-cli', usage, quota: usage.quota, windows: usage.windows,
      reset_credits: resetCredits, credits: normalizeCodexCredits(limit.credits, now), plan_type: limit.planType || null,
      rate_limits: limit, fetched_at: new Date(now).toISOString() },
  }
}

export function persistCodexCliQuota(projectRoot, vmId, result, policy) {
  const vm = getVm(projectRoot, vmId)
  if (!canRunCodexCli(vm) || !vm?.codex_cli?.enabled) throw codexCliError('slot_resting', 409)
  const snapshot = normalizeCodexCliQuota(result)
  persistCodexQuotaSnapshot(projectRoot, vmId, snapshot)
  syncCodexQuotaSchedule(projectRoot, getVm(projectRoot, vmId), { policy })
  return snapshot.public
}

export async function readCodexCliQuota(rpc, persist) {
  const result = await rpc.request('account/rateLimits/read', { excludeResetCreditDetails: false })
  return persist(result)
}

/** Explicit user action only. Never retry an ambiguous redemption or consume during a read. */
export async function consumeCodexCliResetCredit(rpc, persist) {
  const result = await rpc.request('account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID() })
  if (result.outcome === 'nothingToReset') return { ok: false, status: 409, error: 'nothing_to_reset', message: '当前没有可重置的额度窗口，未使用重置券' }
  if (result.outcome === 'noCredit') return { ok: false, status: 409, error: 'no_reset_credit', message: '当前没有可用重置券' }
  if (!['reset', 'alreadyRedeemed'].includes(result.outcome)) throw codexCliError('cli_reset_outcome_unknown', 502)
  try {
    return { ...await readCodexCliQuota(rpc, persist), code: result.outcome, windows_reset: null }
  } catch {
    return { ok: true, source: 'codex-cli', code: result.outcome, warning: 'reset_credit_cache_refresh_failed',
      windows_reset: null, reset_credits: null, credits: null, usage: null, quota: null, windows: [] }
  }
}
