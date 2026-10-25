import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions } from '@/features/vm/queries'
import type { CommitResult } from './credential-panel'

type MailboxStatus = {
  configured: boolean
  email: string
  has_password: boolean
  auto_reauthorize: boolean
  state: {
    running: boolean
    job_id?: string
    status: string
    stage: string
    error_code?: string | null
    last_success_at?: string | null
    next_attempt_at?: number | null
  }
}

const STAGES: Record<string, string> = {
  idle: '尚未开始登录',
  queued: '等待登录',
  preparing_browser: '准备槽内浏览器（首次安装可能需要几分钟）',
  opening_browser: '启动槽内浏览器',
  mailbox_login: '登录微软邮箱',
  microsoft_email: '填写微软邮箱',
  microsoft_password: '验证微软邮箱密码',
  mailbox_ready: '邮箱已就绪',
  openai_login: '登录 GPT',
  waiting_email_code: '等待并读取 GPT 邮件验证码',
  email_code_submitted: '已提交邮件验证码',
  waiting_mfa: '需要输入身份验证器或短信验证码',
  verifying: '正在验证',
  oauth_consent: '确认 Codex 授权',
  exchanging_code: '保存新授权',
  completed: '登录授权完成',
  cancelled: '任务已取消',
  interrupted: '上次登录被服务重启中断',
  failed: '本次登录未完成',
}

const ERRORS: Record<string, string> = {
  slot_resting: '该槽位已关闭调度，自动登录保持暂停。请先开启调度。',
  mailbox_not_configured: '请先保存微软邮箱和密码。',
  microsoft_email_required: '请填写 Outlook、Hotmail、Live 或 MSN 微软邮箱。',
  mailbox_password_required: '请填写微软邮箱密码。',
  mailbox_password_rejected: '微软邮箱密码不正确，请更新后重试。',
  mailbox_account_locked: '微软账号已锁定，需要先在微软完成解锁。',
  microsoft_login_needs_attention:
    '微软登录需要人工处理，请完成账号验证后重试。',
  microsoft_mfa_required: '微软要求额外身份验证，邮箱密码不足以完成本次登录。',
  captcha_required: '登录遇到人机验证，需要人工处理；自动任务已暂停。',
  existing_account_or_phone_required:
    '账号需要注册资料或手机号验证，请先完成后再授权。',
  openai_email_code_unavailable:
    'GPT 暂未提供邮箱验证码登录，请使用 OAuth 方式完成授权。',
  authorized_email_mismatch: '返回的 GPT 账号与填写邮箱不一致，未覆盖原授权。',
  email_code_timeout: '未及时收到 GPT 验证邮件，请稍后重试。',
  email_code_rejected: '邮件验证码未通过，请稍后重试。',
  mailbox_session_expired: '微软邮箱会话失效，请重新登录。',
  browser_prepare_failed:
    '槽内浏览器准备失败，请检查槽位的网络与可用磁盘后重试。',
  browser_runtime_missing: '槽内浏览器尚未准备好，请重新登录以安装。',
  browser_login_failed: '浏览器登录未完成，原授权已保留，可稍后重试。',
  mailbox_login_busy: '已有邮箱登录任务正在执行，请等待或先取消。',
  slot_not_running: '请先启动该槽位。',
  slot_egress_mismatch: '槽位的容器出口与绑定代理不一致，请先修复出口。',
  mailbox_encryption_required:
    '服务器尚未配置凭证加密密钥，暂时不能保存邮箱密码。',
  login_timeout: '本次登录超时，可稍后重试。',
  login_cancelled: '登录任务已取消。',
  service_restarted: '服务重启中断了上次登录。',
}

function errorText(code: string) {
  return ERRORS[code] || `操作未完成（${code}）`
}

