// Regression test for production-audit finding HIGH-3: the standalone proxy
// must forward the client's query string upstream. src/server.ts parses
// `url.search` but only ever threads `url.pathname` through to
// forwardToUpstream — a real client sending POST /v1/messages?beta=true has
// that query parameter silently stripped before it reaches the real API.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
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

const MINIMAL_REQUEST = JSON.stringify({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})

describe('proxy query-string forwarding regression (audit finding HIGH-3)', () => {
  it('forwards the original request query string to the upstream unchanged', async () => {
    let receivedUrl: string | undefined
    const upstream = await startFakeUpstream((req, res) => {
      receivedUrl = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
    })
    const server = createProxyServer({ upstream: upstream.url, config: { barrier: { enabled: false } } })
    servers.push(server)
    const port = await listen(server)

    await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true&foo=bar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: MINIMAL_REQUEST,
    })

    expect(receivedUrl).toBe('/v1/messages?beta=true&foo=bar')
  })

  it('forwards a request with no query string as a bare path (no trailing "?")', async () => {
    let receivedUrl: string | undefined
    const upstream = await startFakeUpstream((req, res) => {
      receivedUrl = req.url
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

    expect(receivedUrl).toBe('/v1/messages')
  })
})
