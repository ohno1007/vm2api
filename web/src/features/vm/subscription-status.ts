import type { Vm } from '@/types/panel-vm'
import { expiresAtToMs } from '@/lib/fable-status'
import { isCodexVm } from '@/lib/vm-kind'

const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function subscriptionReadout(vm: Vm, now: number) {
  if (!isCodexVm(vm)) return null
  const expires = expiresAtToMs(vm.chatgpt_subscription_active_until)
  if (!expires || !Number.isFinite(expires))
    return { date: '', full: '', remaining: '', tone: 'unknown' }
  const full = formatter.format(expires)
  const left = expires - now
  return {
    date: full.slice(0, 10),
    full,
    remaining:
      left <= 0
        ? '已到期'
        : left < 86400_000
          ? '不足 1 天'
          : `剩余 ${Math.ceil(left / 86400_000)} 天`,
    tone: left <= 0 ? 'expired' : left < 3 * 86400_000 ? 'soon' : 'active',
  }
}