export function CodexMailboxPanel({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: CommitResult, vmId: string, what: string) => void
}) {
  const qc = useQueryClient()
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/microsoft-mailbox`
  const key = ['codex-mailbox', vm.id]
  const status = useQuery({
    queryKey: key,
    queryFn: () => api<MailboxStatus>(endpoint),
    refetchInterval: 2000,
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [auto, setAuto] = useState(true)
  const [verificationCode, setVerificationCode] = useState('')
  const initialized = useRef('')
  const submitted = useRef(false)
  const notified = useRef('')

  useEffect(() => {
    if (status.data && initialized.current !== vm.id) {
      setEmail(status.data.email || '')
      setAuto(status.data.configured ? status.data.auto_reauthorize : true)
      setPassword('')
      initialized.current = vm.id
    }
  }, [status.data, vm.id])

  useEffect(() => {
    const state = status.data?.state
    if (
      !submitted.current ||
      state?.status !== 'succeeded' ||
      !state.job_id ||
      notified.current === state.job_id
    )
      return
    notified.current = state.job_id
    submitted.current = false
    void Promise.all([
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
    ]).then(() => {
      toast.success('微软邮箱登录成功，已保存 GPT 授权')
      onCommitted?.(
        { oauth_email: status.data?.email },
        vm.id,
        '已完成微软邮箱自动授权'
      )
    })
  }, [status.data, vm.id, qc, onCommitted])

  const configured = status.data?.configured === true
  const savedPassword =
    status.data?.has_password &&
    status.data.email.toLowerCase() === email.trim().toLowerCase()
  const running = status.data?.state.running === true
  const empty = !vm.has_token && !vm.has_refresh
  const resting = vm.schedulable === false
  const canActivateEmpty =
    empty &&
    resting &&
    (!vm.schedule_disabled_reason ||
      vm.schedule_disabled_reason === 'no_credential')
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const save = useMutation({
    mutationFn: async (login: boolean) => {
      await api<MailboxStatus>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password, auto_reauthorize: auto }),
      })
      setPassword('')
      if (login) {
        submitted.current = true
        return api<MailboxStatus>(`${endpoint}/start`, {
          method: 'POST',
          body: JSON.stringify({ activate_empty: canActivateEmpty }),
        })
      }
      return null
    },
    onSuccess: async (_data, login) => {
      await refresh()
      toast.success(login ? '已启动槽内登录' : '已保存邮箱设置')
    },
    onError: (error: Error) => {
      void refresh()
      toast.error(errorText(error.message))
    },
  })
  const action = useMutation({
    mutationFn: (name: 'cancel' | 'remove' | 'verify') =>
      api<MailboxStatus>(name === 'remove' ? endpoint : `${endpoint}/${name}`, {
        method: name === 'remove' ? 'DELETE' : 'POST',
        body:
          name === 'verify'
            ? JSON.stringify({ code: verificationCode })
            : undefined,
      }),
    onSuccess: async (_data, name) => {
      if (name === 'verify') setVerificationCode('')
      if (name === 'remove') {
        initialized.current = ''
        setEmail('')
        setPassword('')
        submitted.current = false
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(errorText(error.message)),
  })
  const busy = save.isPending || action.isPending || running
  const valid = !!email.trim() && (!!password || savedPassword)
  const state = status.data?.state
  return (
    <div className='space-y-3'>
      <p className='text-xs text-muted-foreground'>
        使用微软邮箱和邮箱密码登录，自动读取 GPT 邮件验证码并完成 Codex
        授权。登录在本槽位内运行，使用本槽位出口。
      </p>
      <div className='space-y-1'>
        <Label htmlFor={`mailbox-email-${vm.id}`}>微软邮箱</Label>
        <Input
          id={`mailbox-email-${vm.id}`}
          type='email'
          autoComplete='off'
          value={email}
          disabled={busy || status.isPending}
          onChange={(event) => setEmail(event.target.value)}
          placeholder='name@outlook.com'
        />
      </div>
      <div className='space-y-1'>
        <Label htmlFor={`mailbox-password-${vm.id}`}>微软邮箱密码</Label>
        <Input
          id={`mailbox-password-${vm.id}`}
          type='password'
          autoComplete='new-password'
          value={password}
          disabled={busy || status.isPending}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={
            savedPassword ? '密码已加密保存，留空则保留' : '填写微软邮箱密码'
          }
        />
      </div>
      <label className='flex items-center gap-2 text-sm'>
        <input
          type='checkbox'
          checked={auto}
          disabled={busy}
          onChange={(event) => setAuto(event.target.checked)}
        />
        授权失效后自动重新登录
      </label>
      <p className='text-xs text-muted-foreground'>
        先尝试正常刷新授权，失败后再登录。关闭调度时保持静置。额外身份验证或人机验证可能需要人工处理。
      </p>
      {resting && !canActivateEmpty ? (
        <p className='text-xs text-amber-600'>
          该槽位已关闭调度，可以保存设置；开启调度后才能登录。
        </p>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          disabled={
            !valid || busy || status.isPending || (resting && !canActivateEmpty)
          }
          loading={save.isPending}
          onClick={() => save.mutate(true)}
        >
          {canActivateEmpty ? '开启调度并登录' : '保存并登录授权'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={!valid || busy || status.isPending}
          onClick={() => save.mutate(false)}
        >
          仅保存
        </Button>
        {running ? (
          <Button
            size='sm'
            variant='outline'
            disabled={action.isPending}
            onClick={() => action.mutate('cancel')}
          >
            取消登录
          </Button>
        ) : null}
        {configured && !running ? (
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => action.mutate('remove')}
          >
            移除保存的邮箱
          </Button>
        ) : null}
      </div>
      {status.error ? (
        <p className='text-xs text-destructive'>
          {errorText(status.error.message)}
        </p>
      ) : null}
      {state && (configured || running) ? (
        <div
          aria-live='polite'
          className='space-y-1 rounded-md border px-3 py-2 text-xs'
        >
          <p>{STAGES[state.stage] || state.stage}</p>
          {state.error_code ? (
            <p className='text-amber-600'>{errorText(state.error_code)}</p>
          ) : null}
          {state.last_success_at ? (
            <p className='text-muted-foreground'>
              最近授权成功：{new Date(state.last_success_at).toLocaleString()}
            </p>
          ) : null}
          {state.next_attempt_at && auto && !resting ? (
            <p className='text-muted-foreground'>
              下次尝试：{new Date(state.next_attempt_at).toLocaleString()}
            </p>
          ) : null}
        </div>
      ) : null}
      {running && state?.stage === 'waiting_mfa' ? (
        <div className='flex items-end gap-2'>
          <div className='flex-1 space-y-1'>
            <Label htmlFor={`mailbox-code-${vm.id}`}>
              身份验证器或短信验证码
            </Label>
            <Input
              id={`mailbox-code-${vm.id}`}
              autoComplete='one-time-code'
              value={verificationCode}
              onChange={(event) => setVerificationCode(event.target.value)}
            />
          </div>
          <Button
            size='sm'
            disabled={!verificationCode.trim() || action.isPending}
            onClick={() => action.mutate('verify')}
          >
            提交验证码
          </Button>
        </div>
      ) : null}
    </div>
  )
}
