#!/usr/bin/env tsx
// Verifies the ACTUAL PACKAGED artifact - not source, not dist/ imported
// in-place - works the three ways the README documents:
//   1. As a library, with real type information (the exact bug that shipped:
//      tsconfig.build.json had no `declaration: true`, so the published
//      package had zero .d.ts files despite package.json promising one).
//   2. As a CLI binary via `npx cache-assembler` (bin resolution, shebang).
//   3. As a standalone proxy service - spawn the real installed binary,
//      point a plain HTTP client at it exactly the way Claude Code's
//      ANTHROPIC_BASE_URL would, and confirm request rewriting actually
//      happens through the packaged code, not just in source.
//
// Not run in CI (slow: full build + npm pack + a fresh npm install). Invoke
// manually via `npm run e2e:package`. Never publishes anything - npm pack
// produces a local tarball, installed into a scratch directory.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const IS_WINDOWS = process.platform === 'win32'

// npm/npx are .cmd shims on Windows - execFileSync only resolves them via
// PATH when shell:true is set (unlike execSync, which always goes through
// a shell). Centralized here so every call site gets this consistently.
function runCmd(command: string, args: string[], options: { cwd: string; stdio?: 'inherit' | 'pipe' }): Buffer {
  return execFileSync(command, args, { ...options, shell: IS_WINDOWS })
}

const results: Array<{ phase: string; ok: boolean; detail: string }> = []

function record(phase: string, ok: boolean, detail: string): void {
  results.push({ phase, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${phase}: ${detail}`)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const attempt = async (): Promise<void> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`proxy did not become healthy within ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 150))
    return attempt()
  }
  return attempt()
}

