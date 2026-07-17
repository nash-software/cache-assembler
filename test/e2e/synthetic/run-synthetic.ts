import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { createProxyServer } from '../../../src/server.js'
import { TelemetryStore } from '../../../src/telemetry.js'
import type { CacheAssemblerConfig } from '../../../src/config.js'
import type { Usage } from '../../../src/types.js'
import { createStubUpstream } from './stub-upstream.js'
import { buildSessionTurns, defaultVolatileParams } from '../fixtures/session-turns.js'
import { getLayer, LAYERS, type LayerDefinition } from '../layers.js'

const DEFAULT_INSTANCES = 30
const DEFAULT_CONCURRENCY = 8
const DEFAULT_TURNS = 6
const DEFAULT_OUT = 'test/e2e/results/synthetic.json'
const SEQUENTIAL_RESPONSE_DELAY_MS = 0
const CONCURRENT_RESPONSE_DELAY_MS = 100
const MESSAGES_PATH = '/v1/messages'

interface CliOptions {
  instances: number
  concurrency: number
  turns: number
  out: string
}

interface LayerResult {
  label: string
  cacheHitRate: number
  estSavedUsd: number
  requests: number
  cacheReads: number
  cacheWrites: number
  cacheReadTokens: number
  cacheCreationTokens: number
  failures: number
}

interface ConcurrencyResult {
  instances: number
  barrierOnWrites: number
  barrierOffWrites: number
}

interface SyntheticOutput {
  generatedAt: string
  instances: number
  turns: number
  layers: Record<string, LayerResult>
  concurrency: ConcurrencyResult
}

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      instances: { type: 'string', default: String(DEFAULT_INSTANCES) },
      concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
      turns: { type: 'string', default: String(DEFAULT_TURNS) },
      out: { type: 'string', default: DEFAULT_OUT },
    },
  })
  return {
    instances: Number.parseInt(values.instances as string, 10),
    concurrency: Number.parseInt(values.concurrency as string, 10),
    turns: Number.parseInt(values.turns as string, 10),
    out: values.out as string,
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function serverUrl(server: Server): string {
  const address = server.address() as AddressInfo | string | null
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port')
  }
  return `http://127.0.0.1:${address.port}`
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

interface PostResult {
  ok: boolean
  usage?: Usage
}

/**
 * Posts a raw JSON body to `targetUrl` and extracts the response's `usage`
 * field. Per spec error handling, any transport/parse failure or non-2xx
 * response is reported as `{ok:false}` rather than throwing — the caller
 * counts it as a turn failure instead of silently dropping it.
 */
async function postJson(targetUrl: string, rawBody: string): Promise<PostResult> {
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    })
    const text = await res.text()
    if (!res.ok) return { ok: false }
    const parsed = JSON.parse(text) as { usage?: Usage }
    if (parsed.usage === undefined) return { ok: false }
    return { ok: true, usage: parsed.usage }
  } catch {
    return { ok: false }
  }
}

/**
 * Runs every instance's full turn sequence through one layer (L0 direct to
 * the stub, L1-L5 through a fresh createProxyServer), recording client-side
 * metrics into a fresh TelemetryStore per micro-plan decision 3. Fresh stub
 * (and fresh proxy, for proxied layers) per layer means all instances within
 * a layer share one `seen` map, so a later layer's cross-instance F3 uplift
 * (L5) is observable while each layer's isolation from the others is intact.
 */
