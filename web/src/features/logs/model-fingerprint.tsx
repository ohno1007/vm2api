import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { Fingerprint, Loader2, Radar, ShieldCheck, Square } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVmPerms } from '@/features/vm/vm-perms'

export type BehavioralFingerprint = {
  verdict: 'unknown' | 'consistent' | 'suspected_mismatch' | 'error'
  reason: string
  identifiedModel: string | null
  expectedModel: string
  vmId: string
  testedAt: string
  expiresAt: string
  stale: boolean
  sampleCount: number
  confidence: 'insufficient' | 'experimental'
  candidates: Array<{
    model: string
    similarity: number
    baselineAt: string
    source: string
  }>
}

const reasons: Record<string, string> = {
  no_trusted_baseline: '尚无可信基准',
  expected_baseline_missing: '缺少所请求模型的基准',
  competitor_baseline_missing: '还需至少一个其他模型基准',
  outside_reference_distribution: '行为偏离现有基准，无法识别',
  models_not_separable: '候选模型表现接近，无法区分',
  behavioral_nearest_reference: '固定探针行为与该模型基准更接近',
  probe_failed: '探测调用异常，无法识别',
}

export function fingerprintLabel(result?: BehavioralFingerprint | null) {
  if (!result) return '未探测'
  if (result.stale) return '已过期'
  if (result.verdict === 'error') return '探测异常'
  if (result.verdict === 'consistent') return '行为相符'
  if (result.verdict === 'suspected_mismatch') return '疑似不符'
  return '证据不足'
}

export function FingerprintBadge({
  result,
}: {
  result?: BehavioralFingerprint | null
}) {
  return (
    <span
      title={
        result
          ? `槽位行为探测 · ${new Date(result.testedAt).toLocaleString()} · ${reasons[result.reason] || result.reason}。这是槽位最近一次主动探测，不是本次请求的模型认证。`
          : '尚未执行固定探针与可信模型基准比对'
      }
      className={cn(
        'mt-0.5 inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
        result?.stale ||
          !result ||
          result.verdict === 'unknown' ||
          result.verdict === 'error'
          ? 'border-border text-muted-foreground'
          : result.verdict === 'consistent'
            ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-600'
            : 'border-amber-500/25 bg-amber-500/5 text-amber-600'
      )}
    >
      <Fingerprint className='size-3' />
      指纹 · {fingerprintLabel(result)}
    </span>
  )
}

type Job = {
  id: string
  vmId: string
  model: string
  kind: string
  status: string
  completed: number
  total: number
  error?: string
}
type State = {
  result: BehavioralFingerprint | null
  baselines: Array<{ model: string; createdAt: string; sampleCount: number }>
  jobs: Job[]
}

