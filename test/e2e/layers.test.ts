import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import { getLayer, LAYERS, type LayerId } from './layers.js'

describe('LAYERS matrix (resolved config, not raw literals)', () => {
  // Asserted via resolveConfig — the same merge-with-defaults function the
  // real proxy uses — so this catches a layer config silently falling back
  // to defaultConfig()'s enabled:true (breakpoints/barrier/telemetry) if a
  // future edit ever drops one of the explicit toggles, per the "never rely
  // on defaults" invariant documented in layers.ts.
  it.each<[LayerId, boolean, boolean, boolean, boolean]>([
    // id,   canonicalize, breakpoints, deferral, barrier
    ['L1', false, true, false, false],
    ['L2', true, true, false, false],
    ['L3', true, true, false, true],
    ['L4', true, true, true, true],
    ['L5', true, true, true, true],
  ])('%s resolves to canonicalize=%s breakpoints=%s deferral=%s barrier=%s', (id, canonicalize, breakpoints, deferral, barrier) => {
    const resolved = resolveConfig(getLayer(id).config)
    expect(resolved.canonicalize.enabled).toBe(canonicalize)
    expect(resolved.breakpoints.enabled).toBe(breakpoints)
    expect(resolved.deferral.enabled).toBe(deferral)
    expect(resolved.barrier.enabled).toBe(barrier)
  })

  it('L4 is dry-run and L5 is active for the deferral toggle', () => {
    expect(resolveConfig(getLayer('L4').config).deferral.dryRun).toBe(true)
    expect(resolveConfig(getLayer('L5').config).deferral.dryRun).toBe(false)
  })

  it('L0 is the direct-to-upstream floor (no proxy in the path)', () => {
    expect(getLayer('L0').proxy).toBe(false)
  })

  it('L1 through L5 all route through a proxy', () => {
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5'] as const) {
      expect(getLayer(id).proxy).toBe(true)
    }
  })

  it('LAYERS is ordered L0 through L5 with no duplicate or missing ids', () => {
    expect(LAYERS.map((l) => l.id)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
  })
})

describe('getLayer', () => {
  it('returns the matching layer definition by id', () => {
    expect(getLayer('L2').label).toContain('canonicalize + breakpoints')
  })

  it('throws naming the unknown id for an id not present in LAYERS', () => {
    expect(() => getLayer('L9' as LayerId)).toThrow(/L9/)
  })
})
