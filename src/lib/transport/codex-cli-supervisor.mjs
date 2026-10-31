import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { CodexAppServerRpc, codexCliError } from './codex-app-server-rpc.mjs'
import { slotExecArgv, slotExecContainer } from '../vm/slot-exec.mjs'
import { slotHost } from '../vm/slot-host.mjs'
import { isKvmRuntime } from '../vm/runtime-kind.mjs'
import { inspectContainerOrNull, inspectNetworkOrNull } from '../cluster/docker-remote.mjs'
import { isLocalEgressProxy, slotNetworkForVm, inspectEgressNetwork, chainName, portsForProxy, bridgeName } from '../vm/egress.mjs'
import { validTimezone } from '../core/timezone.mjs'
import { configureCodexCliNetwork } from '../vm/codex-cli-network.mjs'
import { getVm, persistCodexUsage } from '../vm/vm-registry.mjs'
import { CODEX_CLI_GUEST_BIN, CODEX_CLI_GUEST_HOME, CODEX_CLI_GUEST_WORKDIR, CODEX_CLI_VERSION, CODEX_CLI_BINARY_SHA256, codexCliAppServerArgs, canRunCodexCli } from '../vm/codex-cli-config.mjs'
import { completeCodexCliLogin } from '../vm/codex-cli-auth.mjs'

const active = new Map()
const starting = new Map()
const stopping = new Map()
const execAsync = promisify(execFile)

