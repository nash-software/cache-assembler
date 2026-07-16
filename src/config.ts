import type { Extractor } from './types.js'

// Named constants — no magic numbers in config defaults.
export const DEFAULT_MAX_BREAKPOINT_SLOTS = 4
export const DEFAULT_BARRIER_HOLD_TIMEOUT_MS = 15_000

export interface CanonicalizeConfig {
  enabled: boolean
  toolOrder: 'preserve' | 'sort-by-name'
}

export interface BreakpointsConfig {
  enabled: boolean
  maxSlots: number
}

export interface DeferralConfig {
  enabled: boolean
  dryRun: boolean
  extractors: Extractor[]
}

export interface BarrierConfig {
  enabled: boolean
  holdTimeoutMs: number
}

export interface TelemetryConfig {
  enabled: boolean
}

export interface ResolvedConfig {
  canonicalize: CanonicalizeConfig
  breakpoints: BreakpointsConfig
  deferral: DeferralConfig
  barrier: BarrierConfig
  telemetry: TelemetryConfig
}

export type CacheAssemblerConfig = {
  canonicalize?: Partial<CanonicalizeConfig>
  breakpoints?: Partial<BreakpointsConfig>
  deferral?: Partial<DeferralConfig>
  barrier?: Partial<BarrierConfig>
  telemetry?: Partial<TelemetryConfig>
}

function defaultConfig(): ResolvedConfig {
  return {
    canonicalize: { enabled: true, toolOrder: 'preserve' },
    breakpoints: { enabled: true, maxSlots: DEFAULT_MAX_BREAKPOINT_SLOTS },
    // F3 ships disabled + dry-run by default: deferral rewrites request bytes,
    // so it must be an explicit opt-in even when enabled.
    deferral: { enabled: false, dryRun: true, extractors: [] },
    barrier: { enabled: true, holdTimeoutMs: DEFAULT_BARRIER_HOLD_TIMEOUT_MS },
    telemetry: { enabled: true },
  }
}

export function resolveConfig(partial: CacheAssemblerConfig): ResolvedConfig {
  const defaults = defaultConfig()
  return {
    canonicalize: { ...defaults.canonicalize, ...partial.canonicalize },
    breakpoints: { ...defaults.breakpoints, ...partial.breakpoints },
    deferral: { ...defaults.deferral, ...partial.deferral },
    barrier: { ...defaults.barrier, ...partial.barrier },
    telemetry: { ...defaults.telemetry, ...partial.telemetry },
  }
}