export function ModelFingerprintPanel({ row }: { row: UsageLogRow }) {
  const admin = useVmPerms().admin
  const qc = useQueryClient()
  const model = row.model || row.originalModel || ''
  const [referenceModel, setReferenceModel] = useState(model)
  const eligible = Boolean(row.vmId && model.startsWith('gpt-'))
  const key = ['panel', 'model-fingerprints', row.vmId, model]
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      api<State>(
        `/api/panel/model-fingerprints?vmId=${encodeURIComponent(row.vmId || '')}&model=${encodeURIComponent(model)}`
      ),
    enabled: admin && eligible,
    refetchInterval: 3000,
  })
  const run = useMutation({
    mutationFn: (kind: 'probe' | 'baseline') =>
      api('/api/panel/model-fingerprints', {
        method: 'POST',
        body: JSON.stringify({
          vmId: row.vmId,
          model: kind === 'baseline' ? referenceModel : model,
          kind,
        }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key })
      toast.success('指纹任务已开始')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const stop = useMutation({
    mutationFn: () =>
      api('/api/panel/model-fingerprints', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (error: Error) => toast.error(error.message),
  })
  if (!eligible) return null
  const result = query.data?.result || row.modelFingerprint
  const active = query.data?.jobs.find((j) => j.status === 'running')
  const latest = query.data?.jobs[0]
  return (
    <section className='overflow-hidden rounded-xl border bg-gradient-to-br from-muted/35 via-card to-card'>
      <div className='flex items-start justify-between gap-3 border-b p-4'>
        <div>
          <h4 className='flex items-center gap-2 text-sm font-semibold'>
            <Fingerprint className='size-4 text-indigo-500' />
            主动模型指纹
          </h4>
          <p className='mt-1 text-xs text-muted-foreground'>
            8 组固定探针 · 24 次独立请求 · 与官方直连采样基准比对
          </p>
        </div>
        <FingerprintBadge result={result} />
      </div>
      <div className='space-y-4 p-4'>
        {result ? (
          <div className='space-y-2'>
            <div className='text-sm'>
              {result.identifiedModel || reasons[result.reason] || '无法识别'}
              <span className='ml-2 text-xs text-muted-foreground'>
                {result.sampleCount} 个样本 ·{' '}
                {new Date(result.testedAt).toLocaleString()}
              </span>
            </div>
            {result.candidates.map((c) => (
              <div
                key={c.model}
                className='grid grid-cols-[1fr_80px] items-center gap-3 text-xs'
              >
                <div>
                  <div className='mb-1 flex justify-between gap-2'>
                    <span className='font-mono'>{c.model}</span>
                    <span className='text-muted-foreground'>
                      相似度 {(c.similarity * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
                    <div
                      className='h-full rounded-full bg-indigo-500/65'
                      style={{ width: `${c.similarity * 100}%` }}
                    />
                  </div>
                </div>
                <span className='text-right text-muted-foreground'>
                  官方直连基准
                </span>
              </div>
            ))}
            <p className='text-[11px] text-muted-foreground'>
              有效至 {new Date(result.expiresAt).toLocaleString()}
              ；小样本实验识别，相似度不是身份概率。
            </p>
          </div>
        ) : (
          <p className='text-sm text-muted-foreground'>
            尚无该槽位 /
            模型的行为指纹。先建立至少两个候选模型基准，再执行探测。
          </p>
        )}
        {admin ? (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              <Button
                size='sm'
                disabled={Boolean(active) || run.isPending}
                onClick={() => run.mutate('probe')}
              >
                <Radar className='mr-1 size-3.5' />
                探测此槽位
              </Button>
              {active ? (
                <>
                  <Loader2 className='size-3.5 animate-spin text-indigo-500' />
                  <span className='text-xs text-muted-foreground'>
                    {active.kind === 'baseline' ? '校准' : '探测'}{' '}
                    {active.model} · {active.completed}/{active.total}
                  </span>
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={stop.isPending}
                    onClick={() => stop.mutate()}
                  >
                    <Square className='mr-1 size-3' />
                    停止
                  </Button>
                </>
              ) : null}
            </div>
            {latest?.status === 'error' ? (
              <p className='text-xs text-amber-600'>
                最近任务未完成：{latest.error}。失败样本不参与识别。
              </p>
            ) : null}
            <details className='rounded-lg border bg-background/50 p-3'>
              <summary className='cursor-pointer text-xs font-medium'>
                可信模型基准 · {query.data?.baselines.length || 0} 个候选
              </summary>
              <p className='my-2 text-[11px] text-muted-foreground'>
                使用当前槽位凭证，通过 TLS
                直连固定官方地址独立采样，绕过待测网关。每个基准 32 次请求，有效
                7 天；只使用固定公开探针。
              </p>
              <div className='mb-2 flex flex-wrap gap-1'>
                {query.data?.baselines.map((b) => (
                  <span
                    key={b.model}
                    title={new Date(b.createdAt).toLocaleString()}
                    className='rounded bg-muted px-2 py-1 font-mono text-[10px]'
                  >
                    {b.model} · {b.sampleCount}
                  </span>
                ))}
              </div>
              <div className='flex gap-2'>
                <Input
                  aria-label='基准模型'
                  value={referenceModel}
                  onChange={(e) => setReferenceModel(e.target.value)}
                  className='h-8 font-mono text-xs'
                />
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    Boolean(active) ||
                    run.isPending ||
                    !referenceModel.startsWith('gpt-')
                  }
                  onClick={() => run.mutate('baseline')}
                >
                  <ShieldCheck className='mr-1 size-3.5' />
                  校准基准
                </Button>
              </div>
            </details>
          </>
        ) : null}
        <p className='text-[11px] leading-relaxed text-muted-foreground'>
          显示的是该槽位最近一次主动探测，不是这条历史请求的模型认证。候选不足、表现接近或偏离基准均显示“证据不足”，不据此判定降智。
        </p>
      </div>
    </section>
  )
}
