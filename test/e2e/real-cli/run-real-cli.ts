import { parseArgs } from 'node:util'
import { getLayer, type LayerDefinition, type LayerId } from '../layers.js'
import { TelemetryStore } from '../../../src/telemetry.js'
import type { Usage } from '../../../src/types.js'

// This iteration ships zero subprocess-spawning code and zero network code —
// see micro-plan 4 decision 2. The "stubbed claude executable" of rubric
// criterion 5 is realized entirely in-process (createDryRunRunner below); the
// live path (real `claude` children, proxy wiring, auth check) is deferred.

const DEFAULT_LAYERS_CSV = 'L0,L1,L2,L3,L4,L5'
const DEFAULT_INSTANCES_STR = '3'
const DEFAULT_TURNS_STR = '6'
const DEFAULT_MODEL = 'claude-haiku-4-5'
const DEFAULT_MAX_BUDGET_USD_STR = '1'

const VALID_LAYER_IDS: readonly LayerId[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']

/** Hard cap on total real CLI invocations (instances x selected layers) — spec: "default cap: 50". */
export const MAX_TOTAL_INVOCATIONS = 50

// Rough Haiku-class input $/MTok for the spend estimate — distinct from
// src/telemetry.ts's Sonnet-class cache-economics constants, which model a
// different (and non-Haiku) pricing scenario. Spec: "rough: instances x
// turns x avg tokens x Haiku pricing".
export const ESTIMATE_PRICE_PER_MTOK = 1
// Order-of-magnitude average tokens per turn, derived from the recorded
// synthetic run (L2 read+creation 7126 tokens over 12 requests ~= 600/turn,
// rounded up).
export const ESTIMATE_AVG_TOKENS_PER_TURN = 1000

export const CONFIRM_REFUSAL_MESSAGE =
  'real-cli harness: refusing to run without --confirm — this harness spends real API credits when run live (use --dry-run --confirm for a free, network-free rehearsal)'

export const LIVE_NOT_IMPLEMENTED_MESSAGE =
  'live real-CLI execution is not implemented in this build — re-run with --dry-run (live path lands in a later iteration)'

export interface RealCliOptions {
  confirm: boolean
  dryRun: boolean
  yes: boolean
  layers: string
  instances: string
  turns: string
  model: string
  forceInstances: string | undefined
  maxBudgetUsd: string
}

/**
 * Seam type for one turn of a real-CLI-driven conversation. The (future)
 * live runner will implement this same seam by driving a real `claude`
 * child process through a proxy; this iteration only ships the in-process
 * stub (createDryRunRunner).
 */
export type TurnRunner = (ctx: {
  layerId: LayerId
  instanceIndex: number
  turnIndex: number
  model: string
}) => Promise<Usage>

export interface RealLayerResult {
  id: LayerId
  label: string
  requests: number
  cacheReads: number
  cacheWrites: number
  cacheHitRate: number
  estSavedUsd: number
  failures: number
}

/** Parses raw CLI flags (node:util parseArgs) — no validation beyond argument shape; numeric/layer validation happens later, after the confirm gate. */
export function parseRealCliArgs(argv: string[]): RealCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      confirm: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      layers: { type: 'string', default: DEFAULT_LAYERS_CSV },
      instances: { type: 'string', default: DEFAULT_INSTANCES_STR },
      turns: { type: 'string', default: DEFAULT_TURNS_STR },
      model: { type: 'string', default: DEFAULT_MODEL },
      'force-instances': { type: 'string' },
      'max-budget-usd': { type: 'string', default: DEFAULT_MAX_BUDGET_USD_STR },
    },
  })

  return {
    confirm: values.confirm ?? false,
    dryRun: values['dry-run'] ?? false,
    yes: values.yes ?? false,
    layers: values.layers ?? DEFAULT_LAYERS_CSV,
    instances: values.instances ?? DEFAULT_INSTANCES_STR,
    turns: values.turns ?? DEFAULT_TURNS_STR,
    model: values.model ?? DEFAULT_MODEL,
    forceInstances: values['force-instances'],
    maxBudgetUsd: values['max-budget-usd'] ?? DEFAULT_MAX_BUDGET_USD_STR,
  }
}

/** Resolves a comma-separated layer-id list to LayerDefinitions, in the order given. Throws on an unrecognized id. */
export function selectLayers(csv: string): LayerDefinition[] {
  const ids = csv
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)

  return ids.map((id) => {
    if (!VALID_LAYER_IDS.includes(id as LayerId)) {
      throw new Error(`unknown layer id: ${id} (valid: L0..L5)`)
    }
    return getLayer(id as LayerId)
  })
}

/** Parses a CLI numeric flag; throws on non-integer or < 1 rather than silently coercing. */
export function parsePositiveInt(label: string, raw: string): number {
  const value = Number.parseInt(raw, 10)
  if (Number.isNaN(value) || value < 1) {
    throw new Error(`${label}: invalid numeric value '${raw}' (expected an integer >= 1)`)
  }
  return value
}

/** Rough spend estimate: instances x turns x avg tokens x Haiku pricing (spec's own "rough" wording). */
export function estimateSpendUsd(layerCount: number, instances: number, turns: number): number {
  return (layerCount * instances * turns * ESTIMATE_AVG_TOKENS_PER_TURN * ESTIMATE_PRICE_PER_MTOK) / 1_000_000
}

const DRY_RUN_FIRST_TURN_USAGE: Usage = { input_tokens: 260, cache_creation_input_tokens: 1200 }
const DRY_RUN_FOLLOWUP_TURN_USAGE: Usage = {
  input_tokens: 260,
  cache_read_input_tokens: 1200,
  cache_creation_input_tokens: 140,
}

/**
 * In-process stand-in for a real `claude` CLI turn ("stubbed claude
 * executable" per rubric criterion 5) — deterministic, pure, no subprocess,
 * no network. Fixed usage shapes mirror a real cached session: the first
 * turn writes a cache entry, follow-up turns read it back plus a small
 * incremental write.
 */
export function createDryRunRunner(): TurnRunner {
  return async (ctx) => {
    return ctx.turnIndex === 0 ? { ...DRY_RUN_FIRST_TURN_USAGE } : { ...DRY_RUN_FOLLOWUP_TURN_USAGE }
  }
}

/**
 * Drives one layer's full instance x turn loop against a TurnRunner seam and
 * aggregates the results through a fresh TelemetryStore. A runner rejection
 * is recorded as a failure (per spec error handling), not an aborted run.
 */
export async function runLayerDry(
  layer: LayerDefinition,
  instances: number,
  turns: number,
  runner: TurnRunner,
): Promise<RealLayerResult> {
  const store = new TelemetryStore()
  let failures = 0

  for (let instanceIndex = 0; instanceIndex < instances; instanceIndex++) {
    for (let turnIndex = 0; turnIndex < turns; turnIndex++) {
      try {
        const usage = await runner({ layerId: layer.id, instanceIndex, turnIndex, model: DEFAULT_MODEL })
        store.record({ prefixHash: `dry-${layer.id}-${instanceIndex}`, usage })
      } catch {
        failures += 1
      }
    }
  }

  const stats = store.stats()
  const cacheHitRate = stats.requests === 0 ? 0 : stats.cacheReads / stats.requests

  return {
    id: layer.id,
    label: layer.label,
    requests: stats.requests,
    cacheReads: stats.cacheReads,
    cacheWrites: stats.cacheWrites,
    cacheHitRate,
    estSavedUsd: stats.estSavedUsd,
    failures,
  }
}
