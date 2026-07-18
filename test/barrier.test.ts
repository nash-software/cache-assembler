import { describe, expect, it } from 'vitest'
import { WriteBarrier } from '../src/barrier.js'
import type { WriteBarrierScheduler } from '../src/barrier.js'

describe('WriteBarrier (F4 fan-out coordination)', () => {
  it('single enter for a fresh hash resolves as leader', async () => {
    const barrier = new WriteBarrier()
    const result = await barrier.enter('hash-a')
    expect(result.role).toBe('leader')
  })

  it('second concurrent enter for the same hash is held until firstByte()', async () => {
    const barrier = new WriteBarrier()
    const leaderPromise = barrier.enter('hash-b')
    const followerPromise = barrier.enter('hash-b')

    expect((await leaderPromise).role).toBe('leader')

    let followerResolved = false
    void followerPromise.then(() => {
      followerResolved = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(followerResolved).toBe(false)

    barrier.firstByte('hash-b')
    expect((await followerPromise).role).toBe('follower')
    expect(followerResolved).toBe(true)
  })

  it('5 concurrent enters for one hash produce 1 leader and 4 followers, all released on firstByte()', async () => {
    const barrier = new WriteBarrier()
    const pending = [
      barrier.enter('hash-c'),
      barrier.enter('hash-c'),
      barrier.enter('hash-c'),
      barrier.enter('hash-c'),
      barrier.enter('hash-c'),
    ]

    barrier.firstByte('hash-c')
    const roles = await Promise.all(pending)
    const leaders = roles.filter((r) => r.role === 'leader')
    const followers = roles.filter((r) => r.role === 'follower')
    expect(leaders).toHaveLength(1)
    expect(followers).toHaveLength(4)
  })

  it('different hashes each get their own independent leader', async () => {
    const barrier = new WriteBarrier()
    const a = await barrier.enter('hash-x')
    const b = await barrier.enter('hash-y')
    expect(a.role).toBe('leader')
    expect(b.role).toBe('leader')
  })

  it('a hash marked warm by firstByte() resolves subsequent enters as follower immediately', async () => {
    const barrier = new WriteBarrier()
    await barrier.enter('hash-warm')
    barrier.firstByte('hash-warm')

    const result = await barrier.enter('hash-warm')
    expect(result.role).toBe('follower')
  })
})

interface FakeScheduler extends WriteBarrierScheduler {
  fire: () => void
  isScheduled: () => boolean
}

function createFakeScheduler(): FakeScheduler {
  let scheduled: { callback: () => void } | null = null
  return {
    now: () => 0,
    setTimeout: (callback: () => void) => {
      const handle = { callback }
      scheduled = handle
      return handle
    },
    clearTimeout: (handle: unknown) => {
      if (handle === scheduled) scheduled = null
    },
    fire: () => {
      if (scheduled === null) throw new Error('no timeout scheduled')
      const { callback } = scheduled
      scheduled = null
      callback()
    },
    isScheduled: () => scheduled !== null,
  }
}

describe('WriteBarrier timeout and error paths (F4 fail-open)', () => {
  it('holdTimeoutMs expiry releases all pending followers (fail-open)', async () => {
    const scheduler = createFakeScheduler()
    const barrier = new WriteBarrier({ holdTimeoutMs: 5000, scheduler })

    const leader = await barrier.enter('hash-timeout')
    expect(leader.role).toBe('leader')

    const follower1 = barrier.enter('hash-timeout')
    const follower2 = barrier.enter('hash-timeout')

    scheduler.fire()

    const results = await Promise.all([follower1, follower2])
    expect(results.every((r) => r.role === 'follower')).toBe(true)
  })

  it('leader error via fail() releases all pending followers (fail-open)', async () => {
    const barrier = new WriteBarrier()
    const leader = await barrier.enter('hash-err')
    expect(leader.role).toBe('leader')

    const follower1 = barrier.enter('hash-err')
    const follower2 = barrier.enter('hash-err')
    const follower3 = barrier.enter('hash-err')

    barrier.fail('hash-err')

    const results = await Promise.all([follower1, follower2, follower3])
    expect(results.every((r) => r.role === 'follower')).toBe(true)
  })

  it('fail() clears warm state so the next enter for that hash becomes a new leader', async () => {
    const barrier = new WriteBarrier()
    await barrier.enter('hash-retry')
    const follower = barrier.enter('hash-retry')

    barrier.fail('hash-retry')
    expect((await follower).role).toBe('follower')

    const next = await barrier.enter('hash-retry')
    expect(next.role).toBe('leader')
  })

  it('fail() on a hash with no active entry is a safe no-op that does not affect other hashes', async () => {
    const barrier = new WriteBarrier()
    expect(() => barrier.fail('never-entered')).not.toThrow()

    const leader = await barrier.enter('hash-untouched')
    const followerPromise = barrier.enter('hash-untouched')
    barrier.fail('never-entered')
    barrier.firstByte('hash-untouched')

    expect(leader.role).toBe('leader')
    expect((await followerPromise).role).toBe('follower')
  })

  it('replaces the hold-timeout with an eviction timeout once firstByte() fires, rather than double-scheduling', async () => {
    const scheduler = createFakeScheduler()
    const barrier = new WriteBarrier({ scheduler })

    await barrier.enter('hash-ok')
    barrier.firstByte('hash-ok')

    // The original hold-timeout is cleared; a single new eviction timeout
    // takes its place (see audit-fix-barrier-eviction.test.ts) — never both
    // at once, and firing it doesn't crash or re-release followers.
    expect(scheduler.isScheduled()).toBe(true)
    expect(() => scheduler.fire()).not.toThrow()
    expect(scheduler.isScheduled()).toBe(false)
  })
})
