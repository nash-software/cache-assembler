import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('enables F1/F2/F4/F5, disables F3 with dryRun defaulting true', () => {
    const cfg = resolveConfig({})

    expect(cfg.canonicalize.enabled).toBe(true)
    expect(cfg.canonicalize.toolOrder).toBe('preserve')

    expect(cfg.breakpoints.enabled).toBe(true)
    expect(cfg.breakpoints.maxSlots).toBe(4)

    expect(cfg.deferral.enabled).toBe(false)
    expect(cfg.deferral.dryRun).toBe(true)
    expect(cfg.deferral.extractors).toEqual([])

    expect(cfg.barrier.enabled).toBe(true)
    expect(cfg.barrier.holdTimeoutMs).toBe(15_000)

    expect(cfg.telemetry.enabled).toBe(true)
  })

  it('merges partial overrides onto defaults', () => {
    const cfg = resolveConfig({ deferral: { enabled: true } })
    expect(cfg.deferral.enabled).toBe(true)
    expect(cfg.deferral.dryRun).toBe(true)
    expect(cfg.canonicalize.enabled).toBe(true)
  })
})
