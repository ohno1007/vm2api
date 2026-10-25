import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type LoginStatus, loginLabel } from './codex-password-panel'

export function CodexSubscriptionPanel({
  vm,
  status,
  refresh,
}: {
  vm: Vm
  status?: LoginStatus
  refresh: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const state = status?.subscription
  const savedError = status?.state.error_code
  const message = error || (!state && savedError ? loginLabel(savedError) : '')
  const blocked = busy || vm.schedulable === false || status?.browser.active
  async function apply(enabled?: boolean) {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ enabled: boolean }>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login/subscription`,
        {
          method: 'POST',
          body: JSON.stringify(enabled == null ? {} : { enabled }),
        }
      )
      await refresh()
      toast.success(
        enabled == null
          ? `官网自动续订：${result.enabled ? '已开启' : '已关闭'}`
          : result.enabled
            ? '官网已确认开启自动续订'
            : '官网已确认到期取消续订'
      )
    } catch (cause) {
      setError(loginLabel((cause as Error).message))
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='space-y-2 rounded border p-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <label className='flex items-center gap-2 text-sm'>
          <Switch
            aria-label='自动付费续订套餐'
            checked={state?.enabled === true}
            disabled={!!blocked || !state}
            onCheckedChange={(enabled) => void apply(enabled)}
          />
          自动付费续订套餐
        </label>
        <span className='text-xs text-muted-foreground'>
          {busy
            ? loginLabel(status?.state.stage || 'checking_subscription')
            : state
              ? state.enabled
                ? '已开启'
                : '已关闭'
              : '状态未知'}
        </span>
        <Button
          size='sm'
          variant='outline'
          disabled={!!blocked}
          onClick={() => void apply()}
        >
          读取官网状态
        </Button>
      </div>
      <p className='text-xs text-muted-foreground'>
        使用账号已绑定的支付方式，管理现有套餐的官网自动续订。关闭表示本期到期后取消，开启表示恢复续订。先读取官网状态再修改；每次修改均在当前槽位内执行并核验结果。
      </p>
      {state && (
        <p className='text-xs text-muted-foreground'>
          当前周期至 {new Date(state.period_end).toLocaleDateString()}
          ，上次核验：{new Date(state.checked_at).toLocaleString()}。
        </p>
      )}
      {message && (
        <p role='alert' className='text-xs text-amber-600'>
          {message}
        </p>
      )}
      {(savedError === 'session_not_authenticated' ||
        error === loginLabel('session_not_authenticated')) && (
        <Button size='sm' variant='outline' asChild>
          <Link to='/vm/$id' params={{ id: vm.id }}>
            前往槽位登录 / 远程浏览器
          </Link>
        </Button>
      )}
    </div>
  )
}
