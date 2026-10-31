import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

type State = { settings: { enabled: boolean; parallel?: number }; setupAllowed?: boolean; ok?: boolean; version?: string; inFlight?: number; account?: { email?: string }; login?: { completed?: boolean; success?: boolean } }
export function CodexCliPanel({ vm }: { vm: Vm }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [link, setLink] = useState('')
  const key = ['codex-cli', vm.id]
  const base = `/api/panel/vms/${encodeURIComponent(vm.id)}/codex-cli`
  const state = useQuery({ queryKey: key, queryFn: () => api<State>(`${base}/status`), enabled: vm.runtime?.type === 'kvm', staleTime: 30_000 })
  if (vm.runtime?.type !== 'kvm') return null
  async function act(action: string, body?: object) {
    setBusy(true)
    try {
      const result = await api<{ userCode?: string; verificationUrl?: string; authenticated?: boolean }>(`${base}/${action}`, { method: action === 'settings' ? 'PUT' : 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })
      setCode(result.userCode || ''); setLink(result.verificationUrl || '')
      await queryClient.invalidateQueries({ queryKey: key })
      toast.success(result.authenticated ? 'CLI 账号已登录' : '操作完成')
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败') }
    finally { setBusy(false) }
  }
  const enabled = state.data?.settings.enabled === true
  const resting = state.data?.setupAllowed !== true
  return <div className='space-y-2 rounded-md border p-3'>
    <div className='font-medium'>虚拟机内官方 Codex CLI</div>
    <p className='text-muted-foreground text-xs'>复用槽位内进程与代理出口。导入和绑定保持静置；准备后点击登录。请求使用 service_tier 选择 default、priority 或 ultrafast，支持情况由账号决定。</p>
    <p className='text-xs'>{enabled ? '已启用' : '未启用'} · {state.data?.ok ? `运行中 ${state.data.version || ''}` : '未启动'} · 并发 {state.data?.inFlight || 0}</p>
    <div className='flex flex-wrap gap-2'>
      <Button size='sm' variant='outline' disabled={busy} onClick={() => void act('settings', { enabled: !enabled, parallel: 2 })}>{enabled ? '关闭 CLI 引擎' : '启用 CLI 引擎'}</Button>
      <Button size='sm' variant='outline' disabled={busy || !enabled || resting} onClick={() => void act('prepare')}>准备 CLI</Button>
      <Button size='sm' disabled={busy || !enabled || resting} onClick={() => void act('login')}>登录 CLI</Button>
      <Button size='sm' variant='outline' disabled={busy} onClick={() => void state.refetch()}>读取状态</Button>
    </div>
    {resting && <p className='text-muted-foreground text-xs'>调度已关闭：不启动、不登录、不探测。</p>}
    {code && <p className='text-sm'>授权码：<code>{code}</code>{link && <a className='ml-2 underline' href={link} target='_blank' rel='noreferrer'>打开官方授权</a>}</p>}
  </div>
}
