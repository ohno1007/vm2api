import { codexCliError } from '../transport/codex-app-server-rpc.mjs'

const catalogs = new Map()
export function cacheCodexCliCatalog(vmId, data, now = Date.now()) { catalogs.set(vmId, { data, at: now }) }
export function clearCodexCliCatalog(vmId) { catalogs.delete(vmId) }
export function codexCliRoutingCatalog(data, accountId, now = Date.now()) {
  return { at: now, account_id: accountId || null, data: {
    models: data.models.map(m => ({ id: m.id, model: m.model, serviceTiers: (m.serviceTiers || []).map(t => ({ id: t.id })) })),
    requirements: { featureRequirements: data.requirements?.featureRequirements || {} },
  } }
}
/** null means discover in the CLI before inference, never assume entitlement. */
export function codexCliTierSupport(vmOrId, modelId, requested, now = Date.now()) {
  let tier
  try { tier = normalizeCodexCliTier(requested) } catch { return null }
  if (tier === 'standard') return true
  const vm = typeof vmOrId === 'object' ? vmOrId : null
  const saved = vm?.codex_cli?.routing_catalog
  const accountId = vm?.org_uuid || vm?.codex?.chatgpt_account_id || null
  const entry = catalogs.get(vm?.id || vmOrId) || (saved?.account_id === accountId ? saved : null)
  // Routing hint survives process restart; inference rechecks the live 60s CLI catalog.
  if (!entry || now - entry.at > 15 * 60_000) return null
  const model = entry.data.models.find(m => m.id === modelId || m.model === modelId)
  if (!model) return false
  try { selectCodexCliTier(model, requested, entry.data.requirements); return true } catch { return false }
}

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
