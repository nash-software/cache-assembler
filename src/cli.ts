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
                   /stats leaks prior request prefix bytes, so this is
                   opt-in, not the default.
  --upstream <url> Upstream URL to forward assembled requests to (required)
  --preset <name>  Named preset (e.g. "claude-code") supplying F3 deferral extractors
  --defer          Enable F3 volatile-byte deferral (active mode)
  --dry-run        Force F3 deferral into dry-run (report only, no bytes moved)
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
  help?: boolean
  version?: boolean
}

function parseCliArgs(argv: string[]): ParsedCliValues {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      upstream: { type: 'string' },
      preset: { type: 'string' },
      defer: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  })
  return values
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
  const values = parseCliArgs(argv)

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

  const port = values.port ? Number.parseInt(values.port, 10) : DEFAULT_PORT
  // Default localhost-only: binding 0.0.0.0 by default would turn this into
  // an unauthenticated open relay (forwards a raw upstream API key) plus a
  // /stats endpoint leaking prior requests' prefix bytes to anyone on the
  // network. LAN/network exposure is opt-in via an explicit --host.
  const host = values.host ?? DEFAULT_HOST
  const config = buildConfig(values)
  const server = createProxyServer({ upstream: values.upstream, config })
  server.listen(port, host, () => {
    io.stdout(`${PACKAGE_NAME} listening on http://${host}:${port}\n`)
  })
  return undefined
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMainModule) {
  const exitCode = run(process.argv.slice(2))
  if (exitCode !== undefined) process.exit(exitCode)
}
