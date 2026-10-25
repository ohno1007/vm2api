import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/page-header'
import { loginLabel } from '@/features/vm/codex-password-panel'
import { vmsListQueryOptions } from '@/features/vm/queries'

export type PoolCredential = {
  id: string
  email: string
  mode: string
  has_password: boolean
  has_totp: boolean
  bound_vm_ids: string[]
  updated_at: string
}

export function CredentialsPage() {
  const qc = useQueryClient()
  const pool = useQuery({
    queryKey: ['login-credentials'],
    queryFn: () =>
      api<{ credentials: PoolCredential[] }>('/api/panel/login-credentials'),
  })
  const vmQuery = useQuery(vmsListQueryOptions())
  const vms = vmQuery.data?.items || []
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [targets, setTargets] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  async function refresh() {
    await pool.refetch()
    await qc.invalidateQueries({ queryKey: ['codex-login'] })
  }
  async function importCredentials() {
    setBusy('import')
    try {
      const result = await api<{ created: number; updated: number }>(
        '/api/panel/login-credentials/import',
        { method: 'POST', body: JSON.stringify({ text }) }
      )
      setText('')
      await refresh()
      toast.success(
        `已导入：新增 ${result.created} 个，更新 ${result.updated} 个；未执行登录`
      )
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy('')
    }
  }
  async function action(
    item: PoolCredential,
    name: 'copy' | 'delete' | 'bind' | 'unbind',
    vmId = ''
  ) {
    setBusy(item.id)
    try {
      if (name === 'copy') {
        const data = await api<{
          email: string
          password: string
          totp_secret: string
          mode: string
        }>(`/api/panel/login-credentials/${item.id}/reveal`, {
          method: 'POST',
          body: '{}',
        })
        await navigator.clipboard.writeText(
          data.mode === 'microsoft_mailbox'
            ? `${data.email}---${data.password}`
            : `${data.email}----${data.password}----${data.totp_secret}`
        )
        toast.success('已复制账号及凭据')
      } else if (name === 'delete') {
        await api(`/api/panel/login-credentials/${item.id}`, {
          method: 'DELETE',
        })
        toast.success('已删除凭据')
      } else {
        const target = vmId || targets[item.id]
        const endpoint = `/api/panel/vms/${encodeURIComponent(target)}/oauth/login`
        await api(name === 'bind' ? `${endpoint}/bind` : endpoint, {
          method: name === 'bind' ? 'POST' : 'DELETE',
          body:
            name === 'bind'
              ? JSON.stringify({ credential_id: item.id })
              : undefined,
        })
        toast.success(name === 'bind' ? '已绑定凭据，未执行登录' : '已解除绑定')
      }
      await refresh()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy('')
    }
  }
  const rows = (pool.data?.credentials || []).filter((item) =>
    item.email.toLowerCase().includes(query.trim().toLowerCase())
  )
  return (
    <PageHeader
      title='账号池'
      description='先导入凭据，再绑定到虚拟机；在虚拟机内点击登录，使用该槽位的完整环境完成授权。'
    >
      <div className='mb-4 space-y-3 rounded-lg border p-4'>
        <label className='block space-y-2 text-sm'>
          <span className='font-medium'>导入微软邮箱凭据或 GPT 密码及 2FA</span>
          <Textarea
            aria-label='批量账号凭据'
            rows={5}
            autoComplete='off'
            value={text}
            disabled={!!busy}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              '微软邮箱---邮箱密码\n邮箱----GPT密码----TOTP密钥或2FA链接\n邮箱----GPT密码----https://2fa.run/2fa/密钥\n支持英文逗号分隔，每批 1–100 行'
            }
          />
        </label>
        <p className='text-xs text-muted-foreground'>
          两列格式用于微软邮箱密码登录并读取 GPT 邮件验证码；三列格式用于 GPT
          密码及 2FA 登录。
        </p>
        <p className='text-xs text-muted-foreground'>
          第三项支持 TOTP 密钥、otpauth 链接或
          https://2fa.run/2fa/密钥。系统从链接提取密钥，在槽位内生成验证码，不访问第三方网站。
        </p>
        <p className='text-xs text-muted-foreground'>
          凭据加密保存。重复导入同一邮箱会更新密码及密钥，更新后需要再次手动点击登录。导入和绑定均不启动浏览器、不请求
          GPT，也不要求槽位正在运行。
        </p>
        <Button
          size='sm'
          disabled={!text.trim() || !!busy}
          onClick={() => void importCredentials()}
        >
          仅导入凭据
        </Button>
      </div>
      <div className='mb-3 flex flex-wrap items-center gap-3'>
        <Input
          aria-label='搜索账号'
          className='max-w-sm'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='搜索邮箱'
        />
        <span className='text-sm text-muted-foreground'>
          共 {pool.data?.credentials.length || 0} 个账号
        </span>
        <Button size='sm' variant='outline' onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      {pool.error && (
        <p className='mb-3 text-sm text-destructive'>
          {loginLabel(pool.error.message)}
        </p>
      )}
      {vmQuery.error && (
        <p className='mb-3 text-sm text-destructive'>
          槽位列表加载失败：{vmQuery.error.message}
        </p>
      )}
      <div className='space-y-3'>
        {rows.map((item) => (
          <div
            key={item.id}
            className='flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3'
          >
            <div className='min-w-0 space-y-1'>
              <p className='text-sm font-medium break-all'>{item.email}</p>
              <p className='text-xs text-muted-foreground'>
                {item.mode === 'microsoft_mailbox'
                  ? '微软邮箱密码'
                  : 'GPT 密码'}
                ：{item.has_password ? '已保存' : '未保存'}
                {item.mode !== 'microsoft_mailbox' &&
                  ` · 2FA：${item.has_totp ? '已保存' : '未保存'}`}
              </p>
              <div className='flex flex-wrap gap-2 text-xs'>
                {item.bound_vm_ids.length ? (
                  item.bound_vm_ids.map((id) => (
                    <div key={id} className='flex items-center gap-2'>
                      <Link to='/vm/$id' params={{ id }} className='underline'>
                        {vms.find((vm) => vm.id === id)?.name || id}
                      </Link>
                      <button
                        disabled={!!busy}
                        className='text-muted-foreground underline'
                        onClick={() => void action(item, 'unbind', id)}
                      >
                        解绑
                      </button>
                    </div>
                  ))
                ) : (
                  <span className='text-muted-foreground'>尚未绑定槽位</span>
                )}
              </div>
            </div>
            <div className='flex max-w-full flex-wrap items-center gap-2'>
              {!item.bound_vm_ids.length && (
                <>
                  <select
                    aria-label={`为 ${item.email} 选择槽位`}
                    className='h-9 max-w-full rounded border bg-background px-2 text-xs'
                    value={targets[item.id] || ''}
                    disabled={!!busy}
                    onChange={(e) =>
                      setTargets((previous) => ({
                        ...previous,
                        [item.id]: e.target.value,
                      }))
                    }
                  >
                    <option value=''>选择 GPT 槽位</option>
                    {vms.filter(isCodexVm).map((vm) => (
                      <option key={vm.id} value={vm.id}>
                        {vm.name || vm.id}
                      </option>
                    ))}
                  </select>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={!!busy || !targets[item.id]}
                    onClick={() => void action(item, 'bind')}
                  >
                    绑定
                  </Button>
                </>
              )}
              <Button
                size='sm'
                variant='outline'
                disabled={!!busy}
                onClick={() => void action(item, 'copy')}
              >
                复制凭据
              </Button>
              <Button
                size='sm'
                variant='ghost'
                disabled={!!busy || !!item.bound_vm_ids.length}
                onClick={() => void action(item, 'delete')}
              >
                删除
              </Button>
            </div>
          </div>
        ))}
        {!rows.length && !pool.isPending && (
          <p className='py-8 text-center text-sm text-muted-foreground'>
            暂无账号凭据
          </p>
        )}
      </div>
    </PageHeader>
  )
}
