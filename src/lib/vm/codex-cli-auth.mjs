import fs from 'node:fs'
import path from 'node:path'
import { readCodexAccounts, upsertCodexAccount, codexAccessExpiresAt } from './codex-slot.mjs'
import { atomicWriteJson } from './vm-file.mjs'
import { getVm, clearUnschedulable } from './vm-registry.mjs'
import { canRunCodexCli } from './codex-cli-config.mjs'

function authFile(root, vmId) { return path.join(root, 'vms', vmId, 'cli-home', '.codex-vm2api', 'auth.json') }

/** Metadata only: refresh near expiry, not once per inference. */
export function codexCliTokenNeedsRefresh(root, vmId, now = Date.now()) {
  try {
    const auth = JSON.parse(fs.readFileSync(authFile(root, vmId), 'utf8'))
    const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString('utf8'))
    if (Number.isFinite(claims.exp)) return claims.exp * 1000 < now + 120_000
    return !(Date.parse(auth.last_refresh) > now - 600_000)
  } catch { return true }
}

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
  if (previous?.access_token === token.access_token && previous?.refresh_token === token.refresh_token &&
      (!token.id_token || previous?.id_token === token.id_token) &&
      (!token.account_id || previous?.chatgpt_account_id === token.account_id)) return true
  const changedAccount = !!(token.account_id && previous?.chatgpt_account_id && token.account_id !== previous.chatgpt_account_id)
  upsertCodexAccount(root, vmId, {
    access_token: token.access_token, refresh_token: token.refresh_token, id_token: token.id_token || (changedAccount ? null : previous?.id_token),
    chatgpt_account_id: token.account_id, expires_at: codexAccessExpiresAt(token),
    refreshed_at: auth.last_refresh || new Date().toISOString(), refresh_error: null,
  }, { replaceCredentials: changedAccount })
  return true
}

export function clearCodexCliAuth(root, vmId) { fs.rmSync(authFile(root, vmId), { force: true }) }

/** A completed explicit login may lift only the missing-credential hold. */
export function completeCodexCliLogin(root, vmId) {
  const vm = getVm(root, vmId)
  if (!vm?.codex_cli?.enabled || !canRunCodexCli(vm, { loginSetup: true })) return false
  if (!syncCodexCliAuth(root, vmId)) return false
  clearUnschedulable(root, vmId, { by: 'credential_present', only: ['no_credential'] })
  return true
}
