import { gzipSync } from 'node:zlib'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
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
