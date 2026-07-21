import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { appendFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import type { AnthropicRequestLike, AssembleReport, Usage } from './types.js'
import { resolveConfig, type CacheAssemblerConfig } from './config.js'
import { assemble } from './assemble.js'
import { WriteBarrier, type WriteBarrierRole } from './barrier.js'
import { TelemetryStore, computeRequestEconomics, type RequestEconomics } from './telemetry.js'

export interface ProxyServerOptions {
  upstream: string
  config?: CacheAssemblerConfig
  barrier?: WriteBarrier
  telemetry?: TelemetryStore
  /** Max request body size in bytes before a 413 is returned. Default 10MB. */
  maxBodyBytes?: number
  /**
   * Path to append one JSON line per proxied request to, for line-by-line
   * analysis of concurrent-session cache economics. Opt-in — omit to skip
   * tracing entirely with zero behavior change.
   */
  traceLogPath?: string
  /** Max time to wait on the upstream request/response before aborting. Default 120s. */
  upstreamTimeoutMs?: number
}

const MESSAGES_PATH = '/v1/messages'
const HOP_PATH_PREFIX = '/hop/'
const HEALTH_PATH = '/health'
const STATS_PATH = '/stats'
const LOG_PREFIX = '[cache-assembler]'
const EXCLUDED_FORWARD_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding'])
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000

function isProxiedPath(pathname: string): boolean {
  return pathname === MESSAGES_PATH || pathname.startsWith(HOP_PATH_PREFIX)
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

class PayloadTooLargeError extends Error {}

/**
 * Reads the request body, rejecting with PayloadTooLargeError once the
 * accumulated byte count exceeds maxBodyBytes. Checked against actual bytes
 * received (not the client-supplied Content-Length header), so it holds even
 * against a missing or lying header.
 */
async function readRequestBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > maxBodyBytes) throw new PayloadTooLargeError(`request body exceeds ${maxBodyBytes} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function isUsage(value: unknown): value is Usage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { input_tokens?: unknown }).input_tokens === 'number'
  )
}

/**
 * Parses usage from a plain JSON response body, or defensively from an SSE
 * stream by scanning `data:` lines for the first payload carrying a `usage`
 * field (the `message_start` event). Returns undefined rather than throwing
 * on anything unexpected — usage is telemetry, never a required field.
 */
function extractUsage(responseText: string): Usage | undefined {
  const trimmed = responseText.trim()
  if (trimmed.length === 0) return undefined

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { usage?: unknown }
      return isUsage(parsed.usage) ? parsed.usage : undefined
    } catch {
      return undefined
    }
  }

  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload.includes('"usage"')) continue
    try {
      const parsed = JSON.parse(payload) as { message?: { usage?: unknown }; usage?: unknown }
      const usage = parsed.message?.usage ?? parsed.usage
      if (isUsage(usage)) return usage
    } catch {
      continue
    }
  }
  return undefined
}

interface UpstreamResponse {
  statusCode: number
  headers: IncomingHttpHeaders
  body: IncomingMessage
}

const ALLOWED_TRACE_HEADER_KEYS = new Set(['content-type', 'anthropic-version', 'anthropic-beta', 'user-agent', 'accept'])

/**
 * Allowlist-based, not blocklist-based: a blocklist can only redact headers
 * whose sensitivity was anticipated in advance, so any credential-shaped
 * header a client happens to use (e.g. a custom API key header) would leak
 * verbatim into the trace log. Only headers known to be safe to log are
 * emitted as-is; every other header — including ones this project has never
 * seen — is replaced with a fixed marker rather than its raw value.
 */
function safeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lowerKey = key.toLowerCase()
    out[key] = ALLOWED_TRACE_HEADER_KEYS.has(lowerKey)
      ? Array.isArray(value)
        ? value.join(', ')
        : value
      : '[not logged]'
  }
  return out
}

/**
 * Fingerprints the calling tenant from its auth header so the write barrier
 * (below) doesn't fan out a follower to wait on a leader it can never
 * observe the cache write of. Hashed rather than stored raw: the barrier key
 * only needs to distinguish callers, never needs to recover the credential.
 */
function callerFingerprint(headers: IncomingHttpHeaders): string {
  const credential = headers['authorization'] ?? headers['x-api-key'] ?? ''
  const raw = Array.isArray(credential) ? credential.join(',') : credential
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

interface TraceEntry {
  ts: string
  requestId: string
  pathname: string
  remotePort?: number
  headers: Record<string, string>
  prefixHash?: string
  barrierRole?: WriteBarrierRole
  assemble?: {
    canonicalizeApplied: boolean
    breakpointsPlaced: number
    deferralMode: AssembleReport['features']['deferral']['mode']
    deferredCount: number
  }
  assembleError?: string
  usage?: Usage
  economics?: RequestEconomics
  latencyMs: number
  upstreamStatus?: number
  error?: string
}

function writeTrace(path: string, entry: TraceEntry): void {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    console.error(`${LOG_PREFIX} trace log write failed`, err)
  }
}

/**
 * Never forwards the client's own accept-encoding — forces 'identity' so the
 * upstream response body is always plain text. Without this, a real
 * upstream (which will happily gzip/br-compress a streamed response when a
 * client permits it) produces bytes that extractUsage cannot parse, and
 * telemetry silently never records a single request.
 */
function buildForwardHeaders(original: IncomingHttpHeaders, payloadLength: number): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined || EXCLUDED_FORWARD_HEADERS.has(key.toLowerCase())) continue
    headers[key] = value
  }
  headers['content-type'] = headers['content-type'] ?? 'application/json'
  headers['content-length'] = payloadLength
  headers['accept-encoding'] = 'identity'
  return headers
}

function forwardToUpstream(
  upstream: string,
  forwardPath: string,
  originalHeaders: IncomingHttpHeaders,
  body: string,
  signal: AbortSignal,
): Promise<UpstreamResponse> {
  // `new URL(forwardPath, upstream)` would treat `upstream` as an origin and
  // silently drop any path segment already configured on it (e.g. a gateway
  // mounted at /base). Join the configured path with the proxied path instead
  // of replacing it; forwardPath already carries the query string.
  const base = new URL(upstream)
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '')
  const target = new URL(basePath + forwardPath, base.origin)
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest
  const payload = Buffer.from(body, 'utf8')

  return new Promise((resolve, reject) => {
    const outgoing = requestFn(
      target,
      { method: 'POST', headers: buildForwardHeaders(originalHeaders, payload.length), signal },
      (upstreamRes) => {
        resolve({ statusCode: upstreamRes.statusCode ?? 502, headers: upstreamRes.headers, body: upstreamRes })
      },
    )
    outgoing.on('error', reject)
    outgoing.end(payload)
  })
}

/**
 * Standalone HTTP proxy: rewrites `/v1/messages` and `/hop/*` request bodies
 * via `assemble()`, coordinates concurrent identical-prefix requests through
 * a `WriteBarrier`, and records cache economics via a `TelemetryStore`.
 * Every failure mode is fail-open — an assemble/barrier error logs and falls
 * back to forwarding the original, unmodified request.
 */
export function createProxyServer(opts: ProxyServerOptions): Server {
  const cfg = resolveConfig(opts.config ?? {})
  const barrier = opts.barrier ?? new WriteBarrier({ holdTimeoutMs: cfg.barrier.holdTimeoutMs })
  const telemetry = opts.telemetry ?? new TelemetryStore()
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  async function handleProxiedRequest(req: IncomingMessage, res: ServerResponse, pathname: string, forwardPath: string): Promise<void> {
    const startedAt = Date.now()

    // Bounds the upstream call two ways: a hard timeout (a hung upstream must
    // not hang the client forever), and client-abort cancellation (if the
    // client goes away mid-request, the upstream request is destroyed rather
    // than continuing to be paid for and buffered to completion).
    //
    // res's 'close' (not req's) is the correct signal here, checked against
    // writableEnded: req.on('close', ...) fires as soon as the REQUEST BODY
    // finishes being read — which happens almost immediately for a normal
    // request, long before we're anywhere near done — so it produced a false
    // "client disconnected" on every single request. res only closes once
    // the underlying connection closes; writableEnded tells us whether that
    // happened because we legitimately finished (true) or because the client
    // actually went away first (false).
    const upstreamAbort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) upstreamAbort.abort()
    })
    // Bounds time-to-first-byte only, not the whole response stream: a real
    // Claude generation can legitimately stream for minutes, and the earlier
    // version of this timeout (AbortSignal.timeout composed into the request
    // signal for its whole lifetime) killed those mid-stream. Cleared as soon
    // as headers arrive, below; client-abort (upstreamAbort, above) remains
    // the only thing bounding the body-streaming phase after that.
    const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
    const headersTimeout = setTimeout(() => upstreamAbort.abort(), upstreamTimeoutMs)
    const upstreamSignal = upstreamAbort.signal

    const trace: TraceEntry | undefined =
      opts.traceLogPath === undefined
        ? undefined
        : {
            ts: new Date(startedAt).toISOString(),
            requestId: randomUUID(),
            pathname,
            remotePort: req.socket.remotePort,
            headers: safeHeaders(req.headers),
            latencyMs: 0,
          }
    const emitTrace = (): void => {
      if (trace === undefined || opts.traceLogPath === undefined) return
      trace.latencyMs = Date.now() - startedAt
      writeTrace(opts.traceLogPath, trace)
    }

    let rawBody: string
    try {
      rawBody = await readRequestBody(req, maxBodyBytes)
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        if (trace !== undefined) trace.error = 'payload too large'
        emitTrace()
        sendJson(res, 413, { error: 'payload too large' })
        return
      }
      throw err
    }
    let outgoingBody = rawBody
    let prefixHash: string | undefined
    let canonicalPrefix: string | undefined
    let chainPosition: number | undefined

    try {
      const originalReq = JSON.parse(rawBody) as AnthropicRequestLike
      const result = assemble(originalReq, opts.config ?? {})
      outgoingBody = JSON.stringify(result.req)
      prefixHash = result.report.prefixHash
      canonicalPrefix = result.report.canonicalPrefix
      // The integer message count, derived from data already in the
      // request — never a new client header. Two unrelated conversations
      // with the same message count share a slot (accepted per the plan's
      // Open Questions; divergence detection still works, attribution can
      // just be a false positive in that narrow case).
      chainPosition = originalReq.messages.length
      if (trace !== undefined) {
        trace.prefixHash = prefixHash
        trace.assemble = {
          canonicalizeApplied: result.report.features.canonicalize.applied,
          breakpointsPlaced: result.report.features.breakpoints.placed.length,
          deferralMode: result.report.features.deferral.mode,
          deferredCount: result.report.features.deferral.moved.length,
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} assemble failed, forwarding original request`, err)
      if (trace !== undefined) trace.assembleError = err instanceof Error ? err.message : String(err)
    }

    // Tenant-scoped: two different callers hashing to the same prefix must
    // not fan out as leader/follower of each other — a follower can never
    // observe a cache write made under a leader's own credential.
    const barrierKey = prefixHash === undefined ? undefined : `${prefixHash}:${callerFingerprint(req.headers)}`

    let role: WriteBarrierRole = 'leader'
    if (cfg.barrier.enabled && barrierKey !== undefined) {
      try {
        role = (await barrier.enter(barrierKey)).role
      } catch (err) {
        console.error(`${LOG_PREFIX} barrier enter failed, proceeding without coordination`, err)
      }
    }
    if (trace !== undefined) trace.barrierRole = cfg.barrier.enabled ? role : undefined

    const needsUsageBuffer = cfg.telemetry.enabled && prefixHash !== undefined

    try {
      const upstreamRes = await forwardToUpstream(opts.upstream, forwardPath, req.headers, outgoingBody, upstreamSignal)
      clearTimeout(headersTimeout)
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
      if (trace !== undefined) trace.upstreamStatus = upstreamRes.statusCode
      // A non-2xx upstream response (e.g. 429) is a normal HTTP response, not
      // a thrown error, so the catch block below never sees it. Only a 2xx
      // means the cache write the leader triggered actually happened —
      // warming the barrier for anything else would tell the next
      // identical-prefix caller to wait as a follower on a write that never
      // landed.
      const isSuccessStatus = upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300

      const chunks: Buffer[] = []
      let firstByteSignaled = false
      for await (const chunk of upstreamRes.body as AsyncIterable<Buffer>) {
        if (!firstByteSignaled && role === 'leader' && cfg.barrier.enabled && barrierKey !== undefined && isSuccessStatus) {
          barrier.firstByte(barrierKey)
          firstByteSignaled = true
        }
        // Only accumulate the full body when something will actually read it
        // back (usage extraction for telemetry) — otherwise every proxied
        // response was fully buffered in memory for no reason, even with
        // telemetry disabled.
        if (needsUsageBuffer) chunks.push(chunk)
        res.write(chunk)
      }
      res.end()

      if (!firstByteSignaled && role === 'leader' && cfg.barrier.enabled && barrierKey !== undefined) {
        if (isSuccessStatus) {
          barrier.firstByte(barrierKey)
        } else {
          // Leader's response was non-2xx: clear the pending entry so the
          // next identical-prefix caller enters fresh as a leader instead of
          // waiting as a follower on a write that never happened. Safe even
          // if this hash was already warmed by a prior successful request —
          // fail() no-ops on a warm entry (item 5).
          barrier.fail(barrierKey)
        }
      }

      if (needsUsageBuffer && prefixHash !== undefined) {
        const usage = extractUsage(Buffer.concat(chunks).toString('utf8'))
        if (usage !== undefined) {
          telemetry.record({ prefixHash, usage, canonicalPrefix, chainPosition })
          if (trace !== undefined) {
            trace.usage = usage
            trace.economics = computeRequestEconomics(usage, telemetry.pricing())
          }
        }
      }
      emitTrace()
    } catch (err) {
      clearTimeout(headersTimeout)
      if (cfg.barrier.enabled && barrierKey !== undefined) barrier.fail(barrierKey)
      console.error(`${LOG_PREFIX} upstream request failed`, err)
      if (trace !== undefined) trace.error = err instanceof Error ? err.message : String(err)
      emitTrace()
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream request failed' })
      else res.end()
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && url.pathname === STATS_PATH) {
      sendJson(res, 200, telemetry.stats())
      return
    }
    if (req.method === 'POST' && isProxiedPath(url.pathname)) {
      // handleProxiedRequest's own try/catch only starts after readRequestBody
      // resolves; a client abort mid-body rejects before that point, so this
      // outer .catch is the only thing standing between that and an
      // unhandled rejection crashing a long-running proxy process.
      handleProxiedRequest(req, res, url.pathname, url.pathname + url.search).catch((err: unknown) => {
        console.error(`${LOG_PREFIX} request handling failed`, err)
        if (!res.headersSent) sendJson(res, 502, { error: 'request failed' })
        else res.end()
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })
}
