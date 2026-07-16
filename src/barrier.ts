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
  scheduler?: WriteBarrierScheduler
}

const DEFAULT_HOLD_TIMEOUT_MS = 15000

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
  private readonly scheduler: WriteBarrierScheduler

  constructor(options: WriteBarrierOptions = {}) {
    this.holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS
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
  }

  /**
   * Fail-open path for leader-side upstream errors: releases every pending
   * follower and clears the hash's state entirely so the next enter() for
   * that hash starts a fresh leader/follower cycle rather than staying warm
   * against a cache entry that was never actually written.
   */
  fail(hash: string): void {
    const entry = this.entries.get(hash)
    if (entry === undefined) return
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
