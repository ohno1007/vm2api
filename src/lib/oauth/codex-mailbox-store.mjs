import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encryptString, decryptString, encryptionEnabled } from '../db/secure.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { createCredentialPool } from './codex-credential-pool.mjs'

export function mailboxError(code, status = 400) {
  const error = new Error(code)
  error.code = code
  error.status = status
  return error
}

export function normalizeMicrosoftEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@(outlook|hotmail|live|msn)\.(com|cn|co\.uk|fr|de|es|it|jp|com\.au|com\.br)$/.test(email)) {
    throw mailboxError('microsoft_email_required')
  }
  return email
}

export function normalizeLoginEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) throw mailboxError('invalid_login_email')
  return email
}

export function normalizeTotpSecret(value) {
  let secret = String(value || '').trim()
  if (/^https?:\/\//i.test(secret)) {
    let url, match
    try {
      url = new URL(secret)
      match = /^\/2fa\/([^/]+)\/?$/.exec(url.pathname)
      if (url.protocol !== 'https:' || url.hostname !== '2fa.run' || url.port ||
        url.username || url.password || url.search || url.hash || !match) throw new Error()
      secret = decodeURIComponent(match[1])
    } catch { throw mailboxError('invalid_totp_secret') }
  } else if (secret.startsWith('otpauth://')) {
    let url
    try { url = new URL(secret) } catch { throw mailboxError('invalid_totp_secret') }
    if (url.hostname !== 'totp' || (url.searchParams.get('algorithm') || 'SHA1').toUpperCase() !== 'SHA1' ||
      Number(url.searchParams.get('digits') || 6) !== 6 || Number(url.searchParams.get('period') || 30) !== 30) throw mailboxError('invalid_totp_secret')
    secret = url.searchParams.get('secret') || ''
  }
  secret = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!/^[A-Z2-7]{16,256}$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8)) throw mailboxError('invalid_totp_secret')
  return secret
}

export function parseLoginBatch(text) {
  if (typeof text !== 'string' || text.length > 600_000) throw mailboxError('invalid_login_batch')
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length || lines.length > 100) throw mailboxError('batch_limit_one_to_hundred')
  const seen = new Set()
  return lines.map((line) => {
    const parts = line.includes('----') ? line.split('----') : line.includes('---') ? line.split('---') : line.split(',')
    if (![2, 3].includes(parts.length)) throw mailboxError('batch_requires_email_password_totp')
    const mode = parts.length === 2 ? 'microsoft_mailbox' : 'password_totp'
    const email = mode === 'microsoft_mailbox' ? normalizeMicrosoftEmail(parts[0]) : normalizeLoginEmail(parts[0])
    const password = parts[1].trim(), totp_secret = mode === 'password_totp' ? normalizeTotpSecret(parts[2]) : undefined
    if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw mailboxError('mailbox_password_required')
    if (seen.has(email)) throw mailboxError('duplicate_login_email')
    seen.add(email)
    return { mode, email, password, totp_secret, auto_reauthorize: true }
  })
}

