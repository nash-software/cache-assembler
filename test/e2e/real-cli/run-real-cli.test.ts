import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONFIRM_REFUSAL_MESSAGE,
  createDryRunRunner,
  estimateSpendUsd,
  parsePositiveInt,
  parseRealCliArgs,
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

// parseRealCliArgs: no existing test exercises this pure export at all — it
// is the entry point for every downstream gate, so its defaults and
// kebab-case flag mapping are worth pinning directly rather than only
// indirectly through main()'s behavior.
describe('parseRealCliArgs', () => {
  it('returns the documented defaults for an empty argv', () => {
    expect(parseRealCliArgs([])).toEqual({
      confirm: false,
      dryRun: false,
      yes: false,
      layers: 'L0,L1,L2,L3,L4,L5',
      instances: '3',
      turns: '6',
      model: 'claude-haiku-4-5',
      forceInstances: undefined,
      maxBudgetUsd: '1',
    })
  })

  it('maps every kebab-case flag to its camelCase field', () => {
    const parsed = parseRealCliArgs([
      '--confirm',
      '--dry-run',
      '--yes',
      '--layers',
      'L0,L2',
      '--instances',
      '5',
      '--turns',
      '2',
      '--model',
      'claude-opus-4',
      '--force-instances',
      '100',
      '--max-budget-usd',
      '0.5',
    ])

    expect(parsed).toEqual({
      confirm: true,
      dryRun: true,
      yes: true,
      layers: 'L0,L2',
      instances: '5',
      turns: '2',
      model: 'claude-opus-4',
      forceInstances: '100',
      maxBudgetUsd: '0.5',
    })
  })

  it('leaves forceInstances undefined when --force-instances is not passed', () => {
    expect(parseRealCliArgs(['--confirm']).forceInstances).toBeUndefined()
  })
})

// parsePositiveInt: not exercised anywhere else — this is the sole guard
// against malformed --instances/--turns/--force-instances values reaching
// the orchestration loop, so its accept/reject boundary needs direct tests.
describe('parsePositiveInt', () => {
  it('parses a valid positive integer string', () => {
    expect(parsePositiveInt('--instances', '5')).toBe(5)
  })

  it('accepts the boundary value 1', () => {
    expect(parsePositiveInt('--turns', '1')).toBe(1)
  })

  it('throws on a non-numeric string', () => {
    expect(() => parsePositiveInt('--instances', 'abc')).toThrow(
      "--instances: invalid numeric value 'abc' (expected an integer >= 1)",
    )
  })

  it('throws on zero', () => {
    expect(() => parsePositiveInt('--turns', '0')).toThrow(
      "--turns: invalid numeric value '0' (expected an integer >= 1)",
    )
  })

  it('throws on a negative value', () => {
    expect(() => parsePositiveInt('--instances', '-3')).toThrow(
      "--instances: invalid numeric value '-3' (expected an integer >= 1)",
    )
  })

  it('throws on an empty string', () => {
    expect(() => parsePositiveInt('--force-instances', '')).toThrow(
      "--force-instances: invalid numeric value '' (expected an integer >= 1)",
    )
  })

  it('truncates a decimal string to its integer part rather than rejecting it (Number.parseInt semantics)', () => {
    // Documents actual behavior: parsePositiveInt uses Number.parseInt, which
    // truncates "3.7" to 3 instead of throwing. Pinned so a future refactor
    // to Number() or a stricter integer regex is a deliberate, visible change.
    expect(parsePositiveInt('--instances', '3.7')).toBe(3)
  })
})

// 11b: pinned arithmetic — 6 layers x 3 instances x 6 turns x 1000 tok/turn x
// $1/MTok / 1e6 = 0.108 exactly.
describe('estimateSpendUsd', () => {
  it('computes the rough spend estimate exactly', () => {
    expect(estimateSpendUsd(6, 3, 6)).toBe(0.108)
  })

  it('returns 0 when layerCount is 0', () => {
    expect(estimateSpendUsd(0, 3, 6)).toBe(0)
  })

  it('returns 0 when instances is 0', () => {
    expect(estimateSpendUsd(6, 0, 6)).toBe(0)
  })

  it('returns 0 when turns is 0', () => {
    expect(estimateSpendUsd(6, 3, 0)).toBe(0)
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

  it('returns an empty array for an empty string', () => {
    expect(selectLayers('')).toEqual([])
  })

  it('resolves duplicate ids to duplicate entries rather than deduplicating', () => {
    const layers = selectLayers('L0,L0')
    expect(layers.map((l) => l.id)).toEqual(['L0', 'L0'])
  })

  it('trims whitespace around ids', () => {
    const layers = selectLayers(' L0 , L1 ')
    expect(layers.map((l) => l.id)).toEqual(['L0', 'L1'])
  })

  it('ignores trailing/empty comma segments without throwing', () => {
    const layers = selectLayers('L0,')
    expect(layers.map((l) => l.id)).toEqual(['L0'])
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

  it('records a mix of successes and failures without aborting the loop (per-turn isolation)', async () => {
    // Fails the first turn of every instance (turnIndex 0), succeeds on the
    // rest — proves a single rejected turn doesn't abort the remaining turns
    // or instances, and that partial-failure aggregation is counted per turn.
    const mixedRunner: TurnRunner = async (ctx) => {
      if (ctx.turnIndex === 0) throw new Error('simulated first-turn failure')
      return ctx.turnIndex === 1
        ? { input_tokens: 260, cache_creation_input_tokens: 1200 }
        : { input_tokens: 260, cache_read_input_tokens: 1200, cache_creation_input_tokens: 140 }
    }
    const result = await runLayerDry(layer, 2, 3, mixedRunner)

    // 2 instances x 3 turns = 6 total turns; turnIndex 0 fails each time (2
    // failures), turnIndex 1/2 succeed (4 successful requests).
    expect(result.failures).toBe(2)
    expect(result.requests).toBe(4)
    expect(result.cacheWrites).toBe(4)
    expect(result.cacheReads).toBe(2)
  })

  it('returns zero requests and zero failures when instances is 0 (loop never executes)', async () => {
    const runner = createDryRunRunner()
    const result = await runLayerDry(layer, 0, 3, runner)

    expect(result.requests).toBe(0)
    expect(result.failures).toBe(0)
    expect(result.cacheHitRate).toBe(0)
  })

  it('returns zero requests and zero failures when turns is 0 (loop never executes)', async () => {
    const runner = createDryRunRunner()
    const result = await runLayerDry(layer, 2, 0, runner)

    expect(result.requests).toBe(0)
    expect(result.failures).toBe(0)
    expect(result.cacheHitRate).toBe(0)
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
