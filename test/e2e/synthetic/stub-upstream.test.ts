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

  function msg(role: 'user' | 'assistant', text: string, withBreakpoint = false): unknown {
    return {
      role,
      content: [{ type: 'text', text, ...(withBreakpoint ? { cache_control: { type: 'ephemeral' } } : {}) }],
    }
  }

  it('growing conversation: an earlier shorter committed message-chain is creditable as a real prefix of a later, longer request', () => {
    const tools = [toolWithBreakpoint()]
    const system: unknown[] = []

    // Turn 2: [u1, a1(breakpoint), u2] — breakpoint on the last-stable message (a1),
    // matching placeBreakpoints' "last-stable-message boundary" convention.
    const turn2Body = JSON.stringify({
      tools,
      system,
      messages: [msg('user', 'u1'), msg('assistant', 'a1', true), msg('user', 'u2')],
    })
    const seen = new Set<string>()
    simulateUsage(turn2Body, seen, true) // commit turn 2's rolling chain (base+u1+a1)

    // Turn 3: same u1/a1 prefix, two more turns appended, breakpoint moved to a2.
    const turn3Body = JSON.stringify({
      tools,
      system,
      messages: [
        msg('user', 'u1'),
        msg('assistant', 'a1'),
        msg('user', 'u2'),
        msg('assistant', 'a2', true),
        msg('user', 'u3'),
      ],
    })

    const usage = simulateUsage(turn3Body, seen, false)

    expect(usage.cache_read_input_tokens).toBeGreaterThan(0)
    expect(usage.cache_creation_input_tokens).toBeGreaterThan(0)

    // The read credit matches turn 2's exact committed chain length (base+u1+a1) —
    // proving the shorter, earlier turn's commit is discoverable as a genuine
    // prefix of turn 3's longer request, not re-billed as a fresh write.
    const turn2Segments = collectSegments(turn2Body)
    const turn2LastSegment = turn2Segments[turn2Segments.length - 1]!
    expect(usage.cache_read_input_tokens).toBe(Math.ceil(turn2LastSegment.length / TOKEN_BYTE_RATIO))

    // And the creation charge is only the incremental tail (u2+a2 newly added to
    // the chain), not the whole turn-3 prefix re-billed from scratch.
    const turn3Segments = collectSegments(turn3Body)
    const turn3LastSegment = turn3Segments[turn3Segments.length - 1]!
    expect(usage.cache_creation_input_tokens).toBe(
      Math.ceil((turn3LastSegment.length - turn2LastSegment.length) / TOKEN_BYTE_RATIO),
    )
  })

  it('a request with no message breakpoint (fewer than 2 messages) gets no message segment at all', () => {
    const tools = [toolWithBreakpoint()]
    const turn1Body = JSON.stringify({ tools, system: [], messages: [msg('user', 'u1')] })

    const segments = collectSegments(turn1Body)

    expect(segments).toHaveLength(1) // the tools segment only — no message-chain segment
  })
})
