import { useEffect, useMemo, useState } from 'react'
import type { PersonaPreset } from '@/types/panel-routing'
import { Check, ChevronDown, RotateCcw } from 'lucide-react'
import {
  DEFAULT_PERSONA_TEMPLATES,
  PERSONA_PRESET_OPTIONS,
  PERSONA_PRESETS,
  formatLineError,
  parsePersonaTemplateLines,
  personaPresetFromCompat,
  personaPresetLabel,
  presetSeed,
  stringifyPersonaTemplate,
  templateSlotState,
  validatePersonaTemplate,
  type RawBlock,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  type PersonaDrafts,
  personaDraftStoresEmpty,
  personaSchemeSummary,
  personaTemplatesPayload,
  seedPersonaDrafts,
} from '@/features/settings/persona-drafts'
import {
  Notice,
  PersonaTemplateEditor,
  Problems,
} from '@/features/settings/persona-editors'
import { InjectCard } from './inject-card'
import { SystemPreview } from './system-preview'

type Compat = Record<string, unknown>

/** 草稿能解析就用草稿块，否则（空 / 有错）用后端会回落到的内置模板。 */
function effectiveBlocks(text: string, preset: PersonaPreset): RawBlock[] {
  const { blocks, errors } = parsePersonaTemplateLines(text)
  if (!errors.length && blocks.length) return blocks
  return presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
}

