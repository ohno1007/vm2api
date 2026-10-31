import fs from 'node:fs'
import path from 'node:path'
import { readCodexAccounts, upsertCodexAccount, codexAccessExpiresAt } from './codex-slot.mjs'
import { atomicWriteJson } from './vm-file.mjs'

function authFile(root, vmId) { return path.join(root, 'vms', vmId, 'cli-home', '.codex-vm2api', 'auth.json') }

/** Explicit preparation only; import/bind never starts CLI or rotates a grant. */
export function seedCodexCliAuth(root, vm) {
  const file = authFile(root, vm.id)
  if (fs.existsSync(file)) return { reused: true }
  const account = readCodexAccounts(root, vm.id)[0]
  if (!account?.access_token || !account?.refresh_token || !account?.id_token) return { loginRequired: true }
  const dir = path.dirname(file)
  const owner = fs.statSync(path.dirname(dir))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWriteJson(file, {
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: account.access_token, refresh_token: account.refresh_token, id_token: account.id_token, account_id: account.chatgpt_account_id || null },
    last_refresh: account.refreshed_at || new Date().toISOString(),
  }, { mode: 0o600 })
  if (process.platform !== 'win32') { fs.chownSync(dir, owner.uid, owner.gid); fs.chownSync(file, owner.uid, owner.gid) }
  return { seeded: true }
}

/** Official CLI alone refreshes. Mirror locally without a control-plane network request. */
export function syncCodexCliAuth(root, vmId) {
  let auth
  try { auth = JSON.parse(fs.readFileSync(authFile(root, vmId), 'utf8')) } catch { return false }
  const token = auth.tokens
  if (!token?.access_token || !token?.refresh_token) return false
  const previous = readCodexAccounts(root, vmId)[0]
  if (previous?.access_token === token.access_token && previous?.refresh_token === token.refresh_token) return true
  upsertCodexAccount(root, vmId, {
    access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token,
    chatgpt_account_id: token.account_id, expires_at: codexAccessExpiresAt(token),
    refreshed_at: auth.last_refresh || new Date().toISOString(), refresh_error: null,
  })
  return true
}

export function clearCodexCliAuth(root, vmId) { fs.rmSync(authFile(root, vmId), { force: true }) }