async function runLayer(layer: LayerDefinition, instances: number, turnsCount: number): Promise<LayerResult> {
  const store = new TelemetryStore()
  const stub = createStubUpstream({ responseDelayMs: SEQUENTIAL_RESPONSE_DELAY_MS })
  await once(stub.server, 'listening')

  let proxy: Server | undefined
  let targetUrl = `${stub.url()}${MESSAGES_PATH}`
  if (layer.proxy) {
    proxy = createProxyServer({ upstream: stub.url(), config: layer.config })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    targetUrl = `${serverUrl(proxy)}${MESSAGES_PATH}`
  }

  let failures = 0
  for (let instanceIndex = 0; instanceIndex < instances; instanceIndex++) {
    const params = defaultVolatileParams(instanceIndex)
    const turns = buildSessionTurns(params, turnsCount)
    for (const turnBody of turns) {
      const rawBody = JSON.stringify(turnBody)
      const prefixHash = sha256Hex(rawBody)
      try {
        const result = await postJson(targetUrl, rawBody)
        if (!result.ok || result.usage === undefined) {
          failures += 1
          continue
        }
        store.record({ prefixHash, usage: result.usage })
      } catch {
        failures += 1
      }
    }
  }

  if (proxy) await closeServer(proxy)
  await stub.close()

  const stats = store.stats()
  const cacheHitRate = stats.requests === 0 ? 0 : stats.cacheReads / stats.requests

  return {
    label: layer.label,
    cacheHitRate,
    estSavedUsd: stats.estSavedUsd,
    requests: stats.requests,
    cacheReads: stats.cacheReads,
    cacheWrites: stats.cacheWrites,
    cacheReadTokens: stats.cacheReadTokens,
    cacheCreationTokens: stats.cacheCreationTokens,
    failures,
  }
}

/**
 * Sends `concurrency` identical requests simultaneously (via Promise.all)
 * through a fresh stub (responseDelayMs: 100, wide enough for every request
 * to land inside the delayed-commit race window) + fresh proxy configured
 * with `config`, and returns the resulting TelemetryStore's cacheWrites.
 */
async function runConcurrentBatch(rawBody: string, concurrency: number, config: CacheAssemblerConfig): Promise<number> {
  const store = new TelemetryStore()
  const stub = createStubUpstream({ responseDelayMs: CONCURRENT_RESPONSE_DELAY_MS })
  await once(stub.server, 'listening')

  const proxy = createProxyServer({ upstream: stub.url(), config })
  proxy.listen(0)
  await once(proxy, 'listening')
  const targetUrl = `${serverUrl(proxy)}${MESSAGES_PATH}`

  const prefixHash = sha256Hex(rawBody)
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => postJson(targetUrl, rawBody)),
  )
  for (const result of results) {
    if (result.ok && result.usage !== undefined) store.record({ prefixHash, usage: result.usage })
  }

  await closeServer(proxy)
  await stub.close()

  return store.stats().cacheWrites
}

/**
 * Concurrency proof (decision 8): one fixed turn-1 request body sent
 * `concurrency` times simultaneously, once through L3's config (barrier on)
 * and once through L2's config (barrier off), each against a fresh
 * stub+proxy+store. Demonstrates `barrier.enabled` collapsing concurrent
 * identical-prefix writes to 1 vs. N without it.
 */
async function runConcurrencyScenario(concurrency: number): Promise<ConcurrencyResult> {
  const fixedParams = defaultVolatileParams(0)
  const [turn1] = buildSessionTurns(fixedParams, 1)
  const rawBody = JSON.stringify(turn1)

  const barrierOnWrites = await runConcurrentBatch(rawBody, concurrency, getLayer('L3').config)
  const barrierOffWrites = await runConcurrentBatch(rawBody, concurrency, getLayer('L2').config)

  return { instances: concurrency, barrierOnWrites, barrierOffWrites }
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2))

  const layers: Record<string, LayerResult> = {}
  for (const layer of LAYERS) {
    layers[layer.id] = await runLayer(layer, opts.instances, opts.turns)
  }

  const concurrency = await runConcurrencyScenario(opts.concurrency)

  const output: SyntheticOutput = {
    generatedAt: new Date().toISOString(),
    instances: opts.instances,
    turns: opts.turns,
    layers,
    concurrency,
  }

  const zeroRequestLayers = Object.entries(layers)
    .filter(([, result]) => result.requests === 0)
    .map(([id]) => id)
  if (zeroRequestLayers.length > 0) {
    console.error(`synthetic harness: layer(s) with zero successful requests: ${zeroRequestLayers.join(', ')}`)
    process.exitCode = 1
    return
  }

  try {
    await mkdir(dirname(opts.out), { recursive: true })
    await writeFile(opts.out, JSON.stringify(output, null, 2))
  } catch (err) {
    console.error(`synthetic harness: failed to write output to ${opts.out}`, err)
    process.exitCode = 1
    return
  }

  console.log(`synthetic harness: wrote ${opts.out}`)
}

main().catch((err: unknown) => {
  console.error('synthetic harness: unhandled error', err)
  process.exitCode = 1
})