async function waitForGuest(vm, root, host, options) {
  const args = slotExecArgv(vm, ['python3', '-c', `import os;raise SystemExit(0 if os.access('${CODEX_CLI_GUEST_BIN}',os.X_OK) else 42)`], { user: host.execUser(vm) })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const latest = getVm(root, vm.id)
    if (!canRunCodexCli(latest, options) || !latest?.codex_cli?.enabled) throw codexCliError('slot_resting', 409)
    try {
      await execAsync('docker', args, { env: host.dockerEnv() || process.env, timeout: 10_000, maxBuffer: 4096 })
      return
    } catch (e) {
      // SSH may become available before cloud-init mounts/chowns the shared home.
      // The host manifest was checked already; allow the cold guest to finish setup.
      if (e.code !== 42 && e.code !== 255 && e.killed !== true && typeof e.code !== 'number') throw e
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw codexCliError('codex_cli_guest_not_ready', 503)
}

// A guest-side process group and advisory lock prevent orphan/double CLI processes
// when docker exec or the control plane disconnects. No network transport is exposed.
export const CODEX_CLI_GUEST_SUPERVISOR = String.raw`
import fcntl,json,os,signal,subprocess,sys,threading,time
job=json.loads(sys.stdin.readline())
os.makedirs(job['home'],mode=0o700,exist_ok=True)
os.makedirs(job['cwd'],mode=0o700,exist_ok=True)
lock=open(job['home']+'/gateway.lock','a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:sys.exit(73)
env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy','no_proxy') and not k.startswith(('OPENAI_','CODEX_'))}
env.update(HOME='/home/kincli',CODEX_HOME=job['home'],TZ=job['timezone'],LANG=job['locale'],LC_ALL=job['locale'])
child=subprocess.Popen([job['bin']]+job['args'],stdin=subprocess.PIPE,stdout=sys.stdout,stderr=subprocess.DEVNULL,env=env,cwd=job['cwd'],start_new_session=True)
stopping=threading.Event()
def stop():
 if stopping.is_set():return
 stopping.set()
 try:os.killpg(child.pid,signal.SIGTERM)
 except ProcessLookupError:return
 def hard():
  time.sleep(5)
  if child.poll() is None:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
 threading.Thread(target=hard,daemon=True).start()
def relay():
 try:
  for line in sys.stdin:
   child.stdin.write(line.encode());child.stdin.flush()
 except (BrokenPipeError,OSError):pass
 finally:stop()
threading.Thread(target=relay,daemon=True).start()
signal.signal(signal.SIGTERM,lambda *_:stop())
signal.signal(signal.SIGHUP,lambda *_:stop())
sys.exit(child.wait())
`

function rootFor(exec) { return path.resolve(exec.projectRoot || path.join(exec.homeDir, '../../..')) }

function command(name, args) {
  const prefix = name === 'iptables' ? String(process.env.KIN_EGRESS_CMD_PREFIX || '').trim().split(/\s+/).filter(Boolean) : []
  try {
    execFileSync(prefix[0] || name, prefix.length ? [...prefix.slice(1), name, ...args] : args,
      { stdio: 'ignore', timeout: 8000 })
    return true
  } catch { return false }
}

/** Read-only verification: existing egress must already be fail-closed. */
export async function assertCodexCliNetwork(vm, options) {
  if (!canRunCodexCli(vm, options)) throw codexCliError('slot_resting', 409)
  if (!isKvmRuntime(vm)) throw codexCliError('codex_cli_kvm_required', 409)
  const host = slotHost(vm)
  if (host.kind !== 'local') throw codexCliError('codex_cli_local_node_required', 409)
  if (!vm.proxy?.id || isLocalEgressProxy(vm.proxy)) throw codexCliError('codex_cli_proxy_required', 409)
  const expected = slotNetworkForVm(vm)
  const [container, network] = await Promise.all([
    inspectContainerOrNull(host.dockerApi(), slotExecContainer(vm)),
    inspectNetworkOrNull(host.dockerApi(), expected),
  ])
  if (!container?.State?.Running || container.State.Paused) throw codexCliError('slot_not_running', 409)
  if (!container.Config?.Env?.includes('KIN_VM_ENGINE=codex-cli')) throw codexCliError('codex_cli_vm_restart_required', 409)
  if (container.HostConfig?.NetworkMode !== expected || Object.keys(container.NetworkSettings?.Networks || {}).length !== 1) {
    throw codexCliError('slot_egress_mismatch', 409)
  }
  if (!network || network.EnableIPv6 || network.Options?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false') {
    throw codexCliError('codex_cli_unsafe_network', 409)
  }
  const net = inspectEgressNetwork(vm.proxy.id)
  if (!net?.subnet) throw codexCliError('codex_cli_egress_missing', 409)
  const bridge = bridgeName(vm.proxy.id), chain = chainName(vm.proxy.id), ports = portsForProxy(vm.proxy.id)
  const rules = [
    ['-t', 'filter', '-C', 'FORWARD', '-i', bridge, '!', '-d', net.subnet, '-j', 'DROP'],
    ['-t', 'nat', '-C', 'PREROUTING', '-i', bridge, '-j', chain],
    ['-t', 'nat', '-C', chain, '-p', 'tcp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', String(ports.dns)],
    ['-t', 'nat', '-C', chain, '-p', 'udp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', String(ports.dns)],
    ['-t', 'nat', '-C', chain, '-p', 'tcp', '-j', 'REDIRECT', '--to-ports', String(ports.tcp)],
  ]
  if (!rules.every((rule) => command('iptables', rule))) throw codexCliError('codex_cli_egress_rules_missing', 409)
  configureCodexCliNetwork(vm)
  return { network: expected, proxyId: vm.proxy.id, timezone: validTimezone(vm.timezone) }
}

/** Explicit preparation only. Never download/install during credential import or binding. */
export async function stageCodexCliBinary(projectRoot, vm, options) {
  if (!canRunCodexCli(vm, options)) throw codexCliError('slot_resting', 409)
  const manifestFile = path.join(projectRoot, 'share', 'codex-cli', 'manifest.json')
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { throw codexCliError('codex_cli_payload_missing', 503) }
  const source = path.join(path.dirname(manifestFile), 'codex')
  if (manifest.version !== CODEX_CLI_VERSION || manifest.sha256 !== CODEX_CLI_BINARY_SHA256) throw codexCliError('codex_cli_payload_invalid')
  const digest = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(source)) digest.update(chunk)
  if (digest.digest('hex') !== CODEX_CLI_BINARY_SHA256) throw codexCliError('codex_cli_payload_invalid')
  const home = path.join(projectRoot, 'vms', vm.id, 'cli-home')
  const owner = fs.statSync(home)
  const destination = path.join(home, '.local', 'share', 'vm2api-codex')
  for (const dir of [path.join(home, '.local'), path.join(home, '.local', 'share'), destination]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') fs.chownSync(dir, owner.uid, owner.gid)
  }
  const target = path.join(destination, 'codex')
  const temp = `${target}.${crypto.randomUUID()}.tmp`
  // Hard links share the immutable payload across slots without another 319 MB per slot.
  try { fs.linkSync(source, temp) } catch { fs.copyFileSync(source, temp, fs.constants.COPYFILE_FICLONE) }
  fs.chmodSync(temp, 0o755)
  fs.renameSync(temp, target)
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest), { mode: 0o644 })
  return { ok: true, version: manifest.version, bytes: fs.statSync(target).size }
}

