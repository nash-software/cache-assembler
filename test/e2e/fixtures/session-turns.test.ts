import { describe, expect, it } from 'vitest'
import { buildSessionTurns, defaultVolatileParams } from './session-turns.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_URL_RE = /^https:\/\/claude\.ai\/code\/session_[0-9a-f]+$/

describe('defaultVolatileParams', () => {
  it('is deterministic: the same instance index yields identical params', () => {
    expect(defaultVolatileParams(3)).toEqual(defaultVolatileParams(3))
  })

  it('gives different instances different volatile params', () => {
    const a = defaultVolatileParams(0)
    const b = defaultVolatileParams(1)
    expect(a.scratchpadUuid).not.toBe(b.scratchpadUuid)
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.sessionUrl).not.toBe(b.sessionUrl)
  })

  it('produces UUID-shaped scratchpadUuid and sessionId matching the preset extractor regex', () => {
    const params = defaultVolatileParams(5)
    expect(params.scratchpadUuid).toMatch(UUID_RE)
    expect(params.sessionId).toMatch(UUID_RE)
  })

  it('produces a session URL matching the preset extractor regex', () => {
    expect(defaultVolatileParams(5).sessionUrl).toMatch(SESSION_URL_RE)
  })
})

describe('buildSessionTurns', () => {
  const params = defaultVolatileParams(0)

  it('returns one request per turn, k=1..turns', () => {
    const requests = buildSessionTurns(params, 6)
    expect(requests).toHaveLength(6)
  })

  it('builds messages [u1,a1,...,u_k] with 2k-1 entries for turn k', () => {
    const requests = buildSessionTurns(params, 6)
    requests.forEach((request, index) => {
      const k = index + 1
      expect(request.messages).toHaveLength(2 * k - 1)
    })
  })

  it('alternates user/assistant roles starting and ending on user', () => {
    const [turn3] = buildSessionTurns(params, 3).slice(2)
    const roles = turn3!.messages.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
  })

  it('ends the final turn on a user message (the pending turn awaiting a response)', () => {
    const requests = buildSessionTurns(params, 4)
    const lastTurn = requests[requests.length - 1]!
    expect(lastTurn.messages[lastTurn.messages.length - 1]!.role).toBe('user')
  })

  it('templates every volatile span into system/tools — no fixture placeholders leak through', () => {
    const [request] = buildSessionTurns(params, 1)
    const serialized = JSON.stringify(request)
    expect(serialized).toContain(params.scratchpadUuid)
    expect(serialized).toContain(params.sessionId)
    expect(serialized).toContain(params.sessionUrl)
    // The fixture's own hardcoded placeholders must not survive templating.
    expect(serialized).not.toContain('a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6')
    expect(serialized).not.toContain('8f14e45f-ceea-467e-bd42-ce8ea5b1a12b')
    expect(serialized).not.toContain('012kpcX8paHadnC9wNqomTcE')
  })

  it('shares identical volatile bytes across every turn of the same instance', () => {
    const requests = buildSessionTurns(params, 3)
    const systems = requests.map((r) => JSON.stringify(r.system))
    expect(new Set(systems).size).toBe(1)
  })
})
