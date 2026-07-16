import type { AnthropicRequestLike, AssembleReport, Extractor, Usage } from './types.js'
import { canonicalizeRequest, canonicalStringify } from './canonicalize.js'
import { resolveJsonPath, type PathAccessor } from './json-path.js'

export interface TelemetryEntry {
  prefixHash: string
  usage: Usage
  report?: AssembleReport
  /**
   * Canonical JSON text the prefix hash was computed over. Required for
   * divergence byte-comparison; omit to skip stability tracking entirely.
   */
  canonicalPrefix?: string
  /** LRU key identifying this prefix's position in a growing conversation. */
  chainPosition?: number
}

export type DivergenceFeature = 'F1' | 'F3' | 'unknown'

export interface DivergenceRecord {
  prefixHash: string
  offset: number
  feature: DivergenceFeature
  prefix_slice: string
}

export interface TelemetryStats {
  requests: number
  cacheWrites: number
  cacheReads: number
  cacheReadTokens: number
  cacheCreationTokens: number
  estSavedUsd: number
  estLostUsd: number
  divergences: DivergenceRecord[]
}

export interface TelemetryPricingConfig {
  basePricePerMTok?: number
  cacheReadPricePerMTok?: number
  cacheWritePricePerMTok?: number
}

export interface TelemetryStoreOptions {
  pricing?: TelemetryPricingConfig
  /** Extractors loaded from F3 deferral config, used for divergence attribution. */
  extractors?: Extractor[]
  /** Bounded LRU capacity for the per-chain-position canonical prefix cache. */
  divergenceCacheCapacity?: number
}

const ZERO_TOKENS = 0
const TOKENS_PER_MTOK = 1_000_000

// Anthropic-style cache economics: reading a cached prefix costs a fraction
// of base price; writing (creating) a cache entry costs a premium over base
// price to cover the 1h-TTL storage overhead.
const DEFAULT_BASE_PRICE_PER_MTOK = 3
const CACHE_READ_PRICE_MULTIPLIER = 0.1
const CACHE_WRITE_PRICE_MULTIPLIER = 2

const DEFAULT_DIVERGENCE_LRU_CAPACITY = 50
const DEFAULT_CHAIN_POSITION = 0
const PREFIX_SLICE_RADIUS = 20
const SORT_BY_NAME_CANONICALIZE_CONFIG = { canonicalize: { enabled: true, toolOrder: 'sort-by-name' as const } }

interface PrefixCacheEntry {
  prefixHash: string
  canonicalPrefix: string
}

function toAccessorList(resolved: PathAccessor | PathAccessor[]): PathAccessor[] {
  return Array.isArray(resolved) ? resolved : [resolved]
}

function tryParseRequest(text: string): AnthropicRequestLike | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
      return parsed as AnthropicRequestLike
    }
    return undefined
  } catch {
    return undefined
  }
}

function firstDivergentOffset(previous: string, next: string): number {
  const length = Math.min(previous.length, next.length)
  for (let i = 0; i < length; i++) {
    if (previous[i] !== next[i]) return i
  }
  return length
}

/** True when sorting tool arrays by name (what F1 canonicalization offers) alone erases the divergence. */
function isCanonicalizeErasable(previous: string, next: string): boolean {
  const previousReq = tryParseRequest(previous)
  const nextReq = tryParseRequest(next)
  if (!previousReq || !nextReq) return false

  const previousSorted = canonicalStringify(canonicalizeRequest(previousReq, SORT_BY_NAME_CANONICALIZE_CONFIG))
  const nextSorted = canonicalStringify(canonicalizeRequest(nextReq, SORT_BY_NAME_CANONICALIZE_CONFIG))
  return previousSorted === nextSorted
}

/** True when a loaded F3 extractor's path targets the region that changed, and its pattern matches it. */
function matchesExtractorPath(previous: string, next: string, extractors: Extractor[]): boolean {
  if (extractors.length === 0) return false
  const previousReq = tryParseRequest(previous)
  const nextReq = tryParseRequest(next)
  if (!previousReq || !nextReq) return false

  for (const extractor of extractors) {
    const matcher = new RegExp(extractor.pattern, extractor.flags ?? '')
    const previousAccessors = toAccessorList(resolveJsonPath(previousReq, extractor.path))
    const nextAccessors = toAccessorList(resolveJsonPath(nextReq, extractor.path))
    const count = Math.max(previousAccessors.length, nextAccessors.length)

    for (let i = 0; i < count; i++) {
      const previousValue = previousAccessors[i]?.get()
      const nextValue = nextAccessors[i]?.get()
      if (previousValue === nextValue) continue
      if (matcher.test(previousValue ?? '') || matcher.test(nextValue ?? '')) return true
    }
  }
  return false
}

function attributeDivergence(previous: string, next: string, extractors: Extractor[]): DivergenceFeature {
  if (isCanonicalizeErasable(previous, next)) return 'F1'
  if (matchesExtractorPath(previous, next, extractors)) return 'F3'
  return 'unknown'
}