function signature(vm) {
  return crypto.createHash('sha256').update(JSON.stringify({ proxy: vm.proxy, timezone: vm.timezone, locale: vm.locale, enabled: vm.codex_cli?.enabled })).digest('hex')
}

export async function ensureCodexCli(exec, options = {}) {
  const root = rootFor(exec)
  const vm = getVm(root, exec.vm?.id) || exec.vm
  if (!canRunCodexCli(vm, options) || !vm?.codex_cli?.enabled) return { ok: false, reason: 'slot_resting' }
  const key = vm?.id
  if (stopping.has(key)) await stopping.get(key)
  const current = active.get(key)
  if (current && !current.rpc.closed && current.signature === signature(vm)) return { ok: true, reused: true, runtime: current }
  if (starting.has(key)) return starting.get(key)
  const pending = (async () => {
    try {
      if (current) await stopCodexCli(key)
      const network = await assertCodexCliNetwork(vm, options)
      if (!network.timezone || vm.timezone_source !== 'proxy_geo') throw codexCliError('proxy_timezone_required', 409)
      const latest = getVm(root, vm.id)
      if (!latest?.codex_cli?.enabled || !canRunCodexCli(latest, options)) throw codexCliError('slot_resting', 409)
      const target = path.join(root, 'vms', vm.id, 'cli-home', '.local', 'share', 'vm2api-codex', 'manifest.json')
      if (!fs.existsSync(target)) throw codexCliError('codex_cli_not_prepared', 409)
      const host = slotHost(vm)
      await waitForGuest(vm, root, host, options)
      const beforeSpawn = getVm(root, vm.id)
      if (!beforeSpawn?.codex_cli?.enabled || !canRunCodexCli(beforeSpawn, options)) throw codexCliError('slot_resting', 409)
      const env = { HOME: '/home/kincli', TZ: network.timezone, LANG: vm.locale || 'en_US.UTF-8' }
      const argv = slotExecArgv(vm, ['python3', '-u', '-c', CODEX_CLI_GUEST_SUPERVISOR], { user: host.execUser(vm), interactive: true, env })
      const child = spawn('docker', argv, { env: host.dockerEnv() || process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      const rpc = new CodexAppServerRpc(child)
      child.stdin.write(JSON.stringify({ bin: CODEX_CLI_GUEST_BIN, home: CODEX_CLI_GUEST_HOME, cwd: CODEX_CLI_GUEST_WORKDIR, args: codexCliAppServerArgs(), timezone: network.timezone, locale: vm.locale || 'en_US.UTF-8' }) + '\n')
      const runtime = { rpc, child, signature: signature(vm), network, version: CODEX_CLI_VERSION, modelCache: null, account: null, login: null, inFlight: 0 }
      active.set(key, runtime)
      rpc.on('notification', (message) => {
        if (message.method === 'account/rateLimits/updated') {
          const limit = message.params.rateLimits
          if (limit && (!limit.limitId || limit.limitId === 'codex')) {
            const headers = {}
            for (const role of ['primary', 'secondary']) {
              const win = limit[role]
              if (!win) continue
              if (win.usedPercent != null) headers[`x-codex-${role}-used-percent`] = String(win.usedPercent)
              if (win.windowDurationMins != null) headers[`x-codex-${role}-window-minutes`] = String(win.windowDurationMins)
              if (win.resetsAt != null) headers[`x-codex-${role}-reset-at`] = String(win.resetsAt)
            }
            if (Object.keys(headers).length && getVm(root, vm.id)?.schedulable !== false) {
              try { persistCodexUsage(root, vm.id, { headers }) } catch {}
            }
          }
        }
        if (message.method === 'account/login/completed') {
          runtime.login = { loginId: message.params.loginId, success: message.params.success, completed: true, error: message.params.success ? null : 'login_failed' }
          runtime.modelCache = null
          if (message.params.success) {
            try { completeCodexCliLogin(root, vm.id) } catch {}
          }
        }
        if (message.method === 'account/updated') { runtime.account = null; runtime.modelCache = null }
      })
      rpc.on('failure', () => { if (active.get(key) === runtime) active.delete(key); child.stdin.end() })
      await rpc.initialize({ timeoutMs: 20_000 })
      if (!canRunCodexCli(getVm(root, vm.id), options) || !getVm(root, vm.id)?.codex_cli?.enabled) throw codexCliError('slot_resting', 409)
      return { ok: true, runtime }
    } catch (error) {
      await stopCodexCli(key)
      return { ok: false, reason: error.code || 'codex_cli_start_failed' }
    }
  })()
  starting.set(key, pending)
  try { return await pending } finally { starting.delete(key) }
}

export async function stopCodexCli(vmId) {
  if (stopping.has(vmId)) return stopping.get(vmId)
  const current = active.get(vmId)
  if (!current) return { ok: true, stopped: false }
  const pending = stopRuntime(current, vmId)
  stopping.set(vmId, pending)
  try { return await pending } finally { stopping.delete(vmId) }
}

async function stopRuntime(current, vmId) {
  active.delete(vmId)
  current.rpc.close()
  const stopped = await new Promise((resolve) => {
    if (current.child.exitCode != null || current.child.signalCode != null) return resolve(true)
    const timer = setTimeout(() => resolve(false), 8000)
    current.child.once('close', () => { clearTimeout(timer); resolve(true) })
  })
  if (!stopped) current.child.kill('SIGTERM')
  return { ok: stopped, stopped }
}

export function codexCliHealth(vmId) {
  const runtime = active.get(vmId)
  return runtime && !runtime.rpc.closed
    ? { ok: true, status: 200, source: 'codex-cli', version: runtime.version, inFlight: runtime.inFlight }
    : { ok: false, code: 'ENOENT', source: 'codex-cli' }
}

export async function stopAllCodexCli() {
  return Promise.all([...active.keys()].map(stopCodexCli))
}

export async function codexCliModels(runtime) {
  if (runtime.modelCache && Date.now() - runtime.modelCache.at < 60_000) return runtime.modelCache.data
  if (runtime.modelsPending) return runtime.modelsPending
  runtime.modelsPending = (async () => {
    const account = await runtime.rpc.request('account/read', { refreshToken: false })
    if (!account.account) throw codexCliError('codex_cli_login_required', 401)
    runtime.account = account.account
    const models = []
    let cursor = null
    for (let page = 0; page < 20; page++) {
      const result = await runtime.rpc.request('model/list', { includeHidden: false, limit: 100, cursor })
      models.push(...result.data)
      cursor = result.nextCursor
      if (!cursor) break
    }
    const requirements = await runtime.rpc.request('configRequirements/read')
    const data = { models, requirements: requirements.requirements || requirements }
    runtime.modelCache = { at: Date.now(), data }
    return data
  })()
  try { return await runtime.modelsPending } finally { runtime.modelsPending = null }
}

export async function startCodexCliLogin(exec, { deviceCode = false } = {}) {
  const ready = await ensureCodexCli(exec, { loginSetup: true })
  if (!ready.ok) throw codexCliError(ready.reason, 409)
  if (ready.runtime.inFlight) throw codexCliError('slot_busy', 409)
  const result = await ready.runtime.rpc.request('account/login/start', { type: deviceCode ? 'chatgptDeviceCode' : 'chatgpt' })
  ready.runtime.login = { loginId: result.loginId, completed: false }
  return result
}

export function codexCliLoginStatus(vmId) {
  const runtime = active.get(vmId)
  return { ...codexCliHealth(vmId), login: runtime?.login || null, account: runtime?.account || null }
}
