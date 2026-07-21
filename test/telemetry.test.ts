import { describe, expect, it } from 'vitest'
import { TelemetryStore } from '../src/telemetry.js'
import { WriteBarrier } from '../src/barrier.js'
import { canonicalStringify } from '../src/canonicalize.js'
import type { AnthropicRequestLike, Extractor, Usage } from '../src/types.js'

function usage(overrides: Partial<Usage> = {}): Usage {
  return { input_tokens: 100, ...overrides }
}

describe('TelemetryStore (F5 basic recording)', () => {
  it('counts a request with cache_creation_input_tokens as a write', () => {
    const store = new TelemetryStore()
    store.record({ prefixHash: 'hash-1', usage: usage({ cache_creation_input_tokens: 500 }) })

    const stats = store.stats()
    expect(stats.requests).toBe(1)
    expect(stats.cacheWrites).toBe(1)
    expect(stats.cacheReads).toBe(0)
    expect(stats.cacheCreationTokens).toBe(500)
    expect(stats.cacheReadTokens).toBe(0)
  })

  it('counts a request with cache_read_input_tokens as a read', () => {
    const store = new TelemetryStore()
    store.record({ prefixHash: 'hash-1', usage: usage({ cache_read_input_tokens: 300 }) })

    const stats = store.stats()
    expect(stats.requests).toBe(1)
    expect(stats.cacheReads).toBe(1)
    expect(stats.cacheWrites).toBe(0)
    expect(stats.cacheReadTokens).toBe(300)
  })

  it('a request with neither write nor read tokens counts only as a request', () => {
    const store = new TelemetryStore()
    store.record({ prefixHash: 'hash-1', usage: usage() })

    const stats = store.stats()
    expect(stats.requests).toBe(1)
    expect(stats.cacheWrites).toBe(0)
    expect(stats.cacheReads).toBe(0)
  })

  it('tallies multiple entries across writes and reads', () => {
    const store = new TelemetryStore()
    store.record({ prefixHash: 'a', usage: usage({ cache_creation_input_tokens: 100 }) })
    store.record({ prefixHash: 'a', usage: usage({ cache_read_input_tokens: 50 }) })
    store.record({ prefixHash: 'a', usage: usage({ cache_read_input_tokens: 50 }) })

    const stats = store.stats()
    expect(stats.requests).toBe(3)
    expect(stats.cacheWrites).toBe(1)
    expect(stats.cacheReads).toBe(2)
    expect(stats.cacheCreationTokens).toBe(100)
    expect(stats.cacheReadTokens).toBe(100)
  })

  it('accepts an optional report field without affecting counts', () => {
    const store = new TelemetryStore()
    store.record({
      prefixHash: 'a',
      usage: usage({ cache_read_input_tokens: 20 }),
      report: {
        prefixHash: 'a',
        canonicalPrefix: '{}',
        features: {
          canonicalize: { applied: true },
          breakpoints: { placed: [], existingRespected: 0 },
          deferral: { mode: 'off', moved: [], prefixHashBefore: 'a', prefixHashAfter: 'a' },
        },
      },
    })

    expect(store.stats().requests).toBe(1)
  })
})

