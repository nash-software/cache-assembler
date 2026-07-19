import { describe, expect, it } from 'vitest'
import { placeBreakpoints } from '../src/breakpoints.js'
import { resolveConfig } from '../src/config.js'
import type { AnthropicRequestLike, ToolDefinition, MessageParam } from '../src/types.js'

function tool(name: string, cacheControl?: ToolDefinition['cache_control']): ToolDefinition {
  return { name, input_schema: {}, ...(cacheControl ? { cache_control: cacheControl } : {}) }
}

function textMessage(role: MessageParam['role'], text: string): MessageParam {
  return { role, content: [{ type: 'text', text }] }
}

describe('placeBreakpoints', () => {
  it('places 3 breakpoints when 0 pre-existing: tool, system, last-stable-message', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second'), textMessage('user', 'third')],
      system: [{ type: 'text', text: 'sys' }],
      tools: [tool('a'), tool('b')],
    }
    const { req: out, placed } = placeBreakpoints(req, resolveConfig({}))

    expect(placed).toHaveLength(3)
    expect(out.tools?.[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    const system = out.system as { cache_control?: unknown }[]
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    // last-stable-message = last content block of message excluding the final (newest) message
    const stableMessage = out.messages[1]!
    const stableBlocks = stableMessage.content as { cache_control?: unknown }[]
    expect(stableBlocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
  })

  it('places 0 breakpoints when 4 pre-existing (never exceeds the API budget)', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second')],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [
        tool('a', { type: 'ephemeral' }),
        tool('b', { type: 'ephemeral' }),
        tool('c', { type: 'ephemeral' }),
      ],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed).toHaveLength(0)
  })

  it('places 2 breakpoints when 2 pre-existing, never touching the existing ones', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second'), textMessage('user', 'third')],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [tool('a', { type: 'ephemeral' }), tool('b')],
    }
    const { req: out, placed } = placeBreakpoints(req, resolveConfig({}))

    expect(placed).toHaveLength(2)
    // existing client breakpoints untouched
    const system = out.system as { cache_control?: unknown }[]
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(out.tools?.[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('normalizes a string system field to a one-block array before placing a breakpoint', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second')],
      system: 'sys as string',
    }
    const { req: out, placed } = placeBreakpoints(req, resolveConfig({}))

    expect(Array.isArray(out.system)).toBe(true)
    const system = out.system as { type: string; text: string; cache_control?: unknown }[]
    expect(system).toHaveLength(1)
    expect(system[0]?.text).toBe('sys as string')
    expect(placed.some((p) => p.location === 'system')).toBe(true)
  })

  it('skips the tool placement gracefully when there are no tools', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second')],
      system: [{ type: 'text', text: 'sys' }],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed.some((p) => p.location === 'tool')).toBe(false)
    expect(placed.some((p) => p.location === 'system')).toBe(true)
  })

  it('respects a custom maxSlots override, placing only the highest-priority candidate when maxSlots is 1', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second'), textMessage('user', 'third')],
      system: [{ type: 'text', text: 'sys' }],
      tools: [tool('a'), tool('b')],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({ breakpoints: { maxSlots: 1 } }))

    expect(placed).toHaveLength(1)
    expect(placed[0]?.location).toBe('tool')
    // sole placement is also the final one, so it gets the shorter TTL tier
    expect(placed[0]?.ttl).toBe('5m')
  })

  it('tiers TTL 1h for all placements except the final one, which gets 5m', () => {
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second')],
      system: [{ type: 'text', text: 'sys' }],
      tools: [tool('a')],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed.length).toBeGreaterThan(0)
    placed.slice(0, -1).forEach((p) => expect(p.ttl).toBe('1h'))
    expect(placed.at(-1)?.ttl).toBe('5m')
  })

  it('forces every new placement to 5m when an existing breakpoint has no ttl (defaults to 5m server-side), never emitting an invalid 1h-after-5m sequence', () => {
    // Reproduces the real API 400: "a ttl='1h' cache_control block must not
    // come after a ttl='5m' cache_control block" — a client (e.g. Claude
    // Code) sets a breakpoint on the last tool with no explicit ttl, which
    // the API defaults to 5m. Any new breakpoint placed after it must not be 1h.
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second'), textMessage('user', 'third')],
      system: [{ type: 'text', text: 'sys' }],
      tools: [tool('a', { type: 'ephemeral' })],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed.length).toBeGreaterThan(0)
    placed.forEach((p) => expect(p.ttl).toBe('5m'))
  })

  it('preserves normal 1h/5m tiering when the only existing breakpoint is explicitly ttl=1h', () => {
    // An existing 1h breakpoint does not force anything — only a lower-tier
    // (5m or no-ttl) existing breakpoint does.
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'first'), textMessage('assistant', 'second'), textMessage('user', 'third')],
      system: [{ type: 'text', text: 'sys' }],
      tools: [tool('a', { type: 'ephemeral', ttl: '1h' })],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed.length).toBeGreaterThan(0)
    placed.slice(0, -1).forEach((p) => expect(p.ttl).toBe('1h'))
    expect(placed.at(-1)?.ttl).toBe('5m')
  })

  it('forces a new placement UP to 1h when an existing 1h breakpoint follows it, instead of naively giving it 5m for being "last in its own batch"', () => {
    // Reproduces the live-test 400 that survived the first fix: with only
    // ONE free candidate (the last tool — system already carries an
    // existing breakpoint, and a single message means no message-boundary
    // candidate is even eligible), the naive rule ("last in the new batch
    // gets 5m") assigned this sole new tool placement 5m even though the
    // EXISTING system breakpoint right after it is 1h — producing the exact
    // invalid 5m-then-1h sequence the real API rejected. The new placement
    // must be forced up to 1h instead.
    const req: AnthropicRequestLike = {
      messages: [textMessage('user', 'only')],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [tool('a')],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed).toHaveLength(1)
    expect(placed[0]?.location).toBe('tool')
    expect(placed[0]?.ttl).toBe('1h')
  })

  it('forces an earlier new placement UP to 1h when a LATER new placement is itself forced up by an existing 1h breakpoint after it', () => {
    // toPlace = [tool, message] (no system field, so system never becomes a
    // candidate). The existing 1h breakpoint sits on the newest (final)
    // message — a position AFTER the message-boundary candidate, which is
    // always the second-to-last message. That forces the message candidate
    // up to 1h (instead of its naive 5m "last in batch" preference), which
    // must then also force the earlier tool candidate up to 1h (new
    // placements must be non-increasing among themselves too).
    const req: AnthropicRequestLike = {
      messages: [
        textMessage('user', 'first'),
        textMessage('assistant', 'second'),
        { role: 'user', content: [{ type: 'text', text: 'third', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
      tools: [tool('a')],
    }
    const { placed } = placeBreakpoints(req, resolveConfig({}))
    expect(placed.length).toBeGreaterThan(0)
    placed.forEach((p) => expect(p.ttl).toBe('1h'))
  })
})
