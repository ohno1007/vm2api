import crypto from 'node:crypto'
import { getVm, patchVmRecord, setVmSchedulable } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts, upsertCodexAccount, codexAccessExpiresAt } from '../vm/codex-slot.mjs'
import { hasBoundExit } from '../vm/egress.mjs'
import { hostProxyUrlForVm } from '../vm/slot-host.mjs'
import { clearOpenAIAccountHold } from '../pool/openai-account-runtime.mjs'
import { invalidateLiveCredentialCache } from '../admin/panel-live-credentials.mjs'
import { openaiIdentityFromOauthTokens } from './openai-jwt.mjs'
import { ensureCodexCredential } from './codex-credential-refresh.mjs'
import { generateCodexAuthUrl, exchangeCodexAuthCode, discardCodexAuthSession } from './codex-oauth.mjs'
import { createMailboxStore, mailboxError } from './codex-mailbox-store.mjs'
import { assertMailboxSlotNetwork, runMailboxSlotProcess } from './codex-mailbox-runtime.mjs'
import { mailboxAuthFailure, clearMailboxAuthFailure } from './codex-mailbox-events.mjs'

const instances = new Map()
const NEEDS_ATTENTION = new Set(['captcha_required', 'microsoft_mfa_required', 'mailbox_password_rejected',
  'mailbox_account_locked', 'microsoft_login_needs_attention', 'openai_email_code_unavailable',
  'email_code_rejected', 'openai_password_rejected', 'totp_rejected', 'existing_account_or_phone_required', 'authorized_email_mismatch', 'mailbox_decryption_failed'])

