// Regression test for production-audit finding HIGH-2: WriteBarrier must
// evict a hash's entry once it goes warm, instead of retaining it forever.
// src/barrier.ts's firstByte() sets warm=true and releases followers but
// never calls entries.delete(hash) (unlike fail() and releaseOnTimeout(),
// which both do) — an unbounded memory leak, and once the real Anthropic
// cache TTL expires server-side, every future caller for that hash is stuck
// being told 'follower' forever, for a write that will never land.
import { describe, expect, it } from 'vitest'
import { WriteBarrier } from '../src/barrier.js'
import type { WriteBarrierScheduler } from '../src/barrier.js'

interface FakeScheduler extends WriteBarrierScheduler {
  fire: () => void
  isScheduled: () => boolean
  scheduledCount: () => number
}

function createFakeScheduler(): FakeScheduler {
  const scheduled: Array<{ callback: () => void }> = []
  return {
    now: () => 0,
    setTimeout: (callback: () => void) => {
      const handle = { callback }
      scheduled.push(handle)
      return handle
    },
    clearTimeout: (handle: unknown) => {
      const idx = scheduled.findIndex((h) => h === handle)
      if (idx !== -1) scheduled.splice(idx, 1)
    },
    fire: () => {
      const handle = scheduled.shift()
      if (handle === undefined) throw new Error('no timeout scheduled')
      handle.callback()
    },
    isScheduled: () => scheduled.length > 0,
    scheduledCount: () => scheduled.length,
  }
}

describe('WriteBarrier eviction regression (audit finding HIGH-2)', () => {
  it('evicts a hash entry once it goes warm, so a later caller becomes a fresh leader again', async () => {
    const scheduler = createFakeScheduler()
    const barrier = new WriteBarrier({ holdTimeoutMs: 5000, scheduler })

    const first = await barrier.enter('hash-evict')
    expect(first.role).toBe('leader')

    barrier.firstByte('hash-evict')

    // An eviction timeout should now be scheduled (replacing the cleared
    // hold-timeout) — firing it simulates the real cache TTL expiring.
    expect(scheduler.isScheduled()).toBe(true)
    scheduler.fire()

    const afterEviction = await barrier.enter('hash-evict')
    expect(afterEviction.role).toBe('leader')
  })

  it('does not retain a Map entry indefinitely for a hash that only fired once', async () => {
    const scheduler = createFakeScheduler()
    const barrier = new WriteBarrier({ holdTimeoutMs: 5000, scheduler })

    await barrier.enter('hash-leak')
    barrier.firstByte('hash-leak')

    // If the entry were retained forever with warm=true, every future
    // enter() for this hash would immediately resolve 'follower' with no
    // eviction ever scheduled. A correct implementation schedules a fresh
    // eviction timeout at firstByte() time instead of leaving nothing
    // pending.
    expect(scheduler.scheduledCount()).toBeGreaterThan(0)
  })
})
