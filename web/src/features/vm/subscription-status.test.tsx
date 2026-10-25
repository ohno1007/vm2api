import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SubscriptionExpiry } from './subscription-expiry'
import { subscriptionReadout } from './subscription-status'

const now = Date.parse('2026-10-23T08:00:00Z')
const vm = (patch: Partial<Vm> = {}) =>
  ({ id: 'vm-01', platform: 'openai', family: 'codex', ...patch }) as Vm

describe('subscription expiry', () => {
  it('shows subscription time in Beijing and never substitutes access-token expiry', () => {
    const account = vm({
      chatgpt_subscription_active_until: '2026-11-20T17:39:17Z',
      expires_at: '2100-01-01T00:00:00Z',
    })
    expect(subscriptionReadout(account, now)?.full).toBe('2026-11-21 01:39')
    const html = renderToStaticMarkup(
      <SubscriptionExpiry vm={account} now={now} />
    )
    expect(html).toContain('2026-11-21')
    expect(html).toContain('北京时间')
    expect(html).not.toContain('2100')
  })
  it('distinguishes absent dates, soon-to-expire and expired subscriptions', () => {
    expect(
      subscriptionReadout(
        vm({ expires_at: new Date(now + 86400_000).toISOString() }),
        now
      )?.tone
    ).toBe('unknown')
    expect(
      subscriptionReadout(
        vm({
          chatgpt_subscription_active_until: new Date(now + 1000).toISOString(),
        }),
        now
      )?.remaining
    ).toBe('不足 1 天')
    expect(
      subscriptionReadout(
        vm({
          chatgpt_subscription_active_until: new Date(now - 1000).toISOString(),
        }),
        now
      )?.tone
    ).toBe('expired')
    expect(
      subscriptionReadout(vm({ platform: 'anthropic', family: 'claude' }), now)
    ).toBeNull()
  })
})
