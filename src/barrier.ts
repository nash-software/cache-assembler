export type WriteBarrierRole = 'leader' | 'follower'

export interface WriteBarrierEnterResult {
  role: WriteBarrierRole
}

export interface WriteBarrierScheduler {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface WriteBarrierOptions {
  holdTimeoutMs?: number
  /** How long a warm entry stays warm before eviction. Defaults to the
   * shorter (5-minute) real Anthropic cache TTL — a conservative lower
   * bound, since the barrier isn't told which TTL tier the actual
   * breakpoint used. Evicting too early only costs an extra write cycle;
   * evicting too late would leave future callers waiting on a cache entry
   * that's already gone. */
  warmTtlMs?: number
  scheduler?: WriteBarrierScheduler
}

const DEFAULT_HOLD_TIMEOUT_MS = 15000
const DEFAULT_WARM_TTL_MS = 5 * 60 * 1000

const DEFAULT_SCHEDULER: WriteBarrierScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

interface BarrierEntry {
  warm: boolean
  followers: Array<(result: WriteBarrierEnterResult) => void>
  timeoutHandle: unknown
}

/**
 * Coordinates fan-out for concurrent identical-prefix-hash requests: the
 * first caller for a hash becomes the leader and performs the real upstream
 * call; concurrent callers for the same hash become followers held until
 * firstByte() signals the cache entry is readable.
 */
export class WriteBarrier {
  private readonly entries = new Map<string, BarrierEntry>()
  private readonly holdTimeoutMs: number
  private readonly warmTtlMs: number
  private readonly scheduler: WriteBarrierScheduler

  constructor(options: WriteBarrierOptions = {}) {
    this.holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS
    this.warmTtlMs = options.warmTtlMs ?? DEFAULT_WARM_TTL_MS
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER
  }

  enter(hash: string): Promise<WriteBarrierEnterResult> {
    const existing = this.entries.get(hash)
    if (existing === undefined) {
      const entry: BarrierEntry = {
        warm: false,
        followers: [],
        timeoutHandle: this.scheduler.setTimeout(() => this.releaseOnTimeout(hash), this.holdTimeoutMs),
      }
      this.entries.set(hash, entry)
      return Promise.resolve({ role: 'leader' })
    }
    if (existing.warm) {
      return Promise.resolve({ role: 'follower' })
    }
    return new Promise((resolve) => {
      existing.followers.push(resolve)
    })
  }

  firstByte(hash: string): void {
    const entry = this.entries.get(hash)
    if (entry === undefined) return
    this.clearTimeout(entry)
    entry.warm = true
    this.releaseFollowers(entry)
    // Without this, a warm entry lives in `entries` forever: unbounded
    // memory growth (one entry per unique prefix hash, ever), and once the
    // real Anthropic cache TTL expires server-side, every future caller for
    // this hash would still be told 'follower' for a write that will never
    // land. Evict on the same schedule as the real cache entry's lifetime.
    entry.timeoutHandle = this.scheduler.setTimeout(() => this.entries.delete(hash), this.warmTtlMs)
  }

  /**
   * Fail-open path for leader-side upstream errors: releases every pending
   * follower and clears the hash's state entirely so the next enter() for
   * that hash starts a fresh leader/follower cycle rather than staying warm
   * against a cache entry that was never actually written. Never evicts an
   * already-warm entry: firstByte() already confirmed the write landed, so a
   * later fail() call (e.g. a non-2xx response arriving after a prior 2xx
   * warmed the same hash) must not discard a real cache entry.
   */
  fail(hash: string): void {
    const entry = this.entries.get(hash)
    if (entry === undefined) return
    if (entry.warm) return
    this.clearTimeout(entry)
    this.releaseFollowers(entry)
    this.entries.delete(hash)
  }

  private releaseOnTimeout(hash: string): void {
    const entry = this.entries.get(hash)
    if (entry === undefined) return
    this.releaseFollowers(entry)
    this.entries.delete(hash)
  }

  private releaseFollowers(entry: BarrierEntry): void {
    const followers = entry.followers
    entry.followers = []
    for (const resolve of followers) {
      resolve({ role: 'follower' })
    }
  }

  private clearTimeout(entry: BarrierEntry): void {
    if (entry.timeoutHandle !== undefined) {
      this.scheduler.clearTimeout(entry.timeoutHandle)
    }
  }
}
