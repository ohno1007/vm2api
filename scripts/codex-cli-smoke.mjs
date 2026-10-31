import { getVm } from '../src/lib/vm/vm-registry.mjs'
import { ensureCodexCli, codexCliModels, stopCodexCli } from '../src/lib/transport/codex-cli-supervisor.mjs'
import { streamCodexCli } from '../src/lib/transport/codex-cli-client.mjs'
const root = process.env.KIN_PROJECT_ROOT
const id = process.argv[2]
const vm = getVm(root, id)
const exec = { vm, vmId: id, projectRoot: root, homeDir: `${root}/vms/${id}/cli-home` }
try {
  const ready = await ensureCodexCli(exec)
  if (!ready.ok) throw new Error(ready.reason)
  const { models } = await codexCliModels(ready.runtime)
  console.log(JSON.stringify({ ready: true, models: models.map(m => ({ model: m.model, id: m.id, serviceTiers: m.serviceTiers?.map(t => t.id) })) }))
  const model = models.find(m => (m.model || m.id) === 'gpt-6.1-sol') || models.find(m => m.isDefault) || models[0]
  if (!model) throw new Error('no_models')
  const tier = process.argv[3] || 'default'
  const repeats = Math.min(5, Math.max(1, Number(process.argv[4]) || 1))
  for (let i = 0; i < repeats; i++) {
    const output = await streamCodexCli({ exec, body: { model: model.model || model.id, service_tier: tier, input: 'Reply with the single word OK.', reasoning: { effort: 'low' } }, timeoutMs: 90_000, idleTimeoutMs: 60_000 })
    console.log(JSON.stringify({ sample: i + 1, reusedProcess: (await ensureCodexCli(exec)).runtime === ready.runtime, ok: output.ok, status: output.status, error: output.body?.error, model: output.model, requestedServiceTier: output.requestedServiceTier, actualServiceTier: output.body?.service_tier, usage: output.usage, durationMs: output.durationMs, generationMs: output.generationMs, ttftMs: output.ttftMs, output: output.body?.output }))
    if (!output.ok) process.exitCode = 1
  }
} finally { await stopCodexCli(id) }
