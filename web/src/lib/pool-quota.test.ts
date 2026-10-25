import type { Vm } from '@/types/panel-vm'
import { describe, expect, it } from 'vitest'
import { poolQuota, windowProbed } from './pool-quota'
import { bladeState } from '@/features/vm/vm-rack-model'

const slot = (id: string, five: number | null, seven: number | null): Vm => ({
  id, platform: 'openai', family: 'codex', has_token: true,
  availability: { key: 'ok', text: '可用', usable: true },
  utilization_5h: five == null ? null : five / 100,
  utilization_7d: seven == null ? null : seven / 100,
  codex_usage: { windows: [
    { id: '5h', used_percent: five },
    { id: '7d', used_percent: seven },
  ] },
})

describe('measured pool quota', () => {
  it('excludes unknown windows from available capacity and remaining quota', () => {
    const { windows: [five, seven] } = poolQuota([
      slot('measured', 20, 100), slot('unknown', null, null), slot('partial', null, 50),
    ])
    expect(five.capacity).toBe(1)
    expect(five.remainAccounts).toBeCloseTo(0.8)
    expect(five.remainPct).toBeCloseTo(80)
    expect(five.segs).toHaveLength(3)
    expect(seven.capacity).toBe(2)
    expect(seven.remainAccounts).toBeCloseTo(0.5)
  })

  it('all unknown means zero confirmed remainder, while measured zero is valid', () => {
    const vm = slot('new', null, null)
    const { windows: [five] } = poolQuota([vm])
    expect(five.capacity).toBe(0)
    expect(five.remainAccounts).toBe(0)
    expect(five.remainPct).toBe(0)
    expect(bladeState(vm)).toBe('unprobed')
    const zero = slot('zero', 0, 0)
    expect(windowProbed(zero, '5h')).toBe(true)
    expect(bladeState(zero)).toBe('live')
    expect(poolQuota([zero]).windows[0].remainAccounts).toBe(1)
  })

  it('does not treat nonnumeric readings as measured quota', () => {
    expect(windowProbed(slot('bad', NaN, Infinity), '5h')).toBe(false)
    expect(windowProbed(slot('bad', NaN, Infinity), '7d')).toBe(false)
  })
})
