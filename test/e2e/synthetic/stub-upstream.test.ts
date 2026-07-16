import { describe, expect, it } from 'vitest'
import { collectSegments, simulateUsage } from './stub-upstream.js'

const TOKEN_BYTE_RATIO = 4

function toolWithBreakpoint(name = 't1'): { name: string; input_schema: Record<string, unknown>; cache_control: { type: 'ephemeral' } } {
  return { name, input_schema: {}, cache_control: { type: 'ephemeral' } }
}

describe('simulateUsage (stub cache simulation)', () => {
  it('a body with no cache_control breakpoints reports only input_tokens and commits nothing', () => {
    const body = JSON.stringify({
      tools: [{ name: 't1', input_schema: {} }],
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    const seen = new Set<string>()

    const usage = simulateUsage(body, seen, true)

    expect(usage).toEqual({ input_tokens: Math.ceil(body.length / TOKEN_BYTE_RATIO) })
    expect(seen.size).toBe(0)
  })

  it('first sight of a breakpointed body with commit writes but does not read', () => {
    const body = JSON.stringify({
      tools: [toolWithBreakpoint()],
      system: [],
      messages: [],
    })
    const seen = new Set<string>()

    const usage = simulateUsage(body, seen, true)

    expect(usage.cache_creation_input_tokens).toBeGreaterThan(0)
    expect(usage.cache_read_input_tokens).toBeUndefined()

    const [segment] = collectSegments(body)
    expect(seen.has(segment!.hash)).toBe(true)
  })

  it('an identical body seen again reads the full segment and creates nothing new', () => {
    const body = JSON.stringify({
      tools: [toolWithBreakpoint()],
      system: [],
      messages: [],
    })
    const seen = new Set<string>()
    simulateUsage(body, seen, true) // commit the first sighting

    const usage = simulateUsage(body, seen, false)

    expect(usage.cache_read_input_tokens).toBeGreaterThan(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  it('longest-prefix selection: reads a shared tools segment and writes the system-segment delta', () => {
    const originalBody = JSON.stringify({
      tools: [toolWithBreakpoint()],
      system: [{ type: 'text', text: 'sys-v1', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    const seen = new Set<string>()
    simulateUsage(originalBody, seen, true) // commit both the tools- and system-level segments

    // Same tools array (byte-identical), but different system/messages content —
    // only the tools-segment hash can possibly match what was committed above.
    const newBody = JSON.stringify({
      tools: [toolWithBreakpoint()],
      system: [{ type: 'text', text: 'sys-v2-completely-different', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'goodbye' }] }],
    })

    const usage = simulateUsage(newBody, seen, false)
    const segments = collectSegments(newBody)
    const toolsSegment = segments[0]!
    const systemSegment = segments[1]!

    expect(usage.cache_read_input_tokens).toBe(Math.ceil(toolsSegment.length / TOKEN_BYTE_RATIO))
    expect(usage.cache_creation_input_tokens).toBe(
      Math.ceil((systemSegment.length - toolsSegment.length) / TOKEN_BYTE_RATIO),
    )
    expect(usage.cache_creation_input_tokens).toBeGreaterThan(0)
  })

  it('commit:false leaves seen unchanged (the delayed-commit snapshot contract)', () => {
    const body = JSON.stringify({
      tools: [toolWithBreakpoint()],
      system: [],
      messages: [],
    })
    const seen = new Set<string>()

    simulateUsage(body, seen, false)

    expect(seen.size).toBe(0)
  })
})
