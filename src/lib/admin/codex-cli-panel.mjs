import path from 'node:path'
import { getVm, patchVmRecord } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { isCodexCliVm, canRunCodexCli } from '../vm/codex-cli-config.mjs'
import { seedCodexCliAuth, syncCodexCliAuth, completeCodexCliLogin } from '../vm/codex-cli-auth.mjs'
import { stageCodexCliBinary, ensureCodexCli, stopCodexCli, startCodexCliLogin, codexCliLoginStatus, codexCliModels } from '../transport/codex-cli-supervisor.mjs'
import { stopCodexKernel } from '../transport/codex-kernel-supervisor.mjs'

/** Called only after panel authentication, RBAC, and VM ownership checks. */
export async function codexCliPanel({ req, res, pathname, projectRoot, readBody, json }) {
  const match = pathname.match(/^\/api\/panel\/vms\/([^/]+)\/codex-cli\/(settings|prepare|login|status|models|stop)$/)
  if (!match) return false
  const [, id, action] = match
  res.setHeader('Cache-Control', 'no-store')
  const vm = getVm(projectRoot, id)
  const reply = (status, data) => { json(res, status, data); return true }
  const error = (status, code) => reply(status, { ok: false, error: { code, message: code } })
  if (!vm) return error(404, 'vm_not_found')
  if (!isCodexVm(vm) || !isKvmRuntime(vm) || vm.node_id) return error(409, 'local_codex_kvm_required')
  if (action === 'status' && req.method === 'GET') {
    if (isCodexCliVm(vm) && vm.schedulable !== false) syncCodexCliAuth(projectRoot, id)
    return reply(200, { ok: true, data: { settings: vm.codex_cli || { enabled: false }, setupAllowed: canRunCodexCli(vm, { loginSetup: true }), ...codexCliLoginStatus(id) } })
  }
  if (action === 'settings' && req.method === 'PUT') {
    const body = await readBody(req, 4096)
    if (typeof body.enabled !== 'boolean' || (body.parallel != null && (!Number.isInteger(body.parallel) || body.parallel < 1 || body.parallel > 16))) return error(400, 'invalid_cli_settings')
    if (codexCliLoginStatus(id).inFlight) return error(409, 'slot_busy')
    stopCodexKernel(id)
    await stopCodexCli(id)
    const codex_cli = { enabled: body.enabled, parallel: body.parallel || 2 }
    patchVmRecord(projectRoot, id, { codex_cli })
    return reply(200, { ok: true, data: codex_cli })
  }
  if (req.method !== (action === 'models' ? 'GET' : 'POST')) return error(405, 'method_not_allowed')
  if (!isCodexCliVm(vm)) return error(409, 'codex_cli_disabled')
  if (action === 'stop') return reply(200, { ok: true, data: await stopCodexCli(id) })
  const options = { loginSetup: action === 'prepare' || action === 'login' }
  if (!canRunCodexCli(vm, options)) return error(409, 'slot_resting')
  const exec = { vm, vmId: id, projectRoot, homeDir: path.join(projectRoot, 'vms', id, 'cli-home') }
  try {
    if (action === 'prepare') {
      const prepared = await stageCodexCliBinary(projectRoot, vm, options)
      return reply(200, { ok: true, data: { ...prepared, auth: seedCodexCliAuth(projectRoot, vm) } })
    }
    if (action === 'login') {
      seedCodexCliAuth(projectRoot, vm)
      const ready = await ensureCodexCli(exec, options)
      if (!ready.ok) return error(409, ready.reason)
      const current = await ready.runtime.rpc.request('account/read', { refreshToken: false })
      if (current.account) { ready.runtime.account = current.account; completeCodexCliLogin(projectRoot, id); return reply(200, { ok: true, data: { authenticated: true, account: current.account } }) }
      return reply(200, { ok: true, data: await startCodexCliLogin(exec, { deviceCode: true }) })
    }
    const ready = await ensureCodexCli(exec)
    if (!ready.ok) return error(409, ready.reason)
    return reply(200, { ok: true, data: await codexCliModels(ready.runtime) })
  } catch (e) { return error(e.status || 502, e.code || 'codex_cli_operation_failed') }
}
