import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encryptString, decryptString, encryptionEnabled } from '../db/secure.mjs'
import { mailboxError, parseLoginBatch } from './codex-mailbox-store.mjs'

export function createCredentialPool(projectRoot) {
  const directory = path.join(projectRoot, 'data', 'codex-login-pool')
  const file = path.join(directory, 'credentials.json')
  const read = () => {
    try { return JSON.parse(decryptString(JSON.parse(fs.readFileSync(file, 'utf8')).sealed)) }
    catch (error) { if (error.code === 'ENOENT') return []; throw mailboxError('credential_pool_unavailable', 500) }
  }
  const write = records => {
    if (!encryptionEnabled()) throw mailboxError('mailbox_encryption_required', 503)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });fs.chmodSync(directory, 0o700)
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify({ sealed: encryptString(JSON.stringify(records)) }), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, file)
    } finally { fs.rmSync(tmp, { force: true }) }
  }
  const visible = (record, owner) => owner?.admin === true || record.owner === owner?.id
  const summary = record => ({ id: record.id, email: record.email, mode: record.mode,
    has_password: !!record.password, has_totp: !!record.totp_secret, created_at: record.created_at, updated_at: record.updated_at })
  return {
    list(owner) { return read().filter(record => visible(record, owner)).map(summary) },
    read(id, owner) {
      const record = read().find(record => record.id === id)
      if (!record || (owner && !visible(record, owner))) throw mailboxError('credential_not_found', 404)
      return record
    },
    import(text, owner) {
      if (!owner?.id) throw mailboxError('credential_owner_required', 403)
      const incoming = parseLoginBatch(text), records = read()
      let created = 0, updated = 0
      for (const record of incoming) {
        const old = records.find(item => item.owner === owner.id && item.email === record.email)
        const time = new Date().toISOString()
        const next = { ...record, id: old?.id || `cred-${crypto.randomUUID()}`, owner: owner.id,
          created_at: old?.created_at || time, updated_at: time, revision: crypto.randomUUID() }
        if (old) { records[records.indexOf(old)] = next;updated++ } else { records.push(next);created++ }
      }
      write(records)
      return { created, updated, total: incoming.length }
    },
    remove(id, owner) {
      const records = read(), record = records.find(record => record.id === id)
      if (!record || !visible(record, owner)) throw mailboxError('credential_not_found', 404)
      write(records.filter(item => item.id !== id))
    },
  }
}
