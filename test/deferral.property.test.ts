import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { defer } from '../src/deferral.js'
import { resolveConfig } from '../src/config.js'
import type { AnthropicRequestLike } from '../src/types.js'

function extractableText(sessionId: string): string {
  return `scratchpad session ${sessionId} is active`
}

function baseRequest(sessionId: string): AnthropicRequestLike {
  return {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: extractableText(sessionId) }] },
    ],
    system: [{ type: 'text', text: 'sys prompt' }],
  }
}

const SESSION_EXTRACTOR = {
  id: 'session-id',
  path: 'messages[*].content[*].text',
  pattern: 'session [a-z0-9-]+ is active',
}

describe('defer (F3 volatile-byte deferral)', () => {
  it('dry-run mode returns the input request deep-equal and reports what would move', () => {
    const req = baseRequest('abc-123')
    const cfg = resolveConfig({ deferral: { enabled: true, dryRun: true, extractors: [SESSION_EXTRACTOR] } })
    const { req: out, moved } = defer(req, cfg)

    expect(out).toEqual(req)
    expect(moved.length).toBeGreaterThan(0)
    expect(moved[0]?.id).toBe('session-id')
  })

  it('dry-run mode still computes the hypothetical post-relocation prefix hash without rewriting the request', () => {
    const req = baseRequest('abc-123')
    const cfg = resolveConfig({ deferral: { enabled: true, dryRun: true, extractors: [SESSION_EXTRACTOR] } })
    const { req: out, prefixHashBefore, prefixHashAfter } = defer(req, cfg)

    expect(out).toEqual(req)
    expect(prefixHashAfter).not.toBe(prefixHashBefore)
  })

  it('dry-run mode reports no hash change when nothing matches (no-op case)', () => {
    const req = baseRequest('abc-123')
    const cfg = resolveConfig({ deferral: { enabled: true, dryRun: true, extractors: [] } })
    const { prefixHashBefore, prefixHashAfter } = defer(req, cfg)

    expect(prefixHashAfter).toBe(prefixHashBefore)
  })

  it('active mode appends a trailing relocated-context block containing every moved span verbatim', () => {
    const req = baseRequest('abc-123')
    const cfg = resolveConfig({ deferral: { enabled: true, dryRun: false, extractors: [SESSION_EXTRACTOR] } })
    const { req: out, moved } = defer(req, cfg)

    const lastMessage = out.messages.at(-1)!
    const blocks = lastMessage.content as { type: string; text: string }[]
    const relocatedBlock = blocks.at(-1)!
    expect(relocatedBlock.text).toContain('<relocated-context>')
    expect(relocatedBlock.text).toContain('</relocated-context>')
    for (const span of moved) {
      expect(relocatedBlock.text).toContain(span.text)
    }
  })

  it('active mode removes the extracted span from its original location (RELOCATE not DUPLICATE)', () => {
    const req = baseRequest('abc-123')
    const cfg = resolveConfig({ deferral: { enabled: true, dryRun: false, extractors: [SESSION_EXTRACTOR] } })
    const { req: out } = defer(req, cfg)

    const originalMessage = out.messages[1]!
    const blocks = originalMessage.content as { text: string }[]
    expect(blocks[0]?.text).not.toContain('session abc-123 is active')
  })

  it('property: every extracted span is removed from its source and reappears verbatim in the relocated block (RELOCATE never DELETE — no span bytes lost)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-z0-9]+$/.test(s)), (sessionId) => {
        const req = baseRequest(sessionId)
        const cfg = resolveConfig({ deferral: { enabled: true, dryRun: false, extractors: [SESSION_EXTRACTOR] } })
        const { req: out, moved } = defer(req, cfg)

        expect(moved.length).toBeGreaterThan(0)
        const relocatedBlock = out.messages.at(-1)!.content as { text: string }[]
        const relocatedText = relocatedBlock.at(-1)!.text
        for (const span of moved) {
          expect(relocatedText).toContain(span.text)
        }

        const sourceMessage = out.messages[1]!
        const sourceBlocks = sourceMessage.content as { text: string }[]
        for (const span of moved) {
          expect(sourceBlocks[0]?.text).not.toContain(span.text)
        }
      }),
      { numRuns: 50 },
    )
  })
})
