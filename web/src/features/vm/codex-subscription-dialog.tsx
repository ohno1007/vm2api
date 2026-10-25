import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { type LoginStatus, loginLabel } from './codex-password-panel'
import { CodexSubscriptionPanel } from './codex-subscription-panel'

export function CodexSubscriptionDialog({
  vm,
  onOpenChange,
}: {
  vm: Vm
  onOpenChange: (open: boolean) => void
}) {
  const status = useQuery({
    queryKey: ['codex-login', vm.id],
    queryFn: () =>
      api<LoginStatus>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/login`
      ),
    refetchInterval: 2000,
  })
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className='max-h-[90vh] overflow-y-auto sm:max-w-xl'
        onClick={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>自动付费续订 · {vm.id}</DialogTitle>
          <DialogDescription>管理此槽位账号的官网续订设置。</DialogDescription>
        </DialogHeader>
        <CodexSubscriptionPanel
          vm={vm}
          status={status.data}
          refresh={() => status.refetch()}
        />
        {vm.schedulable === false && (
          <p className='text-xs text-amber-600'>
            槽位已关闭调度，保持静置；开启调度后才能读取或修改官网状态。
          </p>
        )}
        {status.error && (
          <p role='alert' className='text-xs text-destructive'>
            {loginLabel(status.error.message)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
