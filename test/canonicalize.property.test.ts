import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canonicalizeValue, canonicalStringify, canonicalizeRequest } from '../src/canonicalize.js'
import { prefixHash } from '../src/prefix-hash.js'
import { resolveConfig } from '../src/config.js'
import type { AnthropicRequestLike, ToolDefinition } from '../src/types.js'

const MAX_ARBITRARY_DEPTH = 4

function withReversedKeyOrder(obj: Record<string, unknown>): Record<string, unknown> {
  const reversedKeys = Object.keys(obj).reverse()
  const result: Record<string, unknown> = {}
  for (const key of reversedKeys) result[key] = obj[key]
  return result
}

describe('canonicalize property tests', () => {
  it('canonicalStringify output parses deep-equal to input', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: MAX_ARBITRARY_DEPTH }), (value) => {
        const roundTripped: unknown = JSON.parse(canonicalStringify(value))
        expect(roundTripped).toEqual(JSON.parse(JSON.stringify(value)))
      }),
    )
  })

  it('canonicalization is idempotent', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: MAX_ARBITRARY_DEPTH }), (value) => {
        const once = canonicalStringify(value)
        const twice = canonicalStringify(canonicalizeValue(value))
        expect(twice).toBe(once)
      }),
    )
  })

  it('two key-order permutations of the same tool set yield identical bytes and identical prefixHash', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue({ maxDepth: 3 }), { maxKeys: 8 }),
        (schema) => {
          const toolA: ToolDefinition = { name: 'test_tool', input_schema: schema }
          const toolB: ToolDefinition = { name: 'test_tool', input_schema: withReversedKeyOrder(schema) }
          const reqA: AnthropicRequestLike = { messages: [], tools: [toolA] }
          const reqB: AnthropicRequestLike = { messages: [], tools: [toolB] }
          const cfg = resolveConfig({})

          const canonicalA = canonicalizeRequest(reqA, cfg)
          const canonicalB = canonicalizeRequest(reqB, cfg)

          expect(canonicalStringify(canonicalA)).toBe(canonicalStringify(canonicalB))
          expect(prefixHash(canonicalA)).toBe(prefixHash(canonicalB))
        },
      ),
    )
  })

  it('preserves an own "__proto__" data key instead of letting bracket-assignment redirect it to the prototype slot', () => {
    // JSON.parse creates "__proto__" as a normal own enumerable property
    // (it bypasses the accessor) — exactly how an attacker-controlled
    // request body arrives at canonicalizeValue.
    const parsed: unknown = JSON.parse('{"__proto__":"malicious-value","safe":"ok"}')
    const canonical = canonicalizeValue(parsed)

    expect(Object.keys(canonical as object)).toContain('__proto__')
    expect(canonicalStringify(canonical)).toContain('"__proto__":"malicious-value"')
  })
})
