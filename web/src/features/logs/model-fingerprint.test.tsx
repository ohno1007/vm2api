import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FingerprintBadge, fingerprintLabel, type BehavioralFingerprint } from './model-fingerprint'

const result = (verdict: BehavioralFingerprint['verdict']): BehavioralFingerprint => ({ verdict, reason: 'behavioral_nearest_reference',
  identifiedModel: 'gpt-6.1-sol', expectedModel: 'gpt-6.1-sol', vmId: 'vm-01', testedAt: '2026-10-23T12:00:00Z',
  expiresAt: '2026-10-23T18:00:00Z', stale: false, sampleCount: 24, confidence: 'experimental', candidates: [] })

describe('active fingerprint log badge', () => {
  it('distinguishes matching, mismatching, unknown, errors and expired results', () => {
    expect(fingerprintLabel(result('consistent'))).toBe('行为相符')
    expect(fingerprintLabel(result('suspected_mismatch'))).toBe('疑似不符')
    expect(fingerprintLabel(result('unknown'))).toBe('证据不足')
    expect(fingerprintLabel(result('error'))).toBe('探测异常')
    expect(fingerprintLabel({ ...result('consistent'), stale: true })).toBe('已过期')
    expect(fingerprintLabel(null)).toBe('未探测')
  })
  it('describes the cached slot probe rather than certifying a historical request', () => {
    const html = renderToStaticMarkup(<FingerprintBadge result={result('consistent')} />)
    expect(html).toContain('主动探测')
    expect(html).toContain('不是本次请求的模型认证')
  })
})
