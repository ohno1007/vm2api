import { costColumnsFromUsage } from '../admin/pricing.mjs'

/** Codex has its own transport path, but shares managed-key gates and accounting. */
export async function runManagedCodexRequest({ req, res, logBag, apiKeyStore, groupsRepo, json, run }) {
  const key = req.apiKeyRecord
  if (!key) return run()
  const gate = apiKeyStore.acquire(key)
  if (!gate.ok) {
    logBag.error_code = gate.code
    logBag.error_message = gate.message
    return json(res, gate.status, {
      error: {
        type: gate.status === 429 ? 'rate_limit_error' : 'permission_error',
        code: gate.code,
        message: gate.message,
        ...(gate.detail ? { details: gate.detail } : {}),
      },
    })
  }
  try {
    return await run()
  } finally {
    try {
      // A streamed error can still have HTTP 200 headers. Bill only a verified
      // delivered result, never an admission failure or exhausted upstream slot.
      if (logBag.final_state === 'verified' && !logBag.error_code) {
        const model = logBag.upstream_model || logBag.model
        const only = logBag.protocol === 'openai.images'
        const image = logBag.image_usage || only
          ? { usage: logBag.image_usage || null, model: logBag.image_model || null, only }
          : null
        const usage = logBag.usage || {}
        const priced = costColumnsFromUsage(usage, model, image)
        apiKeyStore.recordUsage(key, usage, {
          model,
          rateMultiplier: groupsRepo.rateMultiplier(key.group_id ?? 1),
          officialCost: priced.total_cost,
        })
      }
    } catch (error) {
      console.error('[codex-key-billing] accounting failed', { keyId: key.id, code: error?.code || 'billing_write_failed' })
    } finally {
      apiKeyStore.release(key)
    }
  }
}
