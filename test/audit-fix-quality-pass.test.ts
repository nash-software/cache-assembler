// Regression tests for the 9 remaining pre-launch review findings (quality
// pass). Each describe block below corresponds to one plan step; see
// scratchpads/fix-remaining-prelaunch-findings-plan.md for the full context.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProxyServer } from '../src/server.js'

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

// --- Item 2: trace-log header capture must be allowlist-based, not
// blocklist-based. A credential-shaped header the old blocklist never
// anticipated (x-custom-api-key) must never appear verbatim in the log.
describe('trace-log header capture is allowlist-based (item 2)', () => {
  it('never writes an unrecognised credential-shaped header verbatim to the trace log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-assembler-quality-'))
    const traceLogPath = join(dir, 'trace.jsonl')
    const secret = 'super-secret-value-should-never-appear'
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })
    const server = createProxyServer({ upstream: upstream.url, config: { barrier: { enabled: false } }, traceLogPath })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom-api-key': secret },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    })

    const traceContents = readFileSync(traceLogPath, 'utf8')
    expect(traceContents).not.toContain(secret)

    rmSync(dir, { recursive: true, force: true })
  })

  it('still logs an allowlisted header (content-type) verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-assembler-quality-'))
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    })

    const line = readFileSync(traceLogPath, 'utf8').trim().split('\n')[0]!
    const entry = JSON.parse(line) as { headers: Record<string, string> }
    expect(entry.headers['content-type']).toBe('application/json')

    rmSync(dir, { recursive: true, force: true })
  })
})

// --- Item 3: forwardToUpstream must preserve a path segment already present
// in the configured --upstream URL (e.g. a gateway mounted at /base).
describe('forwardToUpstream preserves a configured upstream path segment (item 3)', () => {
  it('joins the configured upstream path with the proxied path instead of replacing it', async () => {
    let receivedPath: string | undefined
    const upstream = await startFakeUpstream((req, res) => {
      receivedPath = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })

    const server = createProxyServer({ upstream: `${upstream.url}/base`, config: { barrier: { enabled: false } } })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    })

    expect(receivedPath).toBe('/base/v1/messages')
  })

  it('still targets /v1/messages unchanged when --upstream has no path segment (no regression)', async () => {
    let receivedPath: string | undefined
    const upstream = await startFakeUpstream((req, res) => {
      receivedPath = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })

    const server = createProxyServer({ upstream: upstream.url, config: { barrier: { enabled: false } } })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    })

    expect(receivedPath).toBe('/v1/messages')
  })

  it('preserves the query string carried in the proxied path alongside the configured path segment', async () => {
    let receivedPath: string | undefined
    const upstream = await startFakeUpstream((req, res) => {
      receivedPath = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })

    const server = createProxyServer({ upstream: `${upstream.url}/base`, config: { barrier: { enabled: false } } })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    })

    expect(receivedPath).toBe('/base/v1/messages?beta=true')
  })
})
