import fs from 'node:fs'
import path from 'node:path'
import { getVm, patchVmRecord } from '../src/lib/vm/vm-registry.mjs'
import { startVmRuntime } from '../src/lib/vm/vm-runtime.mjs'
import { stageCodexCliBinary } from '../src/lib/transport/codex-cli-supervisor.mjs'
import { seedCodexCliAuth } from '../src/lib/vm/codex-cli-auth.mjs'
import { canRunCodexCli } from '../src/lib/vm/codex-cli-config.mjs'

const root = process.env.KIN_PROJECT_ROOT
const id = process.argv[2]
if (!root || !/^[a-zA-Z0-9_-]+$/.test(id || '')) throw new Error('Usage: KIN_PROJECT_ROOT=... node scripts/codex-cli-prepare.mjs vm-id')
const vm = getVm(root, id)
if (!vm?.codex_cli?.enabled || !canRunCodexCli(vm, { loginSetup: true })) throw new Error('enabled_cli_slot_required')
const result = await startVmRuntime(vm, root)
if (!result.ok) { console.error(JSON.stringify({ ok: false, error: result.error, code: result.code })); process.exit(1) }
patchVmRecord(root, id, { machine: vm.machine, fingerprint: vm.fingerprint, status: 'running', runtime: result.runtime || vm.runtime })
const staged = await stageCodexCliBinary(root, vm, { loginSetup: true })
const auth = seedCodexCliAuth(root, vm)
console.log(JSON.stringify({ ok: true, slot: id, binary: staged, auth }))
