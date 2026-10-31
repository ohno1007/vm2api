import { codexCliError } from '../transport/codex-app-server-rpc.mjs'

export function normalizeCodexCliTier(value) {
  const tier = String(value ?? '').trim().toLowerCase()
  if (!tier || ['auto', 'default', 'standard'].includes(tier)) return 'standard'
  if (['fast', 'priority'].includes(tier)) return 'fast'
  if (tier === 'ultrafast') return 'ultrafast'
  if (tier === 'flex') return 'flex'
  throw codexCliError('unsupported_service_tier', 400)
}

/** Resolve the account's actual catalog id. Never fabricate access or silently downgrade. */
export function selectCodexCliTier(model, requested, requirements = null) {
  const tier = normalizeCodexCliTier(requested)
  if (tier === 'standard') return { tier, serviceTier: 'default' }
  const feature = tier === 'ultrafast' ? 'ultrafast_mode' : tier === 'fast' ? 'fast_mode' : null
  if (feature && requirements?.featureRequirements?.[feature] === false) {
    throw codexCliError('service_tier_disabled', 403)
  }
  const supported = Array.isArray(model?.serviceTiers) ? model.serviceTiers : []
  const found = supported.find((row) => {
    try { return normalizeCodexCliTier(row.id) === tier } catch { return false }
  })
  if (!found) throw codexCliError('service_tier_unavailable', 400)
  return { tier, serviceTier: found.id }
}
