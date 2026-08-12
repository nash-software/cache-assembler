# cache-assembler

[![npm version](https://img.shields.io/npm/v/cache-assembler)](https://www.npmjs.com/package/cache-assembler)
[![npm downloads](https://img.shields.io/npm/dm/cache-assembler)](https://www.npmjs.com/package/cache-assembler)
[![CI](https://github.com/nash-software/cache-assembler/actions/workflows/ci.yml/badge.svg)](https://github.com/nash-software/cache-assembler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/cache-assembler)](./LICENSE)

Rewrites Anthropic Messages API requests for maximal prompt-cache reuse - a
small, dependency-free library and standalone proxy that makes your
requests' cacheable **prefix** stay byte-identical across turns, so
Anthropic's prompt cache actually hits.

**TL;DR:** Claude's API can serve part of a request from a cheap cache
instead of full price - but only if the request bytes match exactly, every
time. Most real usage doesn't hit that bar without help. This tool sits in
front of the API, fixes the things that normally break the match, and
measurably cut one real workload's cost by 8.2x. MIT licensed, no
dependencies, and every number in the linked report is reproducible with
your own API key.

## Why this exists

Anthropic bills prompt-cache reads at roughly **0.1x** the base per-token
price, and cache writes at roughly **2x** base price with a 1-hour TTL. That
economics only pays off if the *bytes* leading up to a cache breakpoint are
identical between requests - and in practice they rarely are:

- Tool definitions get re-serialized in a different key order by different
  client libraries or even different runs of the same library.
- Session-scoped identifiers (scratchpad paths, session UUIDs, per-run URLs)
  get embedded in system prompts or tool descriptions, silently invalidating
  the cached prefix on every single request.
- Concurrent requests for the same not-yet-cached prefix race each other,
  each paying the full cache-write premium instead of one write followed by
  cheap reads.

`cache-assembler` fixes all three: canonicalize what's safe to
canonicalize, relocate what's genuinely volatile out of the stable prefix,
place cache breakpoints where they'll actually be hit, and coordinate
concurrent requests so only one pays the write cost.

## Features

| Feature | Default | What it does |
|---|---|---|
| **F1** canonicalization | on | Deterministic key ordering for tool definitions - same tools, same bytes, every time. |
| **F2** breakpoint placement | on | Places up to 4 `cache_control` breakpoints (the API's budget) at the highest-value boundaries, tiered `1h` then `5m`, without ever touching client-set breakpoints. |
| **F3** volatile-byte deferral | **off**, dry-run when enabled | Opt-in: relocates session-unique spans (matched by configurable extractors) out of the stable prefix into a trailing block, so the prefix stops changing every request. |
| **F4** fan-out write barrier | on | Coordinates concurrent identical-prefix requests so only the first (the "leader") pays the cache-write cost; followers wait for the leader's first byte before proceeding. |
| **F5** telemetry | on | Tracks cache reads/writes/tokens, estimates dollars saved, and flags when a cached prefix diverges (and why). |

F3 ships **disabled and dry-run by default** - it rewrites request bytes, so
enabling it in a way that changes model-visible content is always an
explicit opt-in.

## Two ways to use it

Install it first:

```sh
npm install cache-assembler
```

**1. As a pure library** - call `assemble()` directly wherever you build
requests:

```ts
import { assemble } from 'cache-assembler'

const { req, report } = assemble(anthropicRequest, config)
// req: the rewritten request, ready to send to the Anthropic API
// report: what each feature did (breakpoints placed, spans moved, prefix hash)
```

**2. As a standalone binary** - install the package and run it as its own
HTTP proxy in front of any upstream:

```sh
npx cache-assembler --upstream https://api.anthropic.com
```

```
Options:
  --port <n>       Port to listen on (default: 8788)
  --host <addr>    Address to bind (default: 127.0.0.1, localhost-only)
  --upstream <url> Upstream URL to forward assembled requests to (required)
  --preset <name>  Named preset (e.g. "claude-code") supplying F3 deferral extractors
  --defer          Enable F3 volatile-byte deferral (active mode)
  --dry-run        Force F3 deferral into dry-run (report only, no bytes moved)
  --trace-log <path>  Append one JSON line per proxied request to this file
  --upstream-timeout <ms>  Time-to-first-byte timeout (default: 120000)
  --help           Show this help text
  --version        Print the package version
```

The standalone server exposes `GET /health` (liveness) and `GET /stats`
(telemetry as JSON) alongside the proxied `POST /v1/messages` path (also
accepted under any `/hop/*` path, for chaining behind another reverse proxy).
`/stats`'s `estLostUsd` field is always `<= 0` - its magnitude is the premium
paid for cache writes vs. what those same tokens would have cost as plain
input.

## Using with Claude Code

This is the setup the validation report's production run actually used: run
cache-assembler as a background service, then point the `claude` CLI at it
instead of Anthropic's real endpoint by setting `ANTHROPIC_BASE_URL`. Your
own Claude subscription and its normal authentication are untouched -
cache-assembler only rewrites the request body, everything else (including
auth) passes through unchanged.

**1. Start cache-assembler** (in its own terminal, or as a background
service via pm2/systemd/whatever you already use):

```sh
npx cache-assembler --upstream https://api.anthropic.com --preset claude-code --defer --port 8788
```

**2. Point Claude Code at it.** The env var is read once, when the `claude`
process starts - set it *before* launching Claude Code, and restart Claude
Code after changing it.

```sh
# bash / zsh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
claude
```

```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8788"
claude
```

Or set it permanently in `~/.claude/settings.json`'s `env` block so it
applies to every session without re-exporting it each time.

**Claude Desktop is not supported.** Unlike the `claude` CLI, the Desktop
app doesn't expose a configurable base URL - it resets `ANTHROPIC_BASE_URL`
to the real Anthropic endpoint when it spawns a session, by design, to
protect subscription tokens that are scoped to `api.anthropic.com`. This
only works with the Claude Code CLI, or any client that lets you point
directly at a custom base URL (including plain API-key usage).

## Presets

Presets are pure JSON data - no executable code - describing F3 extractors
for a known client. Ship one for `claude-code` out of the box:

```sh
npx cache-assembler --upstream https://api.anthropic.com --preset claude-code --defer
```

To contribute a preset: add `presets/<name>.json` matching the shape
`{ name, version, description, extractors: [{ id, path, pattern, flags? }] }`,
where `path` uses the constrained JSON-path grammar (`field`, `[n]`,
`[*]`) to target string-valued leaves, and `pattern` is a regex source
matching the volatile span to relocate. Add a fixture under
`test/fixtures/` and a case in `test/presets.test.ts` verifying every
planted span is found.

## Validation

The initial release ships with a full validation report - a controlled
A/B experiment against the real Anthropic API (8.2x cost reduction,
$1.33 → $0.16 per 100-turn session), a feature-by-feature mechanism
study, and four real bugs found and fixed by battle-testing against
production traffic. Read it, or reproduce it yourself with your own
Anthropic API key: [`docs/validation-report.md`](./docs/validation-report.md).

## Design notes

- Zero runtime dependencies - independently releasable and installable via
  [npm](https://www.npmjs.com/package/cache-assembler).
- The core `assemble()` function is pure: it never mutates its inputs, and
  every side effect (cache-write coordination, telemetry) lives in the
  injectable proxy wrapper, not the core pipeline.
- Fail-open everywhere: an error in assembly or barrier coordination logs
  and falls back to forwarding the original, unmodified request rather than
  breaking the proxy path.

## License

MIT - see [LICENSE](./LICENSE).

## Author

Built by [Michael Nash](https://www.linkedin.com/in/michael-nash-504838b3/) -
independent software consultant, [nashsoftware.dev](https://nashsoftware.dev).
Issues and PRs welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md).
