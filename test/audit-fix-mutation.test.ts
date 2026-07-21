// Regression test for production-audit finding HIGH-1: assemble() must never
// mutate the caller's own request object. src/assemble.ts documents "Never
// mutates req" — this test proves that contract under the DEFAULT config
// (deferral off), where normalizeSystem() previously returned req.system by
// reference (not a copy) and placeBreakpoints() mutated it in place via
// index assignment.
import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import type { AnthropicRequestLike } from '../src/types.js'

describe('assemble() input-mutation regression (audit finding HIGH-1)', () => {
  it('never mutates the caller-supplied req.system array under default config', () => {
    const req: AnthropicRequestLike = {
      model: 'claude-haiku-4-5-20251001',
      system: [{ type: 'text', text: 'stable system prompt' }],
      tools: [{ name: 'read', input_schema: {} }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const systemRef = req.system
    const systemSnapshotBefore = JSON.parse(JSON.stringify(req.system))

    assemble(req, {})

    expect(req.system).toBe(systemRef)
    expect(req.system).toEqual(systemSnapshotBefore)
  })

  it('never mutates the caller-supplied req.messages array under default config', () => {
    const req: AnthropicRequestLike = {
      model: 'claude-haiku-4-5-20251001',
      system: [{ type: 'text', text: 'stable system prompt' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
        { role: 'user', content: [{ type: 'text', text: 'third' }] },
      ],
    }
    const messagesSnapshotBefore = JSON.parse(JSON.stringify(req.messages))

    assemble(req, {})

    expect(req.messages).toEqual(messagesSnapshotBefore)
  })
})
