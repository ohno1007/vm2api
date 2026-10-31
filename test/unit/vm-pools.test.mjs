import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { createVmPool, deleteVmPool, updateVmPool } from '../../src/lib/admin/vm-pools.mjs'
import { applyVmPool, keyScopeFromRecord } from '../../src/lib/admin/key-scope.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const vms = [{ id: 'vm-01' }, { id: 'vm-02' }, { id: 'vm-03' }]

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vm-pools-'))
  const store = new ApiKeyStore({ dataDir: dir })
  return { dir, store, repo: new VmPoolsRepo(store.db) }
}

test('pool membership is shared by keys and applied on the next read', () => {
  const { dir, store, repo } = open()
  try {
    const pool = createVmPool(repo, { name: 'Pool A', vm_ids: ['vm-01', 'vm-02'] }, vms)
    const key = store.create({ name: 'a', vm_pool_id: pool.id })
    const other = store.create({ name: 'b', vm_pool_id: pool.id })
    assert.equal(key.vm_pool_id, pool.id)
    assert.equal(other.vm_pool_id, pool.id)
    const before = applyVmPool(keyScopeFromRecord(store.getById(key.id)), (id) => repo.get(id))
    assert.deepEqual(before.allowed_vms, ['vm-01', 'vm-02'])
    updateVmPool(repo, pool.id, { vm_ids: ['vm-03'] }, vms)
    const after = applyVmPool(keyScopeFromRecord(store.getById(other.id)), (id) => repo.get(id))
    assert.deepEqual(after.allowed_vms, ['vm-03'])
    assert.equal(after.vm_pool_error, null)
    assert.throws(() => createVmPool(repo, { name: 'Pool B', vm_ids: ['vm-03'] }, vms), /其他账号池/)
    assert.equal(
      repo.list().some((item) => item.name === 'Pool B'),
      false,
    )
    updateVmPool(repo, pool.id, { enabled: false }, vms)
    const disabled = applyVmPool(keyScopeFromRecord(store.getById(key.id)), (id) => repo.get(id))
    assert.equal(disabled.vm_pool_error, 'disabled')
    assert.deepEqual(disabled.allowed_vms, [])
    assert.equal(deleteVmPool(repo, pool.id).error, 'vm_pool_in_use')
    store.update(key.id, { vm_pool_id: null })
    store.update(other.id, { vm_pool_id: null })
    assert.equal(deleteVmPool(repo, pool.id).ok, true)
    const gone = applyVmPool(keyScopeFromRecord({ vm_pool_id: pool.id, group_type: 'all' }), (id) => repo.get(id))
    assert.equal(gone.vm_pool_error, 'missing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a slot or pruning removes it from pool membership', () => {
  const { dir, store, repo } = open()
  try {
    const pool = createVmPool(repo, { name: 'P1', vm_ids: ['vm-01', 'vm-02'] }, vms)
    const other = createVmPool(repo, { name: 'P2', vm_ids: ['vm-03'] }, vms)
    assert.equal(repo.removeVm('vm-01'), 1)
    assert.deepEqual(repo.get(pool.id).vm_ids, ['vm-02'])
    assert.deepEqual(repo.get(other.id).vm_ids, ['vm-03'])
    assert.equal(repo.removeVm('vm-01'), 0)
    // A membership left behind by a slot deleted outside the panel.
    repo.db
      .prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)')
      .run(pool.id, 'vm-gone', new Date().toISOString())
    assert.deepEqual(repo.pruneUnknown(['vm-02', 'vm-03']), ['vm-gone'])
    assert.deepEqual(repo.get(pool.id).vm_ids, ['vm-02'])
    assert.deepEqual(repo.get(other.id).vm_ids, ['vm-03'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty pool stays empty instead of meaning every VM', () => {
  const { dir, store, repo } = open()
  try {
    const pool = createVmPool(repo, { name: 'Empty' }, vms)
    const key = store.create({ name: 'e', vm_pool_id: pool.id })
    const scope = applyVmPool(keyScopeFromRecord(store.getById(key.id)), (id) => repo.get(id))
    assert.equal(scope.vm_pool_error, 'empty')
    assert.deepEqual(scope.allowed_vms, [])
    assert.equal(store.list()[0].vm_pool_name, 'Empty')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