function PresetBar({
  active,
  viewing,
  summaries,
  onView,
}: {
  active: PersonaPreset
  viewing: PersonaPreset
  summaries: Record<PersonaPreset, string>
  onView: (preset: PersonaPreset) => void
}) {
  return (
    <div
      role='tablist'
      aria-label='system 提示词档位'
      className='grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5'
    >
      {PERSONA_PRESET_OPTIONS.map(([key, label]) => {
        const selected = key === viewing
        return (
          <button
            key={key}
            type='button'
            role='tab'
            aria-selected={selected}
            onClick={() => onView(key)}
            className={cn(
              'flex cursor-pointer flex-col items-start gap-1 rounded-xl border px-3.5 py-2.5 text-left transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              selected
                ? 'border-primary/50 bg-primary/5'
                : 'border-border/60 bg-card hover:border-border hover:bg-muted/40'
            )}
          >
            <span className='flex w-full items-center gap-2'>
              <span className='text-sm font-medium'>{label}</span>
              {key === active ? (
                <span className='ml-auto flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400'>
                  <Check className='size-3' aria-hidden />
                  生效
                </span>
              ) : null}
            </span>
            <span className='text-[11px] text-muted-foreground'>
              {summaries[key]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function SystemPromptWorkspace({
  compat,
  server,
  onChange,
  onProblemsChange,
}: {
  compat: Compat
  server: Compat | undefined
  onChange: (next: Compat) => void
  onProblemsChange: (problems: string[]) => void
}) {
  const [drafts, setDrafts] = useState<PersonaDrafts | null>(null)
  const active = personaPresetFromCompat(compat)
  const [viewing, setViewing] = useState<PersonaPreset>(active)
  const [templateOpen, setTemplateOpen] = useState(false)

  useEffect(() => {
    if (drafts || !Object.keys(compat).length) return
    setDrafts(seedPersonaDrafts(compat))
    setViewing(personaPresetFromCompat(compat))
  }, [compat, drafts])

  const problems = useMemo(() => {
    if (!drafts) return []
    const out: string[] = []
    for (const key of PERSONA_PRESETS) {
      const at = key === active ? '' : `「${personaPresetLabel(key)}」`
      const parsed = parsePersonaTemplateLines(drafts[key])
      for (const err of parsed.errors)
        out.push(`模板${at}${formatLineError(err)}`)
      for (const msg of validatePersonaTemplate(parsed.blocks))
        out.push(`模板${at}${msg}`)
    }
    return out
  }, [drafts, active])

  useEffect(() => {
    onProblemsChange(problems)
  }, [problems, onProblemsChange])

  if (!drafts) {
    return <p className='text-sm text-muted-foreground'>读取中…</p>
  }

  const setDraft = (text: string) => {
    const next = { ...drafts, [viewing]: text }
    setDrafts(next)
    onChange({ ...compat, persona_templates: personaTemplatesPayload(next) })
  }

  const text = drafts[viewing]
  const parsed = parsePersonaTemplateLines(text)
  const hasErrors = parsed.errors.length > 0
  const blocks = effectiveBlocks(text, viewing)
  const summaries = Object.fromEntries(
    PERSONA_PRESETS.map((key) => [key, personaSchemeSummary(drafts[key], key)])
  ) as Record<PersonaPreset, string>

  return (
    <div className='space-y-4'>
      <PresetBar
        active={active}
        viewing={viewing}
        summaries={summaries}
        onView={setViewing}
      />

      <div className='grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]'>
        <div className='min-w-0 space-y-4'>
          {viewing !== active ? (
            <div className='flex items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-2.5'>
              <span className='text-sm text-muted-foreground'>
                正在查看「{personaPresetLabel(viewing)}」，当前生效「
                {personaPresetLabel(active)}」
              </span>
              <Button
                type='button'
                size='sm'
                className='cursor-pointer'
                onClick={() =>
                  onChange({
                    ...compat,
                    persona_preset: viewing,
                    persona_templates: personaTemplatesPayload(drafts),
                  })
                }
              >
                设为生效
              </Button>
            </div>
          ) : null}

          {viewing === 'official_303' ? (
            <div className='space-y-1.5 rounded-xl border bg-muted/30 px-4 py-3 text-xs leading-5'>
              <p className='font-medium'>按模型分流，版本 2.1.303</p>
              <p className='text-muted-foreground'>
                Opus 4.8 / 5 / 5.5、Fable、Mythos 等：下面三块 system；调用方
                system 放进第一条 user 的 &lt;system-reminder&gt;（官方调用方的
                system 不出站）；Environment 作为尾部
                role=system；最后一条与上一条 user 的末尾非 thinking 块打点（共
                3–4 个断点），TTL 取协议页的缓存 TTL。
              </p>
              <p className='text-muted-foreground'>
                Sonnet、Haiku、Opus 4.0–4.7：沿用现有 cli-hop
                结构，只把版本号换成 2.1.303，不使用这里的模板。实际生效值见
                设置 → 协议 → 当前出站参照。
              </p>
            </div>
          ) : null}

          <InjectCard
            compat={compat}
            server={server}
            preset={viewing}
            blocks={blocks}
            standing='switch'
            env={templateSlotState(blocks, 'env')}
            onChange={onChange}
          />

          <Collapsible open={templateOpen} onOpenChange={setTemplateOpen}>
            <Card className='gap-0 py-0'>
              <div className='flex items-center gap-2 px-4 py-2.5'>
                <CollapsibleTrigger asChild>
                  <button
                    type='button'
                    className='flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left'
                  >
                    <ChevronDown
                      className={cn(
                        'size-4 text-muted-foreground transition-transform duration-200',
                        templateOpen ? 'rotate-0' : '-rotate-90'
                      )}
                      aria-hidden
                    />
                    <span className='text-sm font-medium'>模板</span>
                    <span className='truncate text-xs text-muted-foreground'>
                      {summaries[viewing]} · {blocks.length} 块
                    </span>
                  </button>
                </CollapsibleTrigger>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='h-7 cursor-pointer text-xs'
                  onClick={() =>
                    setDraft(
                      stringifyPersonaTemplate(
                        presetSeed(DEFAULT_PERSONA_TEMPLATES, viewing)
                      )
                    )
                  }
                >
                  <RotateCcw />
                  恢复预设
                </Button>
              </div>
              <CollapsibleContent className='space-y-3 border-t border-border/60 px-4 py-3'>
                {viewing === 'custom' &&
                personaDraftStoresEmpty(text, 'custom') ? (
                  <Notice tone='caution'>空模板会回落官方提示词。</Notice>
                ) : null}
                <PersonaTemplateEditor
                  key={viewing}
                  text={text}
                  blocks={
                    parsed.blocks.length
                      ? parsed.blocks
                      : presetSeed(DEFAULT_PERSONA_TEMPLATES, viewing)
                  }
                  hasErrors={hasErrors}
                  onTextChange={setDraft}
                  onBlocksChange={(next) =>
                    setDraft(stringifyPersonaTemplate(next))
                  }
                />
              </CollapsibleContent>
            </Card>
          </Collapsible>

          <Problems items={problems} />
        </div>

        <aside className='min-w-0 xl:sticky xl:top-20'>
          <SystemPreview preset={viewing} blocks={blocks} compat={compat} />
        </aside>
      </div>
    </div>
  )
}
