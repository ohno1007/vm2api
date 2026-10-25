import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { api, panelFetch } from '@/lib/api'
import { downloadChatgptSession } from '@/lib/codex-session-export'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type LoginStatus, loginLabel } from './codex-password-panel'
import { CodexSubscriptionPanel } from './codex-subscription-panel'

type Frame = {
  image: string
  width: number
  height: number
  active: number
  paused: boolean
  tabs: { index: number; url: string }[]
}
export function CodexBrowserPanel({ vm }: { vm: Vm }) {
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login`
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [url, setUrl] = useState('https://chatgpt.com/')
  const owned = useRef(false)
  const status = useQuery({
    queryKey: ['codex-login', vm.id],
    queryFn: () => api<LoginStatus>(endpoint),
    refetchInterval: open ? 2000 : false,
  })
  const enabled =
    open && vm.schedulable !== false && status.data?.browser.ready === true
  const frame = useQuery({
    queryKey: ['codex-browser-frame', vm.id],
    queryFn: () =>
      api<Frame>(`${endpoint}/control`, {
        method: 'POST',
        body: JSON.stringify({ op: 'frame' }),
      }),
    enabled,
    refetchInterval: enabled ? 900 : false,
    retry: false,
    gcTime: 0,
  })
  useEffect(
    () => () => {
      if (owned.current)
        void panelFetch(`${endpoint}/cancel`, {
          method: 'POST',
          body: '{}',
        }).catch(() => {})
    },
    [endpoint]
  )
  async function control(op: string, data: Record<string, unknown> = {}) {
    try {
      await api(`${endpoint}/control`, {
        method: 'POST',
        body: JSON.stringify({ op, ...data }),
      })
      if (op === 'text') setText('')
      await frame.refetch()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    }
  }
  async function start() {
    setBusy(true)
    setOpen(true)
    try {
      const result = await api<LoginStatus>(`${endpoint}/remote`, {
        method: 'POST',
        body: '{}',
      })
      owned.current = result.browser.remote
      await status.refetch()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  async function stop() {
    setBusy(true)
    try {
      await api(`${endpoint}/cancel`, { method: 'POST', body: '{}' })
      owned.current = false
      setOpen(false)
      await status.refetch()
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
    }
  }
  async function download() {
    setBusy(true)
    try {
      await downloadChatgptSession(vm.id)
      toast.success('已导出当前浏览器的 ChatGPT Session')
    } catch (error) {
      toast.error(loginLabel((error as Error).message))
    } finally {
      setBusy(false)
      void status.refetch()
    }
  }
  const manual = status.data?.browser.remote || frame.data?.paused
  const usable = enabled && manual
  return (
    <div className='space-y-2 border-t pt-3'>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={busy || vm.schedulable === false}
          onClick={() => void start()}
        >
          {open ? '连接远程屏幕' : '打开远程浏览器'}
        </Button>
        <Button
          size='sm'
          variant='outline'
          disabled={
            busy ||
            vm.schedulable === false ||
            (status.data?.browser.active && !manual)
          }
          onClick={() => void download()}
        >
          导出 ChatGPT Session
        </Button>
        {open && (
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => void stop()}
          >
            停止浏览器任务
          </Button>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        Session 导出读取此槽位浏览器的
        https://chatgpt.com/api/auth/session。已登录可直接导出，无需先打开远程屏幕；未登录时会提示先登录。自动授权中请先接管屏幕。
      </p>
      <CodexSubscriptionPanel
        vm={vm}
        status={status.data}
        refresh={() => status.refetch()}
      />
      {open && (
        <>
          <p aria-live='polite' className='text-xs'>
            {loginLabel(status.data?.state.stage || 'preparing_browser')}
            {status.data?.state.error_code &&
              ` · ${loginLabel(status.data.state.error_code)}`}
          </p>
          <div className='flex flex-wrap gap-2'>
            {!status.data?.browser.remote && (
              <Button
                size='sm'
                variant='outline'
                disabled={!enabled}
                onClick={() => void control(manual ? 'resume' : 'takeover')}
              >
                {manual ? '继续自动登录' : '接管鼠标键盘'}
              </Button>
            )}
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => void control('back')}
            >
              后退
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => void control('reload')}
            >
              刷新
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!usable}
              onClick={() => {
                setUrl('https://chatgpt.com/')
                void control('navigate', { url: 'https://chatgpt.com/' })
              }}
            >
              ChatGPT
            </Button>
          </div>
          <div className='flex gap-2'>
            <Input
              aria-label='远程浏览器地址'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              size='sm'
              disabled={!usable}
              onClick={() => void control('navigate', { url })}
            >
              前往
            </Button>
          </div>
          {frame.data && enabled && (
            <>
              <div className='flex flex-wrap gap-1'>
                {frame.data.tabs.map((tab) => (
                  <Button
                    key={tab.index}
                    size='sm'
                    variant={
                      tab.index === frame.data.active ? 'default' : 'outline'
                    }
                    className='max-w-64 truncate'
                    onClick={() => void control('tab', { index: tab.index })}
                  >
                    {tab.index + 1}. {tab.url}
                  </Button>
                ))}
              </div>
              <div
                tabIndex={0}
                role='application'
                aria-label='槽位远程屏幕，可点击并输入'
                className='overflow-hidden rounded border bg-black focus:ring-2 focus:ring-primary'
                onKeyDown={(event) => {
                  if (!usable) return
                  event.preventDefault()
                  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key))
                    return
                  if (
                    event.key.length === 1 &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    !event.metaKey
                  ) {
                    void control('text', { text: event.key })
                    return
                  }
                  const key = `${event.ctrlKey ? 'Control+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.metaKey ? 'Meta+' : ''}${event.key === ' ' ? 'Space' : event.key}`
                  void control('key', { key })
                }}
                onWheel={(event) => {
                  if (usable)
                    void control('wheel', { x: event.deltaX, y: event.deltaY })
                }}
              >
                <img
                  alt='槽位浏览器实时屏幕'
                  src={`data:image/jpeg;base64,${frame.data.image}`}
                  className='w-full select-none'
                  draggable={false}
                  onClick={(event) => {
                    if (!usable) return
                    event.currentTarget.parentElement?.focus()
                    const rect = event.currentTarget.getBoundingClientRect()
                    void control('click', {
                      x: ((event.clientX - rect.left) / rect.width) * 1365,
                      y: ((event.clientY - rect.top) / rect.height) * 900,
                    })
                  }}
                />
              </div>
            </>
          )}
          {frame.error && (
            <p className='text-xs text-amber-600'>
              {loginLabel(frame.error.message)}
            </p>
          )}
          <div className='flex gap-2'>
            <Input
              aria-label='向浏览器输入文字'
              type='password'
              autoComplete='new-password'
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='向已聚焦的输入框发送文字'
            />
            <Button
              size='sm'
              disabled={!usable || !text}
              onClick={() => void control('text', { text })}
            >
              输入
            </Button>
            <Button
              size='sm'
              disabled={!usable}
              onClick={() => void control('key', { key: 'Enter' })}
            >
              Enter
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
