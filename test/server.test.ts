import { gzipSync } from 'node:zlib'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProxyServer } from '../src/server.js'
import { TelemetryStore } from '../src/telemetry.js'

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

async function startFakeUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; url: string }> {
  const server = createServer(handler)
  servers.push(server)
  const port = await listen(server)
  return { port, url: `http://127.0.0.1:${port}` }
}

async function startProxy(upstream: string, telemetry: TelemetryStore): Promise<{ port: number; url: string }> {
  const server = createProxyServer({ upstream, telemetry, config: { barrier: { enabled: false } } })
  servers.push(server)
  const port = await listen(server)
  return { port, url: `http://127.0.0.1:${port}` }
}

const MINIMAL_REQUEST = JSON.stringify({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})

describe('createProxyServer accept-encoding handling', () => {
  it('always forwards accept-encoding: identity to upstream, regardless of what the client sent', async () => {
    let receivedAcceptEncoding: string | undefined
    const upstream = await startFakeUpstream((req, res) => {
      receivedAcceptEncoding = req.headers['accept-encoding'] as string | undefined
      const body = JSON.stringify({ usage: { input_tokens: 10 } })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
    const proxy = await startProxy(upstream.url, new TelemetryStore())

    await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
      body: MINIMAL_REQUEST,
    })

    expect(receivedAcceptEncoding).toBe('identity')
  })

  it('records telemetry correctly even though the fake upstream WOULD gzip a real response if permitted', async () => {
    // Proves the fix: if the client's gzip request were forwarded as-is (the
    // pre-fix behavior), this upstream would compress its response and
    // extractUsage would silently fail to find `usage` in the garbled bytes,
    // leaving telemetry.stats().requests at 0 despite a successful exchange.
    const upstream = await startFakeUpstream((req, res) => {
      const acceptEncoding = req.headers['accept-encoding'] as string | undefined
      const payload = JSON.stringify({
        usage: { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
      })
      if (acceptEncoding?.includes('gzip')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        res.end(gzipSync(Buffer.from(payload, 'utf8')))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(payload)
      }
    })
    const telemetry = new TelemetryStore()
    const proxy = await startProxy(upstream.url, telemetry)

    await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
      body: MINIMAL_REQUEST,
    })

    const stats = telemetry.stats()
    expect(stats.requests).toBe(1)
    expect(stats.cacheWrites).toBe(1)
  })
})

describe('createProxyServer request tracing', () => {
  it('writes no trace file at all when traceLogPath is omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-assembler-trace-'))
    const traceLogPath = join(dir, 'trace.jsonl')
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
      body: MINIMAL_REQUEST,
    })

    expect(() => readFileSync(traceLogPath)).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes one well-formed, redacted JSON line per request when traceLogPath is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-assembler-trace-'))
    const traceLogPath = join(dir, 'trace.jsonl')
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          usage: { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
        }),
      )
    })
    const server = createProxyServer({
      upstream: upstream.url,
      config: { barrier: { enabled: false } },
      traceLogPath,
    })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer super-secret-token',
        'x-api-key': 'also-secret',
        'user-agent': 'claude-cli/1.0',
      },
      body: MINIMAL_REQUEST,
    })

    const lines = readFileSync(traceLogPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]!)

    expect(entry.pathname).toBe('/v1/messages')
    expect(typeof entry.requestId).toBe('string')
    expect(typeof entry.latencyMs).toBe('number')
    expect(entry.upstreamStatus).toBe(200)
    expect(entry.headers.authorization).toBe('[not logged]')
    expect(entry.headers['x-api-key']).toBe('[not logged]')
    expect(entry.headers['user-agent']).toBe('claude-cli/1.0')
    expect(entry.usage.cache_creation_input_tokens).toBe(100)
    expect(entry.economics.netSavedUsd).toBeCloseTo(-0.0003, 6) // 100 tokens * ($3 base - $6 write) / 1e6

    rmSync(dir, { recursive: true, force: true })
  })
})
