// Regression tests for the four bundled MEDIUM production-audit findings.
// Each sub-test proves one finding exists now against the unfixed tree.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProxyServer } from '../src/server.js'
import { run } from '../src/cli.js'
import { defer } from '../src/deferral.js'
import { isPotentiallyCatastrophicPattern } from '../src/regex-safety.js'
import type { AnthropicRequestLike } from '../src/types.js'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close))
})
async function startFakeUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string }> {
  const server = createServer(handler)
  servers.push(server)
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}` }
}

// --- Finding 4: trace-log redaction misses proxy-authorization ---
// Note: since the item-2 allowlist fix (fix-remaining-prelaunch-findings plan,
// step 2), non-allowlisted headers are marked '[not logged]' rather than
// '[redacted]' — the marker text changed, but the guarantee this test proves
// (a credential header's raw value never reaches the trace log) still holds.
describe('trace-log redaction regression (audit finding MEDIUM-4)', () => {
  it('never logs proxy-authorization verbatim, same as authorization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-assembler-audit-'))
    const traceLogPath = join(dir, 'trace.jsonl')
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })
    const server = createProxyServer({ upstream: upstream.url, config: { barrier: { enabled: false } }, traceLogPath })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'proxy-authorization': 'Bearer super-secret-proxy-token',
      },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    })

    const line = readFileSync(traceLogPath, 'utf8').trim().split('\n')[0]!
    const entry = JSON.parse(line) as { headers: Record<string, string> }
    expect(entry.headers['proxy-authorization']).toBe('[not logged]')

    rmSync(dir, { recursive: true, force: true })
  })
})

// --- Finding 5: deferral extractors have no bound against a ReDoS pattern ---
describe('deferral extractor ReDoS regression (audit finding MEDIUM-5)', () => {
  it('completes quickly even against a catastrophic-backtracking pattern and an adversarial value', () => {
    const req: AnthropicRequestLike = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: [{ type: 'text', text: 'a'.repeat(24) + '!' }],
    }
    const cfg = {
      deferral: {
        enabled: true,
        dryRun: true,
        extractors: [{ id: 'evil', path: 'system[*].text', pattern: '^(a+)+$' }],
      },
    }

    const started = Date.now()
    defer(req, cfg)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(500)
  }, 2000)
})

// --- Pre-launch review finding: a single compiled matcher (with a `g` flag)
// was reused across every accessor a wildcard extractor path resolves to.
// RegExp.exec keeps lastIndex on the instance between calls, so the second
// accessor's search silently started where the first accessor's match ended.
// Verified live before the fix: 2 identical spans in 2 system blocks, matched
// with a `g`-flagged extractor, found only 1 instead of both.
describe('deferral matcher lastIndex reset across wildcard accessors', () => {
  it('extracts a matching span from every accessor a wildcard path resolves to, not just the first', () => {
    const req: AnthropicRequestLike = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: [
        { type: 'text', text: 'block one session-abc123 stable text' },
        { type: 'text', text: 'block two session-abc123 stable text' },
      ],
    }
    const cfg = {
      deferral: {
        enabled: true,
        dryRun: false,
        extractors: [{ id: 'session', path: 'system[*].text', pattern: 'session-[a-z0-9]+', flags: 'g' }],
      },
    }

    const { moved } = defer(req, cfg)

    expect(moved).toHaveLength(2)
    expect(moved.map((m) => m.text)).toEqual(['session-abc123', 'session-abc123'])
  })
})

// --- Pre-launch review finding: the ReDoS guard only caught nested
// quantifiers, missing overlapping alternation and bounded-quantifier forms.
// Verified live before the fix: '(a|a)+$' against a 28-char string hung the
// process past a 30s timeout, and isPotentiallyCatastrophicPattern returned
// false for both shapes below.
describe('ReDoS guard covers overlapping alternation and bounded quantifiers', () => {
  it('flags overlapping alternation under a quantifier', () => {
    expect(isPotentiallyCatastrophicPattern('(a|a)+$')).toBe(true)
    expect(isPotentiallyCatastrophicPattern('(a|ab)+$')).toBe(true)
  })

  it('flags a bounded/ranged quantifier used the same way as +/*', () => {
    expect(isPotentiallyCatastrophicPattern('(a{1,}){1,}$')).toBe(true)
    expect(isPotentiallyCatastrophicPattern('(a{1,10}){1,10}$')).toBe(true)
  })

  it('does not flag a quantified group with no inner quantifier or alternation', () => {
    expect(isPotentiallyCatastrophicPattern('(abc)+')).toBe(false)
    expect(isPotentiallyCatastrophicPattern('session-[a-f0-9]{8}')).toBe(false)
  })

  it('rejects the overlapping-alternation shape end to end via defer(), same as the nested case', () => {
    const req: AnthropicRequestLike = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: [{ type: 'text', text: 'a'.repeat(28) + '!' }],
    }
    const cfg = {
      deferral: {
        enabled: true,
        dryRun: true,
        extractors: [{ id: 'evil-alt', path: 'system[*].text', pattern: '^(a|a)+$' }],
      },
    }

    const started = Date.now()
    defer(req, cfg)
    const elapsedMs = Date.now() - started

    expect(elapsedMs).toBeLessThan(500)
  }, 2000)
})

// --- Finding 6: CLI crashes uncaught on common operator mistakes ---
describe('CLI operator-error hardening regression (audit finding MEDIUM-6)', () => {
  it('returns a clean error exit code for an unknown flag instead of throwing uncaught', () => {
    const stderrLines: string[] = []
    const io = { stdout: () => undefined, stderr: (t: string) => stderrLines.push(t) }
    expect(() => run(['--nonexistent-flag'], io)).not.toThrow()
    const exitCode = run(['--nonexistent-flag'], io)
    expect(exitCode).toBeGreaterThan(0)
  })

  it('returns a clean error exit code for an invalid --port instead of calling listen(NaN)', () => {
    const stderrLines: string[] = []
    const io = { stdout: () => undefined, stderr: (t: string) => stderrLines.push(t) }
    const exitCode = run(['--upstream', 'https://api.anthropic.com', '--port', 'not-a-number'], io)
    expect(exitCode).toBeGreaterThan(0)
  })

  it('returns a clean error exit code for a malformed --upstream URL instead of deferring to a request-time 502', () => {
    const stderrLines: string[] = []
    const io = { stdout: () => undefined, stderr: (t: string) => stderrLines.push(t) }
    // Explicit high port: an unvalidated --upstream currently falls through all
    // the way to server.listen() on whatever port is in effect, and this repo's
    // own dev environment routinely has something real bound to the default
    // port (8788) — using a dedicated port here keeps this test deterministic
    // regardless of what else is running on the machine.
    const exitCode = run(['--upstream', 'not a valid url', '--port', '48211'], io)
    expect(exitCode).toBeGreaterThan(0)
  })
})

// --- Finding 7: upstream responses always fully buffered, no timeout, no abort-cancellation ---
describe('upstream buffering/timeout hardening regression (audit finding MEDIUM-7)', () => {
  it('destroys the upstream request when the client aborts mid-response', async () => {
    let upstreamRequestDestroyed = false
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"partial":')
      res.socket?.on('close', () => {
        upstreamRequestDestroyed = true
      })
      // never finish the response — simulates a slow/hung upstream
    })
    const server = createProxyServer({ upstream: upstream.url, config: { barrier: { enabled: false } } })
    servers.push(server)
    const port = await listen(server)

    const controller = new AbortController()
    const reqPromise = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
      signal: controller.signal,
    }).catch(() => undefined)

    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await reqPromise
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(upstreamRequestDestroyed).toBe(true)
  })
})

// --- Finding 8: /stats claimed to leak prior request prefix bytes, but the
// standalone proxy never wires divergence tracking, so the claim was stale ---
describe('/stats content regression (audit finding LOW-8)', () => {
  it('never includes prior request prefix content, since the standalone proxy does not populate divergence tracking', async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })
    const server = createProxyServer({ upstream: upstream.url, config: { barrier: { enabled: false } } })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'sensitive prior prefix content' }] }],
      }),
    })

    const statsRes = await fetch(`http://127.0.0.1:${port}/stats`)
    const stats = (await statsRes.json()) as { divergences: unknown[] }

    expect(stats.divergences).toEqual([])
  })
})

