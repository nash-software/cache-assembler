import type { AnthropicRequestLike, AssembleReport } from './types.js'
import { resolveConfig, type CacheAssemblerConfig } from './config.js'
import { canonicalizeRequest } from './canonicalize.js'
import { defer } from './deferral.js'
import { placeBreakpoints, countExistingBreakpoints } from './breakpoints.js'
import { prefixHash, serializePrefixSegment } from './prefix-hash.js'

type DeferralMode = AssembleReport['features']['deferral']['mode']

function resolveDeferralMode(enabled: boolean, dryRun: boolean): DeferralMode {
  if (!enabled) return 'off'
  return dryRun ? 'dry-run' : 'active'
}

/**
 * Pure orchestrator: F1 canonicalize -> F3 defer -> F2 placeBreakpoints ->
 * compute the stable prefix hash over the result. Never mutates `req` or
 * `state` — every stage returns a new request; feature deltas surface in the
 * returned AssembleReport, and the caller (proxy wrapper) owns any state
 * mutation.
 */
export function assemble(
  req: AnthropicRequestLike,
  partialCfg: CacheAssemblerConfig,
): { req: AnthropicRequestLike; report: AssembleReport } {
  const cfg = resolveConfig(partialCfg)
  const existingRespected = countExistingBreakpoints(req)

  const canonicalized = cfg.canonicalize.enabled ? canonicalizeRequest(req, cfg) : { ...req }

  const deferralMode = resolveDeferralMode(cfg.deferral.enabled, cfg.deferral.dryRun)
  const deferResult = cfg.deferral.enabled
    ? defer(canonicalized, cfg)
    : {
        req: canonicalized,
        moved: [],
        prefixHashBefore: prefixHash(canonicalized),
        prefixHashAfter: prefixHash(canonicalized),
      }

  const { req: withBreakpoints, placed } = cfg.breakpoints.enabled
    ? placeBreakpoints(deferResult.req, cfg)
    : { req: deferResult.req, placed: [] }

  // Stable prefix hash boundary: up to and including the last placed
  // breakpoint. A 'message' placement bounds the hash to that message index;
  // a 'tool'/'system'-only placement excludes every message from the stable
  // segment (no message boundary was established); no placement at all
  // falls back to hashing the full serialization.
  const lastPlacement = placed.at(-1)
  const uptoIndex = lastPlacement === undefined ? undefined : lastPlacement.location === 'message' ? lastPlacement.index : -1

  const report: AssembleReport = {
    prefixHash: prefixHash(withBreakpoints, uptoIndex),
    canonicalPrefix: serializePrefixSegment(withBreakpoints, uptoIndex),
    features: {
      canonicalize: { applied: cfg.canonicalize.enabled },
      breakpoints: { placed, existingRespected },
      deferral: {
        mode: deferralMode,
        moved: deferResult.moved,
        prefixHashBefore: deferResult.prefixHashBefore,
        prefixHashAfter: deferResult.prefixHashAfter,
      },
    },
  }

  return { req: withBreakpoints, report }
}
