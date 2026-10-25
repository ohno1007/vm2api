import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PoolCredential } from '@/features/credentials'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions } from './queries'

export type LoginStatus = {
  credential_id: string | null
  login_armed: boolean
  configured: boolean
  email: string
  mode: string
  has_password: boolean
  has_totp: boolean
  auto_reauthorize: boolean
  subscription?: {
    enabled: boolean
    checked_at: string
    period_end: string
  } | null
  browser: { active: boolean; ready: boolean; remote: boolean }
  state: {
    running: boolean
    status: string
    stage: string
    error_code?: string
    job_id?: string
  }
}
const labels: Record<string, string> = {
  web_session_ready: 'ChatGPT 网页会话已登录，继续授权 Codex',
  waiting_manual_login: '已绑定，等待点击登录',
  credential_bound_elsewhere: '该凭据已绑定其他槽位，请先解除绑定',
  credential_bound: '请先解除槽位绑定再删除',
  invalid_login_email: '邮箱格式无效',
  credential_not_found: '凭据不存在或无权访问',
  idle: '等待操作',
  queued: '等待登录',
  running: '进行中',
  preparing_browser: '准备槽内浏览器，首次安装需要几分钟',
  opening_browser: '启动浏览器',
  openai_login: '登录 GPT',
  openai_password: '验证 GPT 密码',
  totp_submitted: '验证 TOTP',
  waiting_mfa: '需要手动输入邮件或身份验证码',
  oauth_consent: '确认授权',
  exchanging_code: '保存授权',
  completed: '已完成',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  skipped_existing: '已存在，跳过',
  manual_control: '已由人工接管',
  captcha_required: '需要人工验证，请打开远程屏幕处理',
  remote_ready: '远程浏览器已就绪',
  insufficient_enabled_empty_slots:
    '可用空槽位不足，请先准备已开启调度、绑定出口的空 GPT 槽位',
  duplicate_login_email: '批量内容包含重复邮箱',
  invalid_totp_secret:
    '2FA 格式无效，请填写 TOTP 密钥、otpauth 链接或 https://2fa.run/2fa/密钥，不能填写六位验证码',
  mailbox_login_busy: '已有浏览器任务，请等待完成或先停止',
  slot_resting: '槽位已关闭调度，请先开启调度',
  authorized_email_mismatch: '登录返回的账号不一致，未覆盖授权',
  openai_password_rejected: 'GPT 密码未通过',
  totp_rejected: 'TOTP 验证未通过',
  batch_requires_email_password_totp:
    '每行填写微软邮箱---邮箱密码，或邮箱----GPT密码----2FA密钥/链接',
  microsoft_email_required:
    '两列格式仅支持 Outlook / Hotmail / Live / MSN 微软邮箱',
  mailbox_not_configured: '请先绑定邮箱凭据或导入带邮箱信息的账号授权',
  exporting_session: '正在导出当前槽位 ChatGPT Session',
  browser_prepare_failed:
    '浏览器环境准备失败，请重试；若持续失败请检查槽位浏览器运行环境',
  browser_runtime_unavailable:
    '槽位浏览器运行环境不可用，请检查独立运行包是否已安装',
  browser_runtime_invalid: '浏览器运行包校验失败，请重新安装匹配版本',
  browser_launch_failed: '浏览器无法启动，请检查槽位运行依赖和可写目录',
  browser_packages_failed: '浏览器依赖下载或安装失败，请检查槽位出口网络',
  checking_subscription: '正在读取官网自动续订状态',
  opening_subscription: '正在打开官网订阅管理',
  updating_subscription: '正在修改官网自动续订',
  subscription_paid_plan_required: '需要已有的 ChatGPT 付费订阅',
  subscription_needs_attention: '订阅或付款需要处理，请通过远程屏幕查看官网',
  subscription_period_ended: '当前订阅已到期，请先在官网处理套餐',
  subscription_status_unrecognized: '无法识别官网续订状态，请通过远程屏幕查看',
  subscription_portal_unavailable:
    '无法自动打开官网订阅管理，请通过远程屏幕查看',
  subscription_action_unavailable:
    '官网未提供对应的续订操作，请通过远程屏幕查看',
  subscription_confirmation_required: '官网需要额外确认，请通过远程屏幕处理',
  subscription_verification_failed:
    '未能确认官网续订结果，请读取官网状态后核对',
  batch_limit_one_to_hundred: '每批支持 1–100 个账号',
  browser_not_ready: '浏览器正在准备，请稍后重试',
  session_not_authenticated:
    '此槽位尚未登录 ChatGPT 网页。请先绑定凭据并点击登录，或在远程浏览器登录后重试；API 授权不能代替网页会话',
  takeover_required: '请先点击接管，再操作屏幕',
  browser_closed: '浏览器已关闭',
}
export const loginLabel = (code: string) => labels[code] || code