export function createMailboxStore(projectRoot) {
  const pool = createCredentialPool(projectRoot)
  const directory = path.join(projectRoot, 'data', 'codex-mailbox')
  const fileOf = (id, suffix = 'login') => {
    if (!isValidVmId(id)) throw mailboxError('invalid_vm_id')
    return path.join(directory, `${id}.${suffix}.json`)
  }
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw mailboxError('mailbox_store_unavailable', 500)
    }
  }
  const write = (file, value) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, file)
    } finally { fs.rmSync(tmp, { force: true }) }
  }
  const raw = (id) => {
    const record = readJson(fileOf(id))
    if (!record) return null
    try { return { ...JSON.parse(decryptString(record.sealed)), revision: record.revision } }
    catch { throw mailboxError('mailbox_decryption_failed', 500) }
  }
  const read = (id) => {
    const binding = raw(id)
    if (!binding?.credential_id) return binding
    let credential
    try { credential = pool.read(binding.credential_id) }
    catch (error) { if (error.code === 'credential_not_found') return null; throw error }
    return { ...binding, email: credential.email, password: credential.password, totp_secret: credential.totp_secret,
      mode: credential.mode || 'password_totp', revision: `${binding.revision}:${credential.revision}`,
      login_armed: binding.authorized_revision === credential.revision }
  }
  const summary = (id) => {
    const value = read(id)
    return { configured: !!value, credential_id: value?.credential_id || null, login_armed: value?.login_armed !== false, email: value?.email || '', mode: value?.mode || 'microsoft_mailbox', has_totp: !!value?.totp_secret, has_password: !!value?.password,
      auto_reauthorize: value?.auto_reauthorize === true, updated_at: value?.updated_at || null }
  }
  return {
    read,
    summary,
    pool,
    subscription(id) {
      const value = readJson(fileOf(id, 'subscription'))
      return value?.revision === read(id)?.revision ? value : null
    },
    saveSubscription(id, value) {
      write(fileOf(id, 'subscription'), { ...value, revision: read(id)?.revision })
    },
    clearSubscription(id) { fs.rmSync(fileOf(id, 'subscription'), { force: true }) },
    bind(id, credentialId, owner) {
      if (!encryptionEnabled()) throw mailboxError('mailbox_encryption_required', 503)
      pool.read(credentialId, owner)
      write(fileOf(id), { revision: crypto.randomUUID(), sealed: encryptString(JSON.stringify({ credential_id: credentialId,
        mode: 'password_totp', auto_reauthorize: true, authorized_revision: null, updated_at: new Date().toISOString() })) })
      return summary(id)
    },
    arm(id) {
      const value = raw(id)
      if (!value) return
      if (value.credential_id) value.authorized_revision = pool.read(value.credential_id).revision
      else value.login_armed = true
      delete value.revision
      write(fileOf(id), { revision: crypto.randomUUID(), sealed: encryptString(JSON.stringify(value)) })
    },
    save(id, body) {
      if (!encryptionEnabled()) throw mailboxError('mailbox_encryption_required', 503)
      const previous = read(id)
      const mode = body.mode || 'microsoft_mailbox'
      if (!['microsoft_mailbox', 'password_totp'].includes(mode)) throw mailboxError('invalid_login_mode')
      const email = mode === 'password_totp' ? normalizeLoginEmail(body.email) : normalizeMicrosoftEmail(body.email)
      const retain = previous?.email === email && (previous.mode || 'microsoft_mailbox') === mode
      const password = typeof body.password === 'string' && body.password.length ? body.password
        : retain ? previous.password : ''
      if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw mailboxError('mailbox_password_required')
      if (body.auto_reauthorize != null && typeof body.auto_reauthorize !== 'boolean') throw mailboxError('invalid_auto_reauthorize')
      const totp_secret = mode === 'password_totp' ? normalizeTotpSecret(body.totp_secret || (retain ? previous.totp_secret : '')) : undefined
      const value = { mode, email, password, totp_secret, login_armed: mode === 'password_totp' ? false : undefined,
        auto_reauthorize: body.auto_reauthorize !== false, updated_at: new Date().toISOString() }
      write(fileOf(id), { revision: crypto.randomUUID(), sealed: encryptString(JSON.stringify(value)) })
      return summary(id)
    },
    remove(id) {
      fs.rmSync(fileOf(id), { force: true })
      fs.rmSync(fileOf(id, 'state'), { force: true })
      fs.rmSync(fileOf(id, 'subscription'), { force: true })
    },
    state: (id) => readJson(fileOf(id, 'state')) || null,
    writeState: (id, state) => write(fileOf(id, 'state'), state),
    ids: () => {
      try { return fs.readdirSync(directory).filter((f) => f.endsWith('.login.json')).map((f) => f.slice(0, -11)).filter(isValidVmId) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
    },
  }
}
