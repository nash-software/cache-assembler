import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, MessageParam, SystemBlock, ToolDefinition, Usage } from '../../../src/types.js'

const TOKEN_BYTE_RATIO = 4
const DEFAULT_RESPONSE_DELAY_MS = 0
const STUB_MESSAGE_ID_PREFIX = 'stub-msg-'

export interface Segment {
  hash: string
  length: number
}

interface ParsedBody {
  tools: ToolDefinition[]
  system: SystemBlock[]
  messages: MessageParam[]
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function tokensFromBytes(byteLength: number): number {
  return Math.ceil(byteLength / TOKEN_BYTE_RATIO)
}

function parseBody(rawBody: string): ParsedBody {
  const parsed = JSON.parse(rawBody) as {
    tools?: ToolDefinition[]
    system?: SystemBlock[] | string
    messages?: MessageParam[]
  }
  return {
    tools: parsed.tools ?? [],
    system: Array.isArray(parsed.system) ? parsed.system : [],
    messages: parsed.messages ?? [],
  }
}

function messageHasCacheControl(message: MessageParam | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false
  return (message.content as ContentBlock[]).some((block) => block.cache_control !== undefined)
}

/**
 * Strips `cache_control` from a message's content blocks before it feeds the
 * rolling hash. `cache_control` is wire-level metadata telling the API where
 * to place a boundary — it isn't part of the tokenized content itself, and
 * the placement policy moves it to a new message every turn (the previous
 * turn's breakpoint message loses the marker). Without stripping it, the
 * SAME message text would hash differently depending on whether it happened
 * to be carrying the breakpoint that particular turn, breaking prefix
 * matching for no content-level reason.
 */
function stripMessageCacheControl(message: MessageParam): MessageParam {
  if (!Array.isArray(message.content)) return message
  return {
    ...message,
    content: (message.content as ContentBlock[]).map(({ cache_control: _cacheControl, ...rest }) => rest),
  }
}

/** Index of the first message carrying a `cache_control` breakpoint, if any. */
function messageBreakpointIndex(messages: MessageParam[]): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    if (messageHasCacheControl(messages[i])) return i
  }
  return undefined
}

/**
 * Collects one segment per existing `cache_control` breakpoint, in prefix
 * order (tools ascending, then system ascending, then messages ascending) —
 * mirroring real Anthropic cache semantics where only `cache_control`-marked
 * boundaries are ever cacheable. Tool and system segments are hashed as
 * closed JSON blobs (correct there: neither grows across turns, so exact
 * equality is the right test). The message boundary is different: it grows
 * every turn, and a closed-JSON hash of `{tools, system, messages: slice}`
 * can never match an earlier, shorter slice — the closing brackets land at
 * different positions for different array lengths, so no two different-
 * length slices can ever be byte-prefixes of one another that way. Instead,
 * the message boundary is hashed as a rolling chain over FLAT STRING
 * CONCATENATION (`rollingText += JSON.stringify(messages[i])`), which *is*
 * genuinely prefix-stable — one segment is pushed per message index up to
 * the breakpoint, so an earlier turn's shorter committed chain is
 * discoverable as a real prefix of a later turn's longer one. This is what
 * lets a growing conversation get incremental cache credit (only the new
 * tail billed as `cache_creation_input_tokens`) instead of re-paying the
 * write premium on the entire prefix every turn.
 */
export function collectSegments(rawBody: string): Segment[] {
  const { tools, system, messages } = parseBody(rawBody)
  const segments: Segment[] = []

  for (let i = 0; i < tools.length; i++) {
    if (tools[i]?.cache_control === undefined) continue
    const text = JSON.stringify({ tools: tools.slice(0, i + 1) })
    segments.push({ hash: sha256Hex(text), length: text.length })
  }

  for (let i = 0; i < system.length; i++) {
    if (system[i]?.cache_control === undefined) continue
    const text = JSON.stringify({ tools, system: system.slice(0, i + 1) })
    segments.push({ hash: sha256Hex(text), length: text.length })
  }

  const breakpointIndex = messageBreakpointIndex(messages)
  if (breakpointIndex !== undefined) {
    let rollingText = JSON.stringify({ tools, system })
    for (let i = 0; i <= breakpointIndex; i++) {
      rollingText += JSON.stringify(stripMessageCacheControl(messages[i]!))
      segments.push({ hash: sha256Hex(rollingText), length: rollingText.length })
    }
  }

  return segments
}