async function main(): Promise<void> {
  console.log('=== Phase 0: build + pack the actual publishable artifact ===')
  runCmd('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
  const packJson = runCmd('npm', ['pack', '--json'], { cwd: REPO_ROOT }).toString()
  const tarballName = (JSON.parse(packJson) as Array<{ filename: string }>)[0]?.filename
  if (tarballName === undefined) throw new Error('npm pack produced no tarball')
  const tarballPath = join(REPO_ROOT, tarballName)
  console.log(`packed: ${tarballName}`)

  const scratchDir = mkdtempSync(join(tmpdir(), 'cache-assembler-package-verify-'))
  console.log(`scratch install dir: ${scratchDir}`)

  let proxyProc: ChildProcess | undefined
  let fakeUpstream: Server | undefined

  try {
    writeFileSync(
      join(scratchDir, 'package.json'),
      JSON.stringify({ name: 'scratch-consumer', version: '0.0.0', private: true, type: 'module' }),
    )
    console.log('\n=== Installing the packed tarball into a clean scratch project ===')
    runCmd('npm', ['install', tarballPath, 'typescript@5.6.3'], { cwd: scratchDir, stdio: 'inherit' })

    // --- Phase 1: library import, WITH real type information ---
    console.log('\n=== Phase 1: library import + type-check against the installed .d.ts ===')
    const dtsPath = join(scratchDir, 'node_modules', 'cache-assembler', 'dist', 'index.d.ts')
    if (!existsSync(dtsPath)) {
      record('library types', false, `dist/index.d.ts missing from the installed package at ${dtsPath}`)
    } else {
      record('library types', true, '.d.ts files present in the installed package')
    }

    writeFileSync(
      join(scratchDir, 'consumer.ts'),
      [
        "import { assemble } from 'cache-assembler'",
        '',
        'const { req, report } = assemble(',
        "  { model: 'claude-sonnet-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },",
        '  {},',
        ')',
        '',
        "if (typeof report.prefixHash !== 'string' || report.prefixHash.length === 0) {",
        "  throw new Error('assemble() did not return a usable prefixHash')",
        '}',
        "if (req.messages.length !== 1) {",
        "  throw new Error('assemble() returned an unexpected request shape')",
        '}',
        "console.log('CONSUMER_OK', report.prefixHash)",
      ].join('\n'),
    )
    writeFileSync(
      join(scratchDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          strict: true,
          noEmit: true,
        },
        include: ['consumer.ts'],
      }),
    )
    try {
      runCmd('npx', ['tsc', '--noEmit'], { cwd: scratchDir, stdio: 'pipe' })
      record('library type-check', true, 'a real TypeScript consumer type-checks cleanly against the installed package')
    } catch (err) {
      const output = err instanceof Error && 'stdout' in err ? String((err as { stdout: Buffer }).stdout) : String(err)
      record('library type-check', false, `tsc failed against the installed package:\n${output}`)
    }

    try {
      const runOutput = execFileSync('node', ['--experimental-strip-types', 'consumer.ts'], { cwd: scratchDir }).toString()
      const ok = runOutput.includes('CONSUMER_OK')
      record('library runtime', ok, ok ? 'assemble() ran correctly from the installed package' : `unexpected output: ${runOutput}`)
    } catch (err) {
      record('library runtime', false, `consumer script threw: ${err instanceof Error ? err.message : String(err)}`)
    }

    // --- Phase 2: CLI binary resolution ---
    console.log('\n=== Phase 2: CLI binary via npx ===')
    try {
      const helpOutput = runCmd('npx', ['cache-assembler', '--help'], { cwd: scratchDir }).toString()
      record('cli --help', helpOutput.includes('cache-assembler'), 'npx cache-assembler --help resolved and ran')
    } catch (err) {
      record('cli --help', false, `npx cache-assembler --help failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const versionOutput = runCmd('npx', ['cache-assembler', '--version'], { cwd: scratchDir }).toString().trim()
      record('cli --version', versionOutput.length > 0, `reported version: "${versionOutput}"`)
    } catch (err) {
      record('cli --version', false, `npx cache-assembler --version failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // --- Phase 3: full standalone-proxy behavior, through the real installed binary ---
    // This is the ANTHROPIC_BASE_URL pattern: something (here, a plain fetch
    // call - Claude Code does the same thing) sends a request to the proxy's
    // own address instead of api.anthropic.com. Proves the packaged binary
    // actually rewrites bytes, not just that it starts.
    console.log('\n=== Phase 3: standalone proxy, real installed binary, real HTTP traffic ===')
    let receivedBody: string | undefined
    fakeUpstream = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ usage: { input_tokens: 10 } }))
      })
    })
    const upstreamPort = await listen(fakeUpstream)

    const proxyPort = 20000 + Math.floor(Math.random() * 10000)
    proxyProc = spawn('npx', ['cache-assembler', '--upstream', `http://127.0.0.1:${upstreamPort}`, '--port', String(proxyPort)], {
      cwd: scratchDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let proxyLog = ''
    proxyProc.stdout?.on('data', (c: Buffer) => (proxyLog += c.toString()))
    proxyProc.stderr?.on('data', (c: Buffer) => (proxyLog += c.toString()))

    await waitForHealth(proxyPort, 15_000)

    // Unsorted tool-definition keys on purpose - proves F1 canonicalization
    // actually ran through the packaged binary, not just in source tests.
    const unsortedRequest = {
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ description: 'a tool', name: 'ztool', input_schema: { type: 'object' } }],
    }
    const proxyResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(unsortedRequest),
    })
    const proxyOk = proxyResponse.ok
    record('standalone proxy round-trip', proxyOk, `POST /v1/messages via the installed binary returned ${proxyResponse.status}`)

    if (receivedBody === undefined) {
      record('standalone proxy rewrote the request', false, 'fake upstream never received a request')
    } else {
      const forwarded = JSON.parse(receivedBody) as { tools?: Array<Record<string, unknown>> }
      // F2 (breakpoint placement) legitimately appends its own `cache_control`
      // key AFTER F1 canonicalizes - exclude it here, it's a different
      // feature's addition, not part of what canonicalization sorts.
      const forwardedKeys = (forwarded.tools?.[0] === undefined ? [] : Object.keys(forwarded.tools[0])).filter(
        (k) => k !== 'cache_control',
      )
      const isSorted = JSON.stringify(forwardedKeys) === JSON.stringify([...forwardedKeys].sort())
      record(
        'standalone proxy rewrote the request',
        isSorted,
        isSorted
          ? `tool definition keys arrived at upstream sorted (${forwardedKeys.join(', ')}) - canonicalization ran through the real installed binary`
          : `tool definition keys were NOT canonicalized: ${forwardedKeys.join(', ')}`,
      )
    }

    if (results.some((r) => !r.ok)) {
      console.log('\n--- proxy process output (for debugging the failure above) ---')
      console.log(proxyLog)
    }
  } finally {
    // On Windows, spawn(..., { shell: true }) means proxyProc.kill() only
    // kills the shell wrapper, not the actual node.exe it launched - the
    // real process (and its open handles inside scratchDir) survives,
    // which is what caused the scratch dir to be EBUSY on cleanup below.
    // taskkill /t kills the whole process tree.
    if (proxyProc?.pid !== undefined) {
      if (IS_WINDOWS) {
        try {
          execFileSync('taskkill', ['/pid', String(proxyProc.pid), '/t', '/f'], { stdio: 'ignore' })
        } catch {
          /* already exited */
        }
      } else {
        proxyProc.kill()
      }
    }
    await new Promise<void>((resolve) => (fakeUpstream !== undefined ? fakeUpstream.close(() => resolve()) : resolve()))

    // Directory removal can still race a just-killed process releasing its
    // file handles - retry with backoff instead of failing the whole run
    // over a cleanup race.
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        rmSync(scratchDir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 5) throw err
        await new Promise((r) => setTimeout(r, 300 * attempt))
      }
    }
    rmSync(tarballPath, { force: true })
  }

  console.log('\n=== Summary ===')
  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.phase}`)
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} checks failed.`)
    process.exit(1)
  }
  console.log(`\nAll ${results.length} checks passed - the packaged artifact works as documented.`)
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