// --- Finding 9: barrier keyed on prefix hash alone, not tenant-aware ---
describe('barrier tenant-isolation regression (audit finding LOW-9)', () => {
  it('does not make a second caller a follower of a different caller with an identical prefix hash', async () => {
    let requestsInFlight = 0
    let releaseUpstream: (() => void) | undefined
    const bothArrived = new Promise<void>((resolve) => {
      releaseUpstream = () => resolve()
    })
    const upstream = await startFakeUpstream((_req, res) => {
      requestsInFlight += 1
      if (requestsInFlight === 2) releaseUpstream?.()
      void bothArrived.then(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
      })
    })

    const dir = mkdtempSync(join(tmpdir(), 'cache-assembler-audit-'))
    const traceLogPath = join(dir, 'trace.jsonl')
    const server = createProxyServer({
      upstream: upstream.url,
      config: { barrier: { enabled: true } },
      traceLogPath,
    })
    servers.push(server)
    const port = await listen(server)

    const body = JSON.stringify({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'identical prefix, different caller' }] }],
    })

    await Promise.all([
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer caller-a' },
        body,
      }),
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer caller-b' },
        body,
      }),
    ])

    const lines = readFileSync(traceLogPath, 'utf8').trim().split('\n')
    const roles = lines.map((line) => (JSON.parse(line) as { barrierRole?: string }).barrierRole)

    expect(roles.sort()).toEqual(['leader', 'leader'])

    rmSync(dir, { recursive: true, force: true })
  })
})
