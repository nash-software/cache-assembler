import type { CacheAssemblerConfig } from '../../src/config.js'
import { loadPreset } from '../../src/presets.js'

export type LayerId = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'

export interface LayerDefinition {
  id: LayerId
  label: string
  /** false = requests hit the stub upstream directly, no assembler in the path (the floor). */
  proxy: boolean
  config: CacheAssemblerConfig
}

// Loaded once at module init — every deferral-enabled layer (L4/L5) shares
// the same claude-code preset extractors (scratchpad path, session-id,
// tool session URL) per micro-plan decision 6.
const CLAUDE_CODE_EXTRACTORS = loadPreset('claude-code').extractors

/**
 * Cumulative feature-layer matrix mapped onto cache-assembler's real config
 * toggles. Every toggle is set explicitly per layer — never left to
 * defaultConfig()'s values — since breakpoints/barrier/telemetry all default
 * to enabled: relying on defaults would silently promote L1/L2 into L3.
 */
export const LAYERS: ReadonlyArray<LayerDefinition> = [
  {
    id: 'L0',
    label: 'L0 — Baseline: no proxy at all, direct to API',
    proxy: false,
    config: {},
  },
  {
    id: 'L1',
    label: 'L1 — F1: canonicalize only, deterministic key ordering',
    proxy: true,
    config: {
      canonicalize: { enabled: true },
      breakpoints: { enabled: false },
      deferral: { enabled: false },
      barrier: { enabled: false },
    },
  },
  {
    id: 'L2',
    label: 'L2 — F1+F2: canonicalize + breakpoints (this is what actually turns caching on)',
    proxy: true,
    config: {
      canonicalize: { enabled: true },
      breakpoints: { enabled: true },
      deferral: { enabled: false },
      barrier: { enabled: false },
    },
  },
  {
    id: 'L3',
    label: 'L3 — +F4: barrier enabled (= library defaults); ~0 effect expected on solo sessions',
    proxy: true,
    config: {
      canonicalize: { enabled: true },
      breakpoints: { enabled: true },
      deferral: { enabled: false },
      barrier: { enabled: true },
    },
  },
  {
    id: 'L4',
    label: 'L4 — +F3 dry-run: preview of deferral savings, no bytes changed',
    proxy: true,
    config: {
      canonicalize: { enabled: true },
      breakpoints: { enabled: true },
      deferral: { enabled: true, dryRun: true, extractors: CLAUDE_CODE_EXTRACTORS },
      barrier: { enabled: true },
    },
  },
  {
    id: 'L5',
    label: 'L5 — +F3 active: deferral applied, volatile bytes relocated out of the stable prefix',
    proxy: true,
    config: {
      canonicalize: { enabled: true },
      breakpoints: { enabled: true },
      deferral: { enabled: true, dryRun: false, extractors: CLAUDE_CODE_EXTRACTORS },
      barrier: { enabled: true },
    },
  },
]

export function getLayer(id: LayerId): LayerDefinition {
  const layer = LAYERS.find((l) => l.id === id)
  if (!layer) throw new Error(`Unknown layer id: ${id}`)
  return layer
}