describe('TelemetryStore (F5 pricing and cost estimation)', () => {
  it('computes estSavedUsd and estLostUsd from default per-MTok pricing (read 0.1x, write 2x, base 1x)', () => {
    const store = new TelemetryStore()
    store.record({ prefixHash: 'a', usage: usage({ cache_creation_input_tokens: 1_000_000 }) })
    store.record({ prefixHash: 'a', usage: usage({ cache_read_input_tokens: 4_000_000 }) })

    const stats = store.stats()
    // estLostUsd = writes * (basePrice - writePrice) / 1e6 = 1e6 * (3 - 6) / 1e6 = -3
    expect(stats.estLostUsd).toBeCloseTo(-3, 6)
    // estSavedUsd (net) = counterfactual - actual
    //   counterfactual = (1e6 + 4e6) * 3 / 1e6 = 15
    //   actual = (1e6 * 6 + 4e6 * 0.3) / 1e6 = 7.2
    //   net = 15 - 7.2 = 7.8
    expect(stats.estSavedUsd).toBeCloseTo(7.8, 6)
  })

  it('accepts overridable per-MTok pricing via constructor options', () => {
    const store = new TelemetryStore({
      pricing: { basePricePerMTok: 10, cacheReadPricePerMTok: 1, cacheWritePricePerMTok: 20 },
    })
    store.record({ prefixHash: 'a', usage: usage({ cache_creation_input_tokens: 1_000_000 }) })
    store.record({ prefixHash: 'a', usage: usage({ cache_read_input_tokens: 1_000_000 }) })

    const stats = store.stats()
    // estLostUsd = 1e6 * (10 - 20) / 1e6 = -10
    expect(stats.estLostUsd).toBeCloseTo(-10, 6)
    // estSavedUsd (net) = counterfactual(2e6*10/1e6=20) - actual(1e6*20+1e6*1)/1e6=21) = -1
    // (Genuinely a net loss at these prices with equal read/write volume:
    // the 2x write premium isn't offset by the 0.1x read discount unless
    // reads substantially outnumber writes.)
    expect(stats.estSavedUsd).toBeCloseTo(-1, 6)
  })

  it('reports zero estSavedUsd/estLostUsd when no cache activity has been recorded', () => {
    const store = new TelemetryStore()
    store.record({ prefixHash: 'a', usage: usage() })

    const stats = store.stats()
    expect(stats.estSavedUsd).toBe(0)
    expect(stats.estLostUsd).toBe(0)
  })
})