export function CodexPasswordPanel({ vm }: { vm: Vm }) {
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login`
  const qc = useQueryClient()
  const status = useQuery({
    queryKey: ['codex-login', vm.id],
    queryFn: () => api<LoginStatus>(endpoint),
    refetchInterval: 2000,
  })
  const pool = useQuery({
    queryKey: ['login-credentials'],
    queryFn: () =>
      api<{ credentials: PoolCredential[] }>('/api/panel/login-credentials'),
  })
  const [selected, setSelected] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const notified = useRef('')
  const canActivateEmpty =
    !vm.has_token &&
    !vm.has_refresh &&
    vm.schedulable === false &&
    (!vm.schedule_disabled_reason ||
      vm.schedule_disabled_reason === 'no_credential')
  useEffect(() => {
    setSelected(status.data?.credential_id || '')
  }, [status.data?.credential_id])
  useEffect(() => {
    const signature =
      status.data?.state.status === 'succeeded' ? status.data.state.job_id : ''
    if (!signature || notified.current === signature) return
    notified.current = signature
    void qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    void qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey })
  }, [status.data, qc, vm.id])
  async function perform(action: string) {
    setBusy(true)
    try {
      await api(action === 'remove' ? endpoint : `${endpoint}/${action}`, {
        method: action === 'remove' ? 'DELETE' : 'POST',
        body:
          action === 'remove'
            ? undefined
            : JSON.stringify(
                action === 'bind'
                  ? { credential_id: selected }
                  : action === 'verify'
                    ? { code }
                    : action === 'start'
                      ? { activate_empty: canActivateEmpty }
                      : {}
              ),
      })
      setCode('')
      await Promise.all([status.refetch(), pool.refetch()])
      toast.success(
        action === 'bind'
          ? '已绑定凭据，点击登录后才会执行'
          : action === 'start'
            ? '已开始使用当前槽位环境登录'
            : '操作已完成'
      )
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  const running = status.data?.state.running === true
  return (
    <div className='space-y-3 rounded border p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='text-sm font-medium'>绑定的登录凭据</span>
        <Link to='/credentials' className='text-xs underline'>
          管理账号池
        </Link>
      </div>
      {status.data?.configured ? (
        <div className='space-y-1 text-sm'>
          <p className='break-all'>{status.data.email}</p>
          <p className='text-xs text-muted-foreground'>
            {status.data.mode === 'password_totp'
              ? 'GPT 密码：已保存 · 2FA 密钥：已保存'
              : '微软邮箱密码：已保存'}{' '}
            · {status.data.login_armed ? '已完成登录' : '等待手动点击登录'}
          </p>
        </div>
      ) : (
        <p className='text-xs text-muted-foreground'>
          尚未绑定登录凭据。导入和绑定均不执行登录。
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        <select
          aria-label='选择账号池凭据'
          className='h-9 min-w-0 flex-1 rounded border bg-background px-2 text-sm'
          value={selected}
          disabled={busy || running}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value=''>从账号池选择凭据</option>
          {pool.data?.credentials.map((item) => (
            <option
              key={item.id}
              value={item.id}
              disabled={
                item.bound_vm_ids.length > 0 &&
                !item.bound_vm_ids.includes(vm.id)
              }
            >
              {item.email}
              {item.bound_vm_ids.length
                ? ` · ${item.bound_vm_ids.join(', ')}`
                : ''}
            </option>
          ))}
        </select>
        <Button
          size='sm'
          variant='outline'
          disabled={
            !selected ||
            busy ||
            running ||
            selected === status.data?.credential_id
          }
          onClick={() => void perform('bind')}
        >
          绑定凭据
        </Button>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          disabled={
            !status.data?.configured ||
            busy ||
            running ||
            (vm.schedulable === false && !canActivateEmpty) ||
            vm.can_import_credential === false
          }
          onClick={() => void perform('start')}
        >
          登录
        </Button>
        {status.data?.configured && (
          <Button
            size='sm'
            variant='ghost'
            disabled={busy || running}
            onClick={() => void perform('remove')}
          >
            解除绑定
          </Button>
        )}
        {running && (
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => void perform('cancel')}
          >
            停止登录
          </Button>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        点击登录后，使用当前槽位的浏览器、代理及网络环境完成授权。首次登录成功后才允许授权失效自动重登；关闭调度时保持静置。
      </p>
      {vm.schedulable === false && (
        <p className='text-xs text-amber-600'>
          {canActivateEmpty
            ? '该空槽位因缺少授权暂停调度，点击登录时会开启调度。'
            : '当前槽位已关闭调度，开启后才能登录。'}
        </p>
      )}
      {status.data && (
        <div aria-live='polite' className='text-xs'>
          {loginLabel(status.data.state.stage)}
          {status.data.state.error_code && (
            <p className='text-amber-600'>
              {loginLabel(status.data.state.error_code)}
            </p>
          )}
        </div>
      )}
      {running && status.data?.state.stage === 'waiting_mfa' && (
        <div className='flex gap-2'>
          <Input
            aria-label='手动验证码'
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete='one-time-code'
          />
          <Button
            size='sm'
            disabled={!code || busy}
            onClick={() => void perform('verify')}
          >
            提交验证码
          </Button>
        </div>
      )}
      {(status.error || pool.error) && (
        <p className='text-xs text-destructive'>
          {loginLabel((status.error || pool.error)?.message || '')}
        </p>
      )}
    </div>
  )
}