/**
 * Pure stub cache simulation: a "cache hit" is a genuine function of whether
 * the request's breakpoint-anchored prefix bytes have stabilized turn to
 * turn (i.e. some earlier committed segment hash matches), never a canned
 * number. Searches from the longest segment down for the first hash present
 * in `seen`; that segment's length yields `cache_read_input_tokens`, and the
 * byte delta up to the request's final (longest) breakpoint segment yields
 * `cache_creation_input_tokens`. A body with no breakpoints at all reports
 * `input_tokens` only. When `commit` is true, every segment hash computed
 * for this body is added to `seen` (see createStubUpstream's delayed-commit
 * ordering for why lookup and commit are split into two separate calls).
 */
export function simulateUsage(rawBody: string, seen: Set<string>, commit: boolean): Usage {
  const segments = collectSegments(rawBody)
  const bodyLength = rawBody.length

  let usage: Usage
  if (segments.length === 0) {
    usage = { input_tokens: tokensFromBytes(bodyLength) }
  } else {
    const lastSegment = segments[segments.length - 1]!
    let readSegment: Segment | undefined
    for (let i = segments.length - 1; i >= 0; i--) {
      const candidate = segments[i]!
      if (seen.has(candidate.hash)) {
        readSegment = candidate
        break
      }
    }

    const readLength = readSegment?.length ?? 0
    usage = {
      input_tokens: tokensFromBytes(bodyLength - lastSegment.length),
      cache_creation_input_tokens: tokensFromBytes(lastSegment.length - readLength),
      ...(readSegment ? { cache_read_input_tokens: tokensFromBytes(readSegment.length) } : {}),
    }
  }

  if (commit) {
    for (const segment of segments) seen.add(segment.hash)
  }

  return usage
}

export interface StubUpstreamOptions {
  /** Delay (ms) between receipt and commit — see delayed-commit race note below. Default 0. */
  responseDelayMs?: number
}

export interface StubUpstream {
  server: Server
  url: () => string
  seen: Set<string>
  requestsReceived: () => number
  close: () => Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function buildResponseBody(usage: Usage): unknown {
  return {
    id: `${STUB_MESSAGE_ID_PREFIX}${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    usage,
  }
}

/**
 * In-process HTTP server tracking the breakpoint-anchored prefix hash of
 * every request body it receives. Per request: snapshot a cache-hit lookup
 * against `seen` on receipt (commit: false) -> await responseDelayMs ->
 * commit that body's segment hashes into `seen` -> respond. This ordering
 * makes barrier-OFF concurrency deterministic: N simultaneous requests with
 * an identical prefix all snapshot against an empty (or not-yet-committed)
 * `seen` inside the delay window, so all N see a miss and every one commits
 * a write; barrier-ON holds followers until the leader's first response
 * byte, which — because the leader's own commit happens strictly before it
 * responds — is emitted strictly after the leader's commit, so followers
 * observe the leader's write and read-hit instead of also writing.
 */
export function createStubUpstream(options: StubUpstreamOptions = {}): StubUpstream {
  const responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS
  const seen = new Set<string>()
  let requestCount = 0

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 400, { error: 'only POST is supported' })
      return
    }

    let rawBody: string
    try {
      rawBody = await readRequestBody(req)
    } catch {
      sendJson(res, 400, { error: 'failed to read request body' })
      return
    }

    requestCount += 1

    let usage: Usage
    try {
      usage = simulateUsage(rawBody, seen, false)
    } catch {
      sendJson(res, 400, { error: 'invalid JSON request body' })
      return
    }

    if (responseDelayMs > 0) await delay(responseDelayMs)

    // Commit is re-derived from the same rawBody (already proven parseable
    // above), so this call cannot throw in practice.
    simulateUsage(rawBody, seen, true)

    sendJson(res, 200, buildResponseBody(usage))
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 400, { error: 'request handling failed' })
      else res.end()
    })
  })

  server.listen(0, '127.0.0.1')

  return {
    server,
    url: () => {
      const address = server.address() as AddressInfo | string | null
      if (address === null || typeof address === 'string') {
        throw new Error('stub upstream is not listening on a TCP port yet')
      }
      return `http://127.0.0.1:${address.port}`
    },
    seen,
    requestsReceived: () => requestCount,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
