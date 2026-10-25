import { panelFetch } from '@/lib/api'

export async function downloadChatgptSession(vmId: string) {
  const response = await panelFetch(
    `/api/panel/vms/${encodeURIComponent(vmId)}/oauth/login/session`,
    { method: 'POST', body: '{}' }
  )
  if (!response.ok) {
    const error = (await response.json()) as { error?: { code?: string } }
    throw new Error(error.error?.code || 'session_export_failed')
  }
  const blob = await response.blob()
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = `${vmId}-chatgpt-session.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}
