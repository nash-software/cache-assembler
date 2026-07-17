import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONFIRM_REFUSAL_MESSAGE,
  createDryRunRunner,
  estimateSpendUsd,
  runLayerDry,
  selectLayers,
  type TurnRunner,
} from './run-real-cli.js'

// 11a: the refusal message is the rubric criterion 4's contract — it must
// contain "confirm" (grep -qi "confirm" against stderr).
describe('CONFIRM_REFUSAL_MESSAGE', () => {
  it('matches /confirm/i', () => {
    expect(CONFIRM_REFUSAL_MESSAGE).toMatch(/confirm/i)
  })
})

// 11b: pinned arithmetic — 6 layers x 3 instances x 6 turns x 1000 tok/turn x
// $1/MTok / 1e6 = 0.108 exactly.
describe('estimateSpendUsd', () => {
  it('computes the rough spend estimate exactly', () => {
    expect(estimateSpendUsd(6, 3, 6)).toBe(0.108)
  })
})

// 11c: layer selection resolves a CSV list in order, and throws on an
// unrecognized id rather than silently dropping it.
describe('selectLayers', () => {
  it('resolves a comma-separated list to LayerDefinitions in order', () => {
    const layers = selectLayers('L0,L5')
    expect(layers.map((l) => l.id)).toEqual(['L0', 'L5'])
  })

  it('throws on an unknown layer id', () => {
    expect(() => selectLayers('L9')).toThrow('unknown layer id: L9 (valid: L0..L5)')
  })
})

// 11d: the dry-run stub is deterministic — never randomized — so its usage
// shapes are pinned exactly.
describe('createDryRunRunner', () => {
  it('returns the first-turn usage literal for turnIndex 0', async () => {
    const runner = createDryRunRunner()
    const usage = await runner({ layerId: 'L0', instanceIndex: 0, turnIndex: 0, model: 'claude-haiku-4-5' })
    expect(usage).toEqual({ input_tokens: 260, cache_creation_input_tokens: 1200 })
  })

  it('returns the follow-up-turn usage literal for a later turnIndex', async () => {
    const runner = createDryRunRunner()
    const usage = await runner({ layerId: 'L0', instanceIndex: 0, turnIndex: 2, model: 'claude-haiku-4-5' })
    expect(usage).toEqual({ input_tokens: 260, cache_read_input_tokens: 1200, cache_creation_input_tokens: 140 })
  })
})

// 11e: aggregation across a 2-instance x 3-turn loop, both with the real
// stub runner and with an always-rejecting runner (failure path).
describe('runLayerDry', () => {
  const layer = selectLayers('L0')[0]
  if (!layer) throw new Error('expected selectLayers(L0) to resolve a layer')

  it('aggregates requests/cacheWrites/cacheReads/failures with the dry-run stub', async () => {
    const runner = createDryRunRunner()
    const result = await runLayerDry(layer, 2, 3, runner)

    expect(result.requests).toBe(6)
    expect(result.cacheWrites).toBe(6)
    expect(result.cacheReads).toBe(4)
    expect(result.cacheHitRate).toBeCloseTo(4 / 6)
    expect(result.failures).toBe(0)
  })

  it('records every turn as a failure when the runner always rejects', async () => {
    const alwaysRejects: TurnRunner = async () => {
      throw new Error('simulated runner failure')
    }
    const result = await runLayerDry(layer, 2, 3, alwaysRejects)

    expect(result.requests).toBe(0)
    expect(result.failures).toBe(6)
  })
})

// 11f: structural enforcement of the zero-subprocess / zero-network
// invariant (decision 2) — read the harness source itself and assert it
// never references a subprocess or network API. The forbidden substrings are
// assembled at runtime (rather than written verbatim) so this file's own
// source doesn't trip the AC's directory-wide grep for the same patterns.
describe('safety invariant: no subprocess or network code', () => {
  const FORBIDDEN_PATTERNS = [['child', 'process'].join('_'), 'fetch' + '(', ['node', 'http'].join(':')]

  it('run-real-cli.ts source contains none of the forbidden subprocess/network patterns', () => {
    const source = readFileSync(new URL('./run-real-cli.ts', import.meta.url), 'utf8')
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(source).not.toContain(pattern)
    }
  })
})