export function createCodexMailboxService({ projectRoot, store = createMailboxStore(projectRoot),
  getSlot = (id) => getVm(projectRoot, id), accountFor = (id) => readCodexAccounts(projectRoot, id)[0] || {},
  checkNetwork = assertMailboxSlotNetwork, runSlot = runMailboxSlotProcess, now = Date.now,
  generate = generateCodexAuthUrl, exchange = exchangeCodexAuthCode,
  refresh = (id, force) => ensureCodexCredential(projectRoot, id, { force }),
  commit = null, onAuthorized = () => {},
} = {}) {
  const jobs = new Map()
  const transientStates = new Map()
  const identityKey = email => crypto.createHash('sha256').update(String(email || '').toLowerCase()).digest('hex')
  let timer = null, guard = null, ticking = false, stopped = false
  const readSlot = (id) => {
    const vm = getSlot(id)
    if (!vm || !isCodexVm(vm)) throw mailboxError('codex_slot_required', 404)
    return vm
  }
  const enabledSlot = (id) => {
    const vm = readSlot(id)
    if (vm.schedulable === false) throw mailboxError('slot_resting', 409)
    if (!['running', 'ok'].includes(vm.status)) throw mailboxError('slot_not_running', 409)
    if (!hasBoundExit(vm.proxy)) throw mailboxError('proxy_required', 409)
    return vm
  }
  const publicState = (id) => {
    const config = store.summary(id)
    let state = jobs.get(id)?.state || transientStates.get(id) || store.state(id)
    if (state?.running && !jobs.has(id)) {
      state = { ...state, running: false, status: 'interrupted', stage: 'interrupted', error_code: 'service_restarted',
        finished_at: new Date(now()).toISOString(), next_attempt_at: now() + 60_000 }
      store.writeState(id, state)
    }
    const savedSubscription = store.subscription(id)
    const subscription = savedSubscription?.account_key === identityKey(store.read(id)?.email || accountFor(id).email) ? savedSubscription : null
    return { ...config, subscription: subscription ? { enabled: subscription.enabled, checked_at: subscription.checked_at, period_end: subscription.period_end } : null,
      browser: { active: jobs.has(id), ready: !!jobs.get(id)?.send, remote: jobs.get(id)?.remote === true }, state: state || { running: false, status: 'idle', stage: 'idle' } }
  }
  const update = (id, patch) => {
    const value = { ...(jobs.get(id)?.state || transientStates.get(id) || store.state(id) || {}), ...patch }
    if (jobs.has(id)) jobs.get(id).state = value
    if (store.read(id)) store.writeState(id, value)
    else transientStates.set(id, value)
    return value
  }
  const stillAllowed = (id, revision, signal) => {
    if (signal.aborted) throw mailboxError('login_cancelled', 409)
    const vm = enabledSlot(id)
    if (store.read(id)?.revision !== revision) throw mailboxError('mailbox_config_changed', 409)
    return vm
  }
  async function commitAccount(id, tokens, expectedEmail) {
    const identity = openaiIdentityFromOauthTokens(tokens)
    if (String(identity.email || '').toLowerCase() !== expectedEmail) throw mailboxError('authorized_email_mismatch', 409)
    if (!tokens.access_token || !tokens.refresh_token) throw mailboxError('oauth_tokens_missing', 502)
    if (commit) return commit(id, tokens)
    const saved = upsertCodexAccount(projectRoot, id, tokens, { replaceCredentials: true })
    patchVmRecord(projectRoot, id, (vm) => {
      vm.codex = { ...(vm.codex || {}), has_access: true, has_refresh: !!saved.refresh_token,
        email: saved.email || null, chatgpt_account_id: saved.chatgpt_account_id || null,
        expires_at: saved.expires_at || null }
      delete vm.codex.refresh_error;delete vm.codex.refresh_error_at
      vm.refresh_error = null;vm.refresh_status = null
      return vm
    })
    clearOpenAIAccountHold(id)
    invalidateLiveCredentialCache()
  }
  async function execute(id, entry, login) {
    const { controller } = entry
    let sessionId = ''
    try {
      let vm = stillAllowed(id, login.revision, controller.signal)
      await checkNetwork(vm)
      update(id, { stage: 'preparing_browser' })
      await runSlot({ projectRoot, vm, action: 'prepare', signal: controller.signal })
      vm = stillAllowed(id, login.revision, controller.signal)
      await checkNetwork(vm)
      const auth = generate({ vmId: id, proxyUrl: hostProxyUrlForVm(vm), installationId: vm.installation_id || vm.id })
      sessionId = auth.session_id
      const outer = new URL(auth.auth_url)
      const inner = outer.searchParams.get('authorize_url')
      const state = new URL(inner || outer).searchParams.get('state')
      if (!state) throw mailboxError('oauth_state_missing', 500)
      update(id, { stage: 'opening_browser' })
      const response = await runSlot({ projectRoot, vm, action: 'login', signal: controller.signal,
        payload: { email: login.email, password: login.password, mode: login.mode || 'microsoft_mailbox', totp_secret: login.totp_secret, auth_url: auth.auth_url, state },
        onStage: (stage) => update(id, { stage }), onControl: (send) => { entry.send = send }, onEvent: event => receive(entry, event),
      })
      vm = stillAllowed(id, login.revision, controller.signal)
      const callback = new URL(response.callback)
      if (callback.origin !== 'http://localhost:1455' || callback.pathname !== '/auth/callback' || callback.searchParams.get('state') !== state) {
        throw mailboxError('oauth_state_mismatch', 409)
      }
      update(id, { stage: 'exchanging_code' })
      const tokens = await exchange({ sessionId, code: response.callback, vmId: id, proxyUrl: hostProxyUrlForVm(vm) })
      stillAllowed(id, login.revision, controller.signal)
      await commitAccount(id, tokens, login.email)
      store.arm(id)
      clearMailboxAuthFailure(projectRoot, id)
      update(id, { running: false, stage: 'completed', status: 'succeeded', error_code: null,
        last_success_at: new Date(now()).toISOString(), finished_at: new Date(now()).toISOString(), failures: 0, next_attempt_at: null })
      try { await onAuthorized(id) } catch { /* Credential commit has already succeeded. */ }
    } catch (error) {
      const code = /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_login_failed'
      const previous = store.state(id) || {}
      const failures = (previous.failures || 0) + 1
      const attention = NEEDS_ATTENTION.has(code)
      update(id, { running: false, stage: code === 'slot_resting' || controller.signal.aborted ? 'cancelled' : 'failed',
        status: attention ? 'needs_attention' : controller.signal.aborted || code === 'slot_resting' ? 'cancelled' : 'failed',
        error_code: code, failures, finished_at: new Date(now()).toISOString(),
        next_attempt_at: attention ? null : now() + Math.min(3600_000, 300_000 * 2 ** Math.min(failures - 1, 4)) })
    } finally {
      if (sessionId) discardCodexAuthSession(sessionId)
      closeRequests(entry)
      jobs.delete(id)
    }
  }
  function start(id, { automatic = false, activateEmpty = false } = {}) {
    if (stopped) throw mailboxError('service_stopped', 409)
    if (jobs.has(id)) {
      if (jobs.get(id).remote) throw mailboxError('mailbox_login_busy', 409)
      return publicState(id)
    }
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const login = store.read(id)
    if (!login) throw mailboxError('mailbox_not_configured', 409)
    const current = readSlot(id)
    // This opt-in is only for an explicit first fill of an empty slot.
    if (!automatic && activateEmpty && current.schedulable === false &&
      ['no_credential', null, undefined].includes(current.schedule_disabled_reason) &&
      !accountFor(id).access_token && !accountFor(id).refresh_token) {
      setVmSchedulable(projectRoot, id, true, null, { preserveStatus: true, source: 'manual' })
    }
    enabledSlot(id)
    const controller = new AbortController()
    const entry = { controller, send: null, promise: null, pending: new Map(), revision: login.revision }
    jobs.set(id, entry)
    update(id, { running: true, job_id: crypto.randomUUID(), status: 'running', stage: 'queued',
      automatic, error_code: null, started_at: new Date(now()).toISOString(), finished_at: null })
    entry.promise = Promise.resolve().then(() => execute(id, entry, login))
    return publicState(id)
  }
  const cancel = (id) => { jobs.get(id)?.controller.abort(); return publicState(id) }
  function closeRequests(entry) {
    for (const pending of entry.pending?.values() || []) { clearTimeout(pending.timer); pending.reject(mailboxError('browser_closed', 409)) }
    entry.pending?.clear()
  }
  function receive(entry, event) {
    const pending = entry.pending?.get(event.id)
    if (!pending) return
    clearTimeout(pending.timer);entry.pending.delete(event.id)
    if (entry.controller.signal.aborted) return pending.reject(mailboxError('slot_resting', 409))
    event.ok ? pending.resolve(event.data) : pending.reject(mailboxError(/^[a-z_]{1,60}$/.test(event.error_code || '') ? event.error_code : 'browser_control_failed', 409))
  }
  function control(id, body) {
    enabledSlot(id)
    const entry = jobs.get(id)
    if (!entry?.send) throw mailboxError('browser_not_ready', 409)
    if (entry.controller.signal.aborted) throw mailboxError('browser_closed', 409)
    const allowed = ['frame', 'takeover', 'resume', 'session', 'tab', 'navigate', 'click', 'wheel', 'key', 'text', 'reload', 'back']
    if (!allowed.includes(body?.op) || JSON.stringify(body).length > 12_000) throw mailboxError('invalid_browser_operation')
    if (entry.pending.size >= 4) throw mailboxError('browser_control_busy', 409)
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const timer = setTimeout(() => { entry.pending.delete(requestId);reject(mailboxError('browser_control_timeout', 504)) }, 40_000)
      timer.unref?.()
      entry.pending.set(requestId, { resolve, reject, timer })
      entry.send({ ...body, id: requestId })
    })
  }
  function remote(id) {
    if (stopped) throw mailboxError('service_stopped', 409)
    const vm = enabledSlot(id)
    if (jobs.has(id)) return publicState(id)
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const entry = { controller: new AbortController(), pending: new Map(), send: null, remote: true, revision: store.read(id)?.revision }
    jobs.set(id, entry)
    update(id, { running: true, status: 'running', stage: 'preparing_browser', error_code: null })
    entry.promise = Promise.resolve().then(async () => {
      try {
        await checkNetwork(vm)
        await runSlot({ projectRoot, vm, action: 'prepare', signal: entry.controller.signal })
        const current = enabledSlot(id)
        if (entry.controller.signal.aborted) throw mailboxError('login_cancelled', 409)
        await checkNetwork(current)
        const email = store.read(id)?.email || accountFor(id).email || ''
        await runSlot({ projectRoot, vm: current, action: 'remote', signal: entry.controller.signal,
          payload: { remote: true, email, profile_id: id },
          onStage: stage => update(id, { stage }), onControl: send => { entry.send = send }, onEvent: event => receive(entry, event) })
      } catch (error) {
        update(id, { error_code: /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_control_failed' })
      } finally {
        update(id, { running: false, status: 'idle', stage: 'idle' })
        closeRequests(entry);jobs.delete(id)
      }
    })
    return publicState(id)
  }
  async function browserTask(id, operation, options = {}) {
    if (stopped) throw mailboxError('service_stopped', 409)
    const vm = enabledSlot(id)
    if (operation === 'session' && jobs.has(id)) return control(id, { op: 'session' })
    if (jobs.size) throw mailboxError('mailbox_login_busy', 409)
    const entry = { controller: new AbortController(), pending: new Map(), send: null, revision: store.read(id)?.revision }
    const email = store.read(id)?.email || accountFor(id).email || ''
    if (!email) throw mailboxError('mailbox_not_configured', 409)
    jobs.set(id, entry)
    update(id, { running: true, status: 'running', stage: operation === 'session' ? 'exporting_session' : 'checking_subscription', error_code: null })
    entry.promise = Promise.resolve().then(async () => {
      try {
        await checkNetwork(vm)
        update(id, { stage: 'preparing_browser' })
        await runSlot({ projectRoot, vm, action: 'prepare', signal: entry.controller.signal })
        const current = stillAllowed(id, entry.revision, entry.controller.signal)
        await checkNetwork(current)
        update(id, { stage: operation === 'session' ? 'exporting_session' : 'checking_subscription' })
        const result = await runSlot({ projectRoot, vm: current, action: operation, signal: entry.controller.signal,
          payload: { operation, email, profile_id: id, ...options } })
        stillAllowed(id, entry.revision, entry.controller.signal)
        if ((store.read(id)?.email || accountFor(id).email || '') !== email) throw mailboxError('mailbox_config_changed', 409)
        if (operation === 'subscription') {
          if (typeof result?.enabled !== 'boolean' || !Number.isFinite(Date.parse(result.period_end)) ||
            Date.parse(result.period_end) <= now() ||
            (typeof options.enabled === 'boolean' && result.enabled !== options.enabled)) throw mailboxError('subscription_verification_failed', 502)
          const verified = { enabled: result.enabled, period_end: result.period_end, checked_at: new Date(now()).toISOString(), account_key: identityKey(email) }
          store.saveSubscription(id, verified)
          return { enabled: verified.enabled, period_end: verified.period_end, checked_at: verified.checked_at }
        }
        if (!result?.accessToken) throw mailboxError('session_not_authenticated', 409)
        if (String(result.user?.email || '').toLowerCase() !== email.toLowerCase()) throw mailboxError('authorized_email_mismatch', 409)
        return result
      } catch (error) {
        if (operation === 'subscription' && typeof options.enabled === 'boolean') store.clearSubscription(id)
        update(id, { error_code: /^[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'browser_control_failed' })
        throw error
      } finally {
        update(id, { running: false, status: 'idle', stage: 'idle' })
        closeRequests(entry);jobs.delete(id)
      }
    })
    return entry.promise
  }
  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      for (const id of store.ids()) {
        try {
          const login = store.read(id), vm = getSlot(id)
          if (stopped) break
          if (!login?.auto_reauthorize || login.login_armed === false || !vm || !isCodexVm(vm) || vm.schedulable === false || !['running', 'ok'].includes(vm.status)) continue
          const state = publicState(id).state
          if (jobs.size || state.status === 'needs_attention' || Number(state.next_attempt_at || 0) > now()) continue
          const account = accountFor(id)
          const failed = mailboxAuthFailure(projectRoot, id)
          const expiry = codexAccessExpiresAt(account)
          if (!failed && !account.refresh_error && account.access_token && (!expiry || expiry > now() + 10 * 60_000)) continue
          if (account.refresh_token && !account.refresh_error) {
            // Prefer normal grant rotation before opening a browser.
            const refreshed = await refresh(id, !!failed)
            if (stopped) break
            enabledSlot(id)
            if (refreshed.ok) { clearMailboxAuthFailure(projectRoot, id); continue }
            if (refreshed.refresh_class !== 'fatal' && refreshed.refresh_class !== 'unsupported') continue
          }
          start(id, { automatic: true })
          break
        } catch { /* One bad configuration must not touch or block other slots. */ }
      }
    } finally { ticking = false }
  }
  const guardJobs = () => {
    for (const [id, job] of jobs) {
      try {
        enabledSlot(id)
        if (store.read(id)?.revision !== job.revision) job.controller.abort()
      } catch { job.controller.abort() }
    }
  }
  return {
    status(id) { readSlot(id); return publicState(id) },
    save(id, body) {
      readSlot(id)
      if (jobs.has(id)) throw mailboxError('mailbox_login_busy', 409)
      store.save(id, body)
      update(id, { running: false, status: 'idle', stage: 'idle', error_code: null, failures: 0, next_attempt_at: null })
      return publicState(id)
    },
    start, cancel, tick, remote, control,
    session(id) { return browserTask(id, 'session') },
    subscription(id, body = {}) {
      if (body.enabled != null && typeof body.enabled !== 'boolean') throw mailboxError('invalid_subscription_setting')
      return browserTask(id, 'subscription', body.enabled == null ? {} : { enabled: body.enabled })
    },
    poolList(owner, visibleIds) {
      const visible = new Set(visibleIds)
      const bindings = new Map()
      for (const id of store.ids()) {
        if (!visible.has(id)) continue
        try {
          const credentialId = store.summary(id).credential_id
          if (credentialId) bindings.set(credentialId, [...(bindings.get(credentialId) || []), id])
        } catch { /* A corrupt slot configuration must not reveal or block another record. */ }
      }
      return store.pool.list(owner).map(record => ({ ...record, bound_vm_ids: bindings.get(record.id) || [] }))
    },
    poolImport(text, owner) { return store.pool.import(text, owner) },
    poolReveal(credentialId, owner) {
      const record = store.pool.read(credentialId, owner)
      return { email: record.email, password: record.password, totp_secret: record.totp_secret || '', mode: record.mode }
    },
    poolRemove(credentialId, owner) {
      store.pool.read(credentialId, owner)
      if (store.ids().some(id => store.summary(id).credential_id === credentialId)) throw mailboxError('credential_bound', 409)
      store.pool.remove(credentialId, owner)
    },
    bind(id, credentialId, owner) {
      readSlot(id)
      if (jobs.has(id)) throw mailboxError('mailbox_login_busy', 409)
      store.pool.read(credentialId, owner)
      if (store.ids().some(other => other !== id && store.summary(other).credential_id === credentialId)) throw mailboxError('credential_bound_elsewhere', 409)
      store.bind(id, credentialId, owner)
      update(id, { running: false, status: 'idle', stage: 'waiting_manual_login', error_code: null, failures: 0, next_attempt_at: null })
      clearMailboxAuthFailure(projectRoot, id)
      return publicState(id)
    },
    verificationCode(id, code) {
      const job = jobs.get(id)
      if (!job?.send || store.state(id)?.stage !== 'waiting_mfa') throw mailboxError('no_verification_pending', 409)
      enabledSlot(id)
      if (!/^[A-Za-z0-9-]{4,12}$/.test(String(code || ''))) throw mailboxError('invalid_verification_code')
      job.send({ verification_code: String(code) })
      return publicState(id)
    },
    remove(id) { jobs.get(id)?.controller.abort();store.remove(id);transientStates.delete(id);clearMailboxAuthFailure(projectRoot, id) },
    startMonitor() {
      if (timer) return
      stopped = false
      timer = setInterval(() => { void tick().catch(() => {}) }, 30_000);timer.unref?.()
      guard = setInterval(guardJobs, 2000);guard.unref?.()
      queueMicrotask(() => { void tick().catch(() => {}) })
    },
    guardJobs,
    stop() { stopped = true;clearInterval(timer);clearInterval(guard);timer = null;guard = null;for (const job of jobs.values()) job.controller.abort() },
    async settle() { await Promise.all([...jobs.values()].map((job) => job.promise)) },
  }
}

export function codexMailboxService(projectRoot) {
  if (!instances.has(projectRoot)) instances.set(projectRoot, createCodexMailboxService({ projectRoot }))
  return instances.get(projectRoot)
}
