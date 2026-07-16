import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, Server, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { createProxyServer } from '../src/server.js'
import { run } from '../src/cli.js'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected AddressInfo')
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    req.on('end', () => resolve(text))
  })
}

describe('createProxyServer (standalone HTTP proxy)', () => {
  let stubUpstream: Server | undefined
  let proxy: Server | undefined

  afterEach(async () => {
    if (proxy) await close(proxy)
    if (stubUpstream) await close(stubUpstream)
    proxy = undefined
    stubUpstream = undefined
  })

  it('forwards an assembled (rewritten) request to the stub upstream and relays its response', async () => {
    let receivedBody = ''
    stubUpstream = createServer((req, res) => {
      void readBody(req).then((text) => {
        receivedBody = text
        const body = JSON.stringify({ id: 'msg_1', usage: { input_tokens: 10, cache_creation_input_tokens: 100 } })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
      })
    })
    const upstreamPort = await listen(stubUpstream)

    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` })
    const proxyPort = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-test',
        tools: [{ name: 't1', input_schema: {} }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    })

    expect(response.status).toBe(200)
    const json = (await response.json()) as { id: string }
    expect(json.id).toBe('msg_1')

    // The client sent no cache_control — a rewritten (assembled) body must
    // have breakpoints placed before it reaches the upstream.
    const forwarded = JSON.parse(receivedBody) as { tools: Array<{ cache_control?: unknown }> }
    expect(forwarded.tools[0]?.cache_control).toBeDefined()

    const statsResponse = await fetch(`http://127.0.0.1:${proxyPort}/stats`)
    expect(statsResponse.status).toBe(200)
    const stats = (await statsResponse.json()) as { requests: number; cacheWrites: number }
    expect(stats.requests).toBe(1)
    expect(stats.cacheWrites).toBe(1)
  })

  it('serves GET /health with 200 {ok:true}', async () => {
    stubUpstream = createServer((_req, res) => res.end())
    const upstreamPort = await listen(stubUpstream)
    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` })
    const proxyPort = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('serves GET /stats as JSON with zero recorded requests', async () => {
    stubUpstream = createServer((_req, res) => res.end())
    const upstreamPort = await listen(stubUpstream)
    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` })
    const proxyPort = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/stats`)
    expect(response.status).toBe(200)
    const stats = (await response.json()) as { requests: number }
    expect(stats.requests).toBe(0)
  })

  it('fails open: forwards the raw body unchanged when it is not valid JSON', async () => {
    let receivedBody = ''
    stubUpstream = createServer((req, res) => {
      void readBody(req).then((text) => {
        receivedBody = text
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ usage: { input_tokens: 1 } }))
      })
    })
    const upstreamPort = await listen(stubUpstream)
    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` })
    const proxyPort = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      body: 'not json',
    })

    expect(response.status).toBe(200)
    expect(receivedBody).toBe('not json')
  })

  it('rejects an oversized request body with 413 without buffering past the configured cap', async () => {
    stubUpstream = createServer((_req, res) => res.end())
    const upstreamPort = await listen(stubUpstream)
    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, maxBodyBytes: 16 })
    const proxyPort = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'this body is well over sixteen bytes' }] }),
    })

    expect(response.status).toBe(413)
  })

  it('accepts a request body at or under the configured cap', async () => {
    stubUpstream = createServer((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ usage: { input_tokens: 1 } }))
      })
    })
    const upstreamPort = await listen(stubUpstream)
    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}`, maxBodyBytes: 1024 })
    const proxyPort = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'small' }] }),
    })

    expect(response.status).toBe(200)
  })

  it('does not raise an unhandled rejection when the client aborts the request body mid-stream', async () => {
    stubUpstream = createServer((_req, res) => res.end())
    const upstreamPort = await listen(stubUpstream)
    proxy = createProxyServer({ upstream: `http://127.0.0.1:${upstreamPort}` })
    const proxyPort = await listen(proxy)

    let unhandled: unknown
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled = reason
    }
    process.on('unhandledRejection', onUnhandledRejection)

    await new Promise<void>((resolve) => {
      const socket = connect(proxyPort, '127.0.0.1', () => {
        // Announce a body larger than what we actually send, then destroy
        // the connection before the server finishes reading it.
        const requestLines = ['POST /v1/messages HTTP/1.1', 'Host: 127.0.0.1', 'Content-Length: 1000', '', '{"partial']
        socket.write(requestLines.join(String.fromCharCode(13, 10)))
        setTimeout(() => {
          socket.destroy()
          resolve()
        }, 50)
      })
      socket.on('error', () => resolve())
    })

    // Give the server's rejected promise a tick to surface (or not).
    await new Promise((resolve) => setTimeout(resolve, 50))
    process.removeListener('unhandledRejection', onUnhandledRejection)
    expect(unhandled).toBeUndefined()

    const health = await fetch(`http://127.0.0.1:${proxyPort}/health`)
    expect(health.status).toBe(200)
  })
})

describe('cli run()', () => {
  it('--help returns exit code 0 and prints usage without starting a server', () => {
    const lines: string[] = []
    const exitCode = run(['--help'], { stdout: (t) => lines.push(t), stderr: () => {} })
    expect(exitCode).toBe(0)
    expect(lines.join('')).toContain('cache-assembler')
  })

  it('returns exit code 1 when --upstream is missing', () => {
    const lines: string[] = []
    const exitCode = run([], { stdout: () => {}, stderr: (t) => lines.push(t) })
    expect(exitCode).toBe(1)
    expect(lines.join('')).toContain('--upstream is required')
  })

  it('--version returns exit code 0 and prints the package name and semver without starting a server', () => {
    const lines: string[] = []
    const exitCode = run(['--version'], { stdout: (t) => lines.push(t), stderr: () => {} })
    expect(exitCode).toBe(0)
    expect(lines.join('')).toMatch(/^cache-assembler \d+\.\d+\.\d+\s*$/)
  })

  it('binds to 127.0.0.1 by default (not all interfaces) unless --host is passed', () => {
    const listenSpy = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
      return this
    })

    run(['--upstream', 'http://127.0.0.1:9999', '--port', '8000'], { stdout: () => {}, stderr: () => {} })

    expect(listenSpy).toHaveBeenCalledWith(8000, '127.0.0.1', expect.any(Function))
    listenSpy.mockRestore()
  })

  it('binds to an explicit --host when passed (opt-in network exposure)', () => {
    const listenSpy = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
      return this
    })

    run(['--upstream', 'http://127.0.0.1:9999', '--port', '8000', '--host', '0.0.0.0'], { stdout: () => {}, stderr: () => {} })

    expect(listenSpy).toHaveBeenCalledWith(8000, '0.0.0.0', expect.any(Function))
    listenSpy.mockRestore()
  })
})
