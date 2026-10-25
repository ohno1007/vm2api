import type { Vm } from '@/types/panel-vm'
import { cn } from '@/lib/utils'
import { subscriptionReadout } from './subscription-status'

export function SubscriptionExpiry({
  vm,
  now,
  full = false,
  showLabel = true,
  className,
}: {
  vm: Vm
  now: number
  full?: boolean
  showLabel?: boolean
  className?: string
}) {
  const sub = subscriptionReadout(vm, now)
  if (!sub) return null
  return (
    <span
      className={cn(
        'block text-[11px] leading-relaxed tabular-nums',
        sub.tone === 'expired'
          ? 'text-destructive'
          : sub.tone === 'soon'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
        className
      )}
      title={
        sub.full
          ? `订阅到期：${sub.full}（北京时间）`
          : '上游凭证未提供订阅到期时间'
      }
    >
      {showLabel ? '订阅 ' : ''}
      {full ? sub.full || '未提供' : sub.date || '到期时间未提供'}
      {sub.remaining ? ` · ${sub.remaining}` : ''}
    </span>
  )
}
