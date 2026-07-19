#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createProxyServer } from './server.js'
import { loadPreset } from './presets.js'
import type { CacheAssemblerConfig } from './config.js'

const DEFAULT_PORT = 8788
const DEFAULT_HOST = '127.0.0.1'
const PACKAGE_NAME = 'cache-assembler'

const HELP_TEXT = `${PACKAGE_NAME} — rewrites Anthropic Messages API requests for maximal prompt-cache reuse

Usage:
  cache-assembler --upstream <url> [options]

Options:
  --port <n>       Port to listen on (default: ${DEFAULT_PORT})
  --host <addr>    Address to bind (default: ${DEFAULT_HOST}, localhost-only).
                   Pass an explicit address (e.g. 0.0.0.0) to opt into LAN
                   exposure — the proxy forwards a raw upstream API key and
                   /stats exposes aggregate token/cost counters to anyone who
                   can reach the port, so this is opt-in, not the default.
  --upstream <url> Upstream URL to forward assembled requests to (required)
  --preset <name>  Named preset (e.g. "claude-code") supplying F3 deferral extractors
  --defer          Enable F3 volatile-byte deferral (active mode)
  --dry-run        Force F3 deferral into dry-run (report only, no bytes moved)
  --trace-log <path>  Append one JSON line per proxied request to this file
                   (tokens, cost, barrier role, latency) — opt-in, off by default
  --help           Show this help text
  --version        Print the package version
`

interface CliIO {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const DEFAULT_IO: CliIO = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

function readOwnVersion(): string {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

interface ParsedCliValues {
  port?: string
  host?: string
  upstream?: string
  preset?: string
  defer?: boolean
  'dry-run'?: boolean
  'trace-log'?: string
  help?: boolean
  version?: boolean
}

class CliArgError extends Error {}

function parseCliArgs(argv: string[]): ParsedCliValues {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        upstream: { type: 'string' },
        preset: { type: 'string' },
        defer: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'trace-log': { type: 'string' },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
    })
    return values
  } catch (err) {
    // parseArgs is strict by default — an unknown flag throws rather than
    // returning a result. Re-throw as a typed error so run() can turn it
    // into a clean usage message instead of an uncaught stack trace.
    throw new CliArgError(err instanceof Error ? err.message : String(err))
  }
}

const MIN_PORT = 0
const MAX_PORT = 65535

/** Returns a validated port number, or an error message if --port is malformed. */
function parsePort(rawPort: string | undefined): { port: number } | { error: string } {
  if (rawPort === undefined) return { port: DEFAULT_PORT }
  const parsed = Number.parseInt(rawPort, 10)
  if (!Number.isInteger(parsed) || String(parsed) !== rawPort.trim() || parsed < MIN_PORT || parsed > MAX_PORT) {
    return { error: `--port must be an integer between ${MIN_PORT} and ${MAX_PORT}, got "${rawPort}"` }
  }
  return { port: parsed }
}

/** Returns null if the upstream URL is well-formed, or an error message. */
function validateUpstream(upstream: string): string | null {
  try {
    new URL(upstream)
    return null
  } catch {
    return `--upstream is not a valid URL: "${upstream}"`
  }
}

function buildConfig(values: ParsedCliValues): CacheAssemblerConfig {
  const config: CacheAssemblerConfig = {}
  const extractors = values.preset ? loadPreset(values.preset).extractors : []
  if (values.defer || values.preset) {
    config.deferral = { enabled: Boolean(values.defer), dryRun: Boolean(values['dry-run']), extractors }
  }
  return config
}

/**
 * Parses CLI args and either returns an exit code (help/version/validation
 * error — nothing left running) or starts the standalone proxy server and
 * returns undefined (process stays alive on the open server socket).
 */
export function run(argv: string[], io: CliIO = DEFAULT_IO): number | undefined {
  let values: ParsedCliValues
  try {
    values = parseCliArgs(argv)
  } catch (err) {
    const message = err instanceof CliArgError ? err.message : err instanceof Error ? err.message : String(err)
    io.stderr(`Error: ${message}\n\n${HELP_TEXT}`)
    return 1
  }

  if (values.help) {
    io.stdout(HELP_TEXT)
    return 0
  }
  if (values.version) {
    io.stdout(`${PACKAGE_NAME} ${readOwnVersion()}\n`)
    return 0
  }
  if (!values.upstream) {
    io.stderr(`Error: --upstream is required\n\n${HELP_TEXT}`)
    return 1
  }
  const upstreamError = validateUpstream(values.upstream)
  if (upstreamError !== null) {
    io.stderr(`Error: ${upstreamError}\n\n${HELP_TEXT}`)
    return 1
  }

  const portResult = parsePort(values.port)
  if ('error' in portResult) {
    io.stderr(`Error: ${portResult.error}\n\n${HELP_TEXT}`)
    return 1
  }

  // Default localhost-only: binding 0.0.0.0 by default would turn this into
  // an unauthenticated open relay (forwards a raw upstream API key) plus a
  // /stats endpoint exposing aggregate token/cost counters to anyone on the
  // network. LAN/network exposure is opt-in via an explicit --host.
  const host = values.host ?? DEFAULT_HOST
  const config = buildConfig(values)
  const server = createProxyServer({ upstream: values.upstream, config, traceLogPath: values['trace-log'] })
  server.on('error', (err: NodeJS.ErrnoException) => {
    io.stderr(`Error: failed to start server on ${host}:${portResult.port}: ${err.message}\n`)
    process.exitCode = 1
  })
  server.listen(portResult.port, host, () => {
    io.stdout(`${PACKAGE_NAME} listening on http://${host}:${portResult.port}\n`)
  })
  return undefined
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  const exitCode = run(process.argv.slice(2))
  if (exitCode !== undefined) process.exit(exitCode)
}
