import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { validTimezone } from '../core/timezone.mjs'

/**
 * Source-owned Linux VM identity. These are ordinary QEMU/KVM guests: no copied
 * desktop DMI profiles, private identity generator, or randomized hardware claims.
 * Identities are generated once and survive image upgrades and proxy changes.
 */
export function ensureCodexCliComputer(projectRoot, vm) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(vm?.id || '')) throw new Error('invalid_vm_id')
  const root = path.resolve(projectRoot, 'vms', vm.id, 'kvm')
  const dir = path.join(root, 'fingerprint')
  const file = path.join(dir, 'identity.json')
  if (fs.existsSync(file)) {
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (identity.generator !== 'vm2api-codex-cli-v1') throw new Error('existing_computer_requires_explicit_rebuild')
    if (!/^[0-9a-f]{32}$/.test(identity.machine_id) || !/^[a-z0-9-]{1,63}$/.test(identity.hostname) ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(identity.uuid) || !fs.existsSync(path.join(dir, 'qemu-smbios.args'))) {
      throw new Error('codex_cli_computer_incomplete')
    }
    vm.machine = { ...vm.machine, mac: identity.mac, disk_serial: identity.disk_serial, smbios: { ...identity.smbios, uuid: identity.uuid, serial: identity.disk_serial } }
    return { hostname: identity.hostname, guest_machine_id: identity.machine_id, mac: identity.mac, dir, kvm: true, created: false }
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('existing_computer_requires_explicit_rebuild')
  const identity = {
    generator: 'vm2api-codex-cli-v1', created_at: new Date().toISOString(),
    hostname: `vps-${randomBytes(5).toString('hex')}`, machine_id: randomBytes(16).toString('hex'),
    uuid: randomUUID(), mac: ['02', ...randomBytes(5).toString('hex').match(/../g)].join(':'),
    disk_serial: `vm2api-${randomBytes(8).toString('hex')}`,
    timezone: validTimezone(vm.timezone) || 'UTC', locale: vm.locale || 'en_US.UTF-8',
    smbios: { manufacturer: 'QEMU', product: 'Standard PC (Q35 + ICH9, 2009)', version: 'pc-q35', family: 'Virtual Machine' },
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const temporary = fs.mkdtempSync(path.join(root, '.codex-computer-'))
  try {
    fs.writeFileSync(path.join(temporary, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
    const type1 = `type=1,manufacturer=QEMU,product=Standard PC (Q35 + ICH9,, 2009),version=pc-q35,family=Virtual Machine,serial=${identity.disk_serial},uuid=${identity.uuid}`
    fs.writeFileSync(path.join(temporary, 'qemu-smbios.args'), `-uuid\n${identity.uuid}\n-smbios\n${type1}\n`, { mode: 0o600 })
    if (fs.existsSync(dir)) fs.rmdirSync(dir) // Only the empty directory checked above.
    fs.renameSync(temporary, dir)
  } catch (error) {
    // Only these two known files are ours. Never recursively remove an existing identity.
    for (const name of ['identity.json', 'qemu-smbios.args']) fs.rmSync(path.join(temporary, name), { force: true })
    fs.rmdirSync(temporary)
    throw error
  }
  vm.machine = {
    ...vm.machine, mac: identity.mac, disk_serial: identity.disk_serial,
    smbios: { ...identity.smbios, uuid: identity.uuid, serial: identity.disk_serial },
  }
  return { hostname: identity.hostname, guest_machine_id: identity.machine_id, mac: identity.mac, dir, kvm: true, created: true }
}
