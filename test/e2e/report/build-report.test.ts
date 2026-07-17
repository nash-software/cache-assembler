import { describe, expect, it } from 'vitest'
import {
  buildReportHtml,
  computeCacheHitRate,
  computeEstSavedUsd,
  type HarnessOutput,
} from './build-report.js'

// Pinned to the real values recorded by npm run e2e:synthetic -- --instances 2
// this session (see scratchpads/e2e-real-metrics-micro-3.md's verified notes).
const SYNTHETIC_FIXTURE: HarnessOutput = {
  generatedAt: '2026-07-16T23:00:00.000Z',
  instances: 2,
  turns: 6,
  layers: {
    L0: {
      label: 'Baseline',
      cacheHitRate: 0,
      estSavedUsd: 0,
      requests: 12,
      cacheReads: 0,
      cacheWrites: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failures: 0,
    },
    L1: {
      label: 'F1',
      cacheHitRate: 0,
      estSavedUsd: 0,
      requests: 12,
      cacheReads: 0,
      cacheWrites: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failures: 0,
    },
    L2: {
      label: 'F1+F2',
      cacheHitRate: 0.8333333333333334,
      estSavedUsd: -0.010227,
      requests: 12,
      cacheReads: 10,
      cacheWrites: 2,
      cacheReadTokens: 1770,
      cacheCreationTokens: 5356,
      failures: 0,
    },
    L3: {
      label: '+F4',
      cacheHitRate: 0.8333333333333334,
      estSavedUsd: -0.010227,
      requests: 12,
      cacheReads: 10,
      cacheWrites: 2,
      cacheReadTokens: 1770,
      cacheCreationTokens: 5356,
      failures: 0,
    },
    L4: {
      label: '+F3 dry-run',
      cacheHitRate: 0.8333333333333334,
      estSavedUsd: -0.010227,
      requests: 12,
      cacheReads: 10,
      cacheWrites: 2,
      cacheReadTokens: 1770,
      cacheCreationTokens: 5356,
      failures: 0,
    },
    L5: {
      label: '+F3 active',
      cacheHitRate: 0.9166666666666666,
      estSavedUsd: 0.0055806,
      requests: 12,
      cacheReads: 11,
      cacheWrites: 1,
      cacheReadTokens: 4072,
      cacheCreationTokens: 2619,
      failures: 0,
    },
  },
  concurrency: {
    instances: 8,
    barrierOnWrites: 1,
    barrierOffWrites: 8,
  },
}

describe('computeEstSavedUsd', () => {
  it('reproduces the recorded L2 estSavedUsd (negative) by reusing TelemetryStore', () => {
    expect(computeEstSavedUsd(1770, 5356)).toBeCloseTo(-0.010227, 6)
  })

  it('reproduces the recorded L5 estSavedUsd (positive)', () => {
    expect(computeEstSavedUsd(4072, 2619)).toBeCloseTo(0.0055806, 6)
  })

  it('returns 0 for zero tokens', () => {
    expect(computeEstSavedUsd(0, 0)).toBe(0)
  })
})

describe('computeCacheHitRate', () => {
  it('returns 0 when requests is 0 (no division by zero)', () => {
    expect(computeCacheHitRate({ ...SYNTHETIC_FIXTURE.layers.L0!, requests: 0 })).toBe(0)
  })

  it('returns cacheReads / requests otherwise', () => {
    expect(computeCacheHitRate(SYNTHETIC_FIXTURE.layers.L2!)).toBeCloseTo(0.8333333333333334, 10)
  })
})

describe('buildReportHtml', () => {
  it('renders the required section keywords for a synthetic-only report', () => {
    const html = buildReportHtml({ synthetic: SYNTHETIC_FIXTURE })
    const lower = html.toLowerCase()
    expect(lower).toContain('cache-hit-rate')
    expect(lower).toContain('saved')
    expect(lower).toContain('concurrency')
  })

  it('contains no script or link tags (self-contained)', () => {
    const html = buildReportHtml({ synthetic: SYNTHETIC_FIXTURE })
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link/i)
  })

  it('notes real-CLI results are absent when only synthetic data is given', () => {
    const html = buildReportHtml({ synthetic: SYNTHETIC_FIXTURE })
    expect(html).toMatch(/real-cli results not present/i)
  })

  it('renders the negative L2 bar without leaking NaN anywhere', () => {
    const html = buildReportHtml({ synthetic: SYNTHETIC_FIXTURE })
    expect(html).not.toMatch(/NaN/)
  })

  it('puts the real-CLI block before the synthetic block when both are present', () => {
    const html = buildReportHtml({ synthetic: SYNTHETIC_FIXTURE, real: SYNTHETIC_FIXTURE })
    const realIndex = html.indexOf('Real-CLI results')
    const syntheticIndex = html.indexOf('Synthetic (N=')
    expect(realIndex).toBeGreaterThanOrEqual(0)
    expect(syntheticIndex).toBeGreaterThan(realIndex)
  })

  it('throws when neither synthetic nor real data is given', () => {
    expect(() => buildReportHtml({})).toThrow()
  })
})
