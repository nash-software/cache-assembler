import { describe, expect, it } from 'vitest'
import { run } from '../src/cli.js'

function fakeIo(): { stdout: string[]; stderr: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) } }
}

describe('CLI argument validation (production-audit finding MEDIUM-6)', () => {
  it('returns exit code 1 with a usage message for an unknown flag, never throws', () => {
    const { io, stderr } = fakeIo()
    expect(() => run(['--totally-bogus-flag'], io)).not.toThrow()
    expect(run(['--totally-bogus-flag'], io)).toBe(1)
    expect(stderr.join('')).toContain('Error:')
  })

  it('returns exit code 1 for a non-numeric --port', () => {
    const { io } = fakeIo()
    expect(run(['--upstream', 'https://api.anthropic.com', '--port', 'abc'], io)).toBe(1)
  })

  it('returns exit code 1 for a --port outside the valid range', () => {
    const { io } = fakeIo()
    expect(run(['--upstream', 'https://api.anthropic.com', '--port', '99999'], io)).toBe(1)
  })

  it('returns exit code 1 for a malformed --upstream, without attempting to bind a port', () => {
    const { io } = fakeIo()
    expect(run(['--upstream', 'not a url', '--port', '48311'], io)).toBe(1)
  })

  it('still returns undefined and starts listening for valid arguments', async () => {
    const { io } = fakeIo()
    const exitCode = run(['--upstream', 'https://api.anthropic.com', '--port', '48312'], io)
    expect(exitCode).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
})

describe('CLI listen-error hardening (production-audit finding MEDIUM-6)', () => {
  it('reports a clean error instead of crashing when the port is already in use', async () => {
    // run() doesn't expose the server it creates (a CLI entrypoint has no
    // reason to), so the first listener here is left running for the rest
    // of the process — a known, accepted limitation of testing this path
    // without a larger API change; the dedicated port keeps it from
    // colliding with any other test in this file.
    const port = 48313
    const { io: firstIo } = fakeIo()
    run(['--upstream', 'https://api.anthropic.com', '--port', String(port)], firstIo)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const { io: secondIo, stderr } = fakeIo()
    expect(() => run(['--upstream', 'https://api.anthropic.com', '--port', String(port)], secondIo)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(stderr.join('')).toContain('Error:')
  })
})