/**
 * Aggregates cache-economics signals (writes, reads, and token volumes)
 * across recorded requests so an operator can see whether the assembler's
 * prefix stability is actually producing cache hits.
 */
export class TelemetryStore {
  private requests = 0
  private cacheWrites = 0
  private cacheReads = 0
  private cacheReadTokens = 0
  private cacheCreationTokens = 0
  private readonly basePricePerMTok: number
  private readonly cacheReadPricePerMTok: number
  private readonly cacheWritePricePerMTok: number
  private readonly extractors: Extractor[]
  private readonly divergenceCacheCapacity: number
  private readonly prefixCache = new Map<number, PrefixCacheEntry>()
  private readonly divergences: DivergenceRecord[] = []

  constructor(options: TelemetryStoreOptions = {}) {
    this.basePricePerMTok = options.pricing?.basePricePerMTok ?? DEFAULT_BASE_PRICE_PER_MTOK
    this.cacheReadPricePerMTok =
      options.pricing?.cacheReadPricePerMTok ?? this.basePricePerMTok * CACHE_READ_PRICE_MULTIPLIER
    this.cacheWritePricePerMTok =
      options.pricing?.cacheWritePricePerMTok ?? this.basePricePerMTok * CACHE_WRITE_PRICE_MULTIPLIER
    this.extractors = options.extractors ?? []
    this.divergenceCacheCapacity = options.divergenceCacheCapacity ?? DEFAULT_DIVERGENCE_LRU_CAPACITY
  }

  record(entry: TelemetryEntry): void {
    const creationTokens = entry.usage.cache_creation_input_tokens ?? ZERO_TOKENS
    const readTokens = entry.usage.cache_read_input_tokens ?? ZERO_TOKENS

    this.requests += 1
    if (creationTokens > ZERO_TOKENS) this.cacheWrites += 1
    if (readTokens > ZERO_TOKENS) this.cacheReads += 1
    this.cacheCreationTokens += creationTokens
    this.cacheReadTokens += readTokens

    if (entry.canonicalPrefix !== undefined) {
      this.trackStability(entry.prefixHash, entry.canonicalPrefix, entry.chainPosition ?? DEFAULT_CHAIN_POSITION)
    }
  }

  private trackStability(prefixHash: string, canonicalPrefix: string, chainPosition: number): void {
    const previous = this.prefixCache.get(chainPosition)

    if (previous && previous.prefixHash !== prefixHash) {
      const offset = firstDivergentOffset(previous.canonicalPrefix, canonicalPrefix)
      const feature = attributeDivergence(previous.canonicalPrefix, canonicalPrefix, this.extractors)
      const sliceStart = Math.max(0, offset - PREFIX_SLICE_RADIUS)
      const sliceEnd = offset + PREFIX_SLICE_RADIUS
      this.divergences.push({
        prefixHash,
        offset,
        feature,
        prefix_slice: canonicalPrefix.slice(sliceStart, sliceEnd),
      })
      // Bounded log — a long-running proxy must not accumulate an unbounded
      // divergence history; keep only the most recent divergenceCacheCapacity.
      if (this.divergences.length > this.divergenceCacheCapacity) this.divergences.shift()
    }

    this.setPrefixCacheEntry(chainPosition, { prefixHash, canonicalPrefix })
  }

  private setPrefixCacheEntry(chainPosition: number, value: PrefixCacheEntry): void {
    // Map re-insertion bumps recency (insertion order == LRU order); evict
    // the oldest chain-position once the bounded capacity is exceeded.
    this.prefixCache.delete(chainPosition)
    this.prefixCache.set(chainPosition, value)
    if (this.prefixCache.size > this.divergenceCacheCapacity) {
      const oldestKey = this.prefixCache.keys().next().value
      if (oldestKey !== undefined) this.prefixCache.delete(oldestKey)
    }
  }

  stats(): TelemetryStats {
    const totalCacheTokens = this.cacheCreationTokens + this.cacheReadTokens
    // estLostUsd: the $ premium paid to write cache entries, net against what
    // the same cache-touched token volume would have cost at base price.
    const estLostUsd =
      (this.cacheCreationTokens * this.cacheWritePricePerMTok - totalCacheTokens * this.basePricePerMTok) /
      TOKENS_PER_MTOK
    // estSavedUsd: the $ discount earned from cache reads, net against the
    // write premium above — a single combined economics estimate.
    const estSavedUsd = (this.cacheReadTokens * this.cacheReadPricePerMTok) / TOKENS_PER_MTOK - estLostUsd

    return {
      requests: this.requests,
      cacheWrites: this.cacheWrites,
      cacheReads: this.cacheReads,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      estSavedUsd,
      estLostUsd,
      divergences: [...this.divergences],
    }
  }
}