describe('TelemetryStore (F5 stability tracking and divergence detection)', () => {
  it('attributes a divergence to F1 when tool re-ordering alone explains it', () => {
    const store = new TelemetryStore()
    const reqA: AnthropicRequestLike = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'alpha', input_schema: {} },
        { name: 'beta', input_schema: {} },
      ],
    }
    const reqB: AnthropicRequestLike = {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'beta', input_schema: {} },
        { name: 'alpha', input_schema: {} },
      ],
    }
    const prefixA = canonicalStringify(reqA)
    const prefixB = canonicalStringify(reqB)

    store.record({ prefixHash: 'hash-a', usage: usage(), canonicalPrefix: prefixA, chainPosition: 0 })
    store.record({ prefixHash: 'hash-b', usage: usage(), canonicalPrefix: prefixB, chainPosition: 0 })

    const { divergences } = store.stats()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]?.feature).toBe('F1')
    expect(divergences[0]?.prefixHash).toBe('hash-b')
    expect(typeof divergences[0]?.offset).toBe('number')
    expect(typeof divergences[0]?.prefix_slice).toBe('string')
  })

  it("attributes a divergence to F3 when it falls within a loaded extractor's path", () => {
    const extractor: Extractor = { id: 'ts', path: 'system', pattern: '\\d{10}' }
    const store = new TelemetryStore({ extractors: [extractor] })
    const reqC: AnthropicRequestLike = { messages: [{ role: 'user', content: 'hi' }], system: 'ctx 1700000000 done' }
    const reqD: AnthropicRequestLike = { messages: [{ role: 'user', content: 'hi' }], system: 'ctx 1700000111 done' }
    const prefixC = canonicalStringify(reqC)
    const prefixD = canonicalStringify(reqD)

    store.record({ prefixHash: 'hash-c', usage: usage(), canonicalPrefix: prefixC, chainPosition: 1 })
    store.record({ prefixHash: 'hash-d', usage: usage(), canonicalPrefix: prefixD, chainPosition: 1 })

    const { divergences } = store.stats()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]?.feature).toBe('F3')
  })

  it('attributes a divergence to unknown when neither canonicalization nor an extractor path explains it', () => {
    const store = new TelemetryStore()
    const reqE: AnthropicRequestLike = { messages: [{ role: 'user', content: 'hello' }] }
    const reqF: AnthropicRequestLike = { messages: [{ role: 'user', content: 'goodbye' }] }
    const prefixE = canonicalStringify(reqE)
    const prefixF = canonicalStringify(reqF)

    store.record({ prefixHash: 'hash-e', usage: usage(), canonicalPrefix: prefixE, chainPosition: 2 })
    store.record({ prefixHash: 'hash-f', usage: usage(), canonicalPrefix: prefixF, chainPosition: 2 })

    const { divergences } = store.stats()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]?.feature).toBe('unknown')
  })

  it('computes the exact first-divergent-byte offset and slice between two canonical prefixes', () => {
    const store = new TelemetryStore()
    const sharedPrefix = '{"messages":[{"content":"'
    const previous = `${sharedPrefix}X-tail"}]}`
    const next = `${sharedPrefix}Y-tail"}]}`

    store.record({ prefixHash: 'hash-prev', usage: usage(), canonicalPrefix: previous, chainPosition: 9 })
    store.record({ prefixHash: 'hash-next', usage: usage(), canonicalPrefix: next, chainPosition: 9 })

    const { divergences } = store.stats()
    expect(divergences).toHaveLength(1)
    expect(divergences[0]?.offset).toBe(sharedPrefix.length)
    expect(divergences[0]?.prefix_slice).toBe(
      next.slice(Math.max(0, sharedPrefix.length - 20), sharedPrefix.length + 20),
    )
  })

  it('does not record a divergence when the prefix hash is unchanged for a chain position', () => {
    const store = new TelemetryStore()
    const req: AnthropicRequestLike = { messages: [{ role: 'user', content: 'hi' }] }
    const prefix = canonicalStringify(req)

    store.record({ prefixHash: 'hash-same', usage: usage(), canonicalPrefix: prefix, chainPosition: 0 })
    store.record({ prefixHash: 'hash-same', usage: usage(), canonicalPrefix: prefix, chainPosition: 0 })

    expect(store.stats().divergences).toHaveLength(0)
  })

  it('bounds the divergence log to divergenceCacheCapacity so a long-running proxy does not leak memory', () => {
    const store = new TelemetryStore({ divergenceCacheCapacity: 3 })

    // Each chain position is distinct, so every record after the first at
    // that position is a genuine divergence; force 5 divergences with a cap of 3.
    for (let i = 0; i < 6; i++) {
      const req: AnthropicRequestLike = { messages: [{ role: 'user', content: `msg-${i}` }] }
      store.record({ prefixHash: `hash-${i}`, usage: usage(), canonicalPrefix: canonicalStringify(req), chainPosition: 0 })
    }

    expect(store.stats().divergences.length).toBeLessThanOrEqual(3)
  })
})

describe('WriteBarrier + TelemetryStore composition (AC4: barrier fan-out + telemetry)', () => {
  it('5 concurrent identical requests through a stubbed upstream: 1 write + 4 reads in telemetry', async () => {
    const barrier = new WriteBarrier()
    const telemetry = new TelemetryStore()
    const hash = 'hash-composition'
    let upstreamCalls = 0

    // First call (the leader's) simulates a cache write; every call after
    // that simulates a cache read of the now-warm entry.
    async function stubUpstream(): Promise<Usage> {
      upstreamCalls += 1
      return upstreamCalls === 1
        ? usage({ cache_creation_input_tokens: 100 })
        : usage({ cache_read_input_tokens: 50 })
    }

    async function handleRequest(): Promise<void> {
      const { role } = await barrier.enter(hash)
      const requestUsage = await stubUpstream()
      if (role === 'leader') barrier.firstByte(hash)
      telemetry.record({ prefixHash: hash, usage: requestUsage })
    }

    await Promise.all([handleRequest(), handleRequest(), handleRequest(), handleRequest(), handleRequest()])

    const stats = telemetry.stats()
    expect(stats.requests).toBe(5)
    expect(stats.cacheWrites).toBe(1)
    expect(stats.cacheReads).toBe(4)
    expect(upstreamCalls).toBe(5)
  })
})
