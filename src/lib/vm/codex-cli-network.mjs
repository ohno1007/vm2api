import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { slotExecContainer } from './slot-exec.mjs'
import { slotNetworkForVm, portsForProxy, bridgeName } from './egress.mjs'

export function codexCliNetworkRules(vm, ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '')) throw new Error('cli_network_ip_missing')
  const ports = portsForProxy(vm.proxy.id)
  const bridge = bridgeName(vm.proxy.id)
  const chain = `CLI_${createHash('sha256').update(`${vm.id}:${vm.proxy.id}`).digest('hex').slice(0, 12)}`
  return { chain, rules: [
    ['-t', 'filter', chain, '-p', 'tcp', '-m', 'multiport', '--dports', `${ports.tcp},${ports.dns}`, '-j', 'ACCEPT'],
    ['-t', 'filter', chain, '-p', 'udp', '--dport', String(ports.dns), '-j', 'ACCEPT'],
    ['-t', 'filter', chain, '-j', 'DROP'],
  ], hooks: [
    ['-t', 'filter', 'INPUT', '-i', bridge, '-s', ip, '-j', chain],
    ['-t', 'filter', 'FORWARD', '-i', bridge, '-s', ip, '-j', 'DROP'],
  ] }
}

function iptables(args) {
  const prefix = String(process.env.KIN_EGRESS_CMD_PREFIX || '').trim().split(/\s+/).filter(Boolean)
  try { execFileSync(prefix[0] || 'iptables', prefix.length ? [...prefix.slice(1), 'iptables', ...args] : args, { stdio: 'ignore', timeout: 8000 }); return true } catch { return false }
}
function op(rule, operation, first = false) { return [...rule.slice(0, 2), operation, rule[2], ...(first ? ['1'] : []), ...rule.slice(3)] }

/** Restrict this slot's runner address only; other slots sharing a proxy are unaffected. */
export function configureCodexCliNetwork(vm, { verifyOnly = false } = {}) {
  const container = JSON.parse(execFileSync('docker', ['inspect', slotExecContainer(vm)], { encoding: 'utf8', timeout: 8000 }))[0]
  const ip = container.NetworkSettings?.Networks?.[slotNetworkForVm(vm)]?.IPAddress
  const { chain, rules, hooks } = codexCliNetworkRules(vm, ip)
  if (verifyOnly) return [...rules, ...hooks].every(r => iptables(op(r, '-C')))
  iptables(['-t', 'filter', '-N', chain])
  for (const rule of rules) if (!iptables(op(rule, '-C')) && !iptables(op(rule, '-A'))) throw new Error('cli_network_rule_failed')
  for (const rule of hooks) if (!iptables(op(rule, '-C')) && !iptables(op(rule, '-I', true))) throw new Error('cli_network_hook_failed')
  return true
}
