# E2E test suite with real cost/cache metrics — design

## Why

cache-assembler currently has unit, property, and mocked-integration tests
(`test/*.test.ts`) that verify request-rewriting logic against stub upstreams
with hand-set `usage` numbers. Before publishing this package, we need
end-to-end evidence that:

1. The proxy actually improves prompt-cache hit rates for real Claude Code
   traffic (not just that it rewrites bytes the way we intended).
2. That improvement translates into a real, defensible dollar figure —
   broken down by which feature (F1 canonicalization, F2 breakpoints, F3
   deferral, F4 write-barrier) contributed how much.
3. The F4 write-barrier genuinely collapses concurrent identical-prefix
   requests to a single cache write.

## Non-goals

- This is not a CI-gating test suite. It requires real credentials (for the
  real-CLI harness) and is invoked manually / on demand.
- Not testing proxy-manager chain-hop integration — that's covered by
  `proxy-manager`'s own test suite (confirmed to exist already).
- Not covering every preset — the `claude-code` preset is the only one that
  exists today, so it's the only one exercised.

## Architecture

Two independent test harnesses producing a common JSON result shape, plus a
report builder that merges them into one HTML report.

```
test/e2e/
  layers.ts                  Shared L0-L5 config matrix (see below)
  fixtures/
    session-turns.ts         One realistic ~5-6 turn coding task/session,
                              parameterized so both harnesses can drive it
                              (as prompts for real-CLI, as pre-shaped request
                              bodies for synthetic)
  synthetic/
    stub-upstream.ts         In-process HTTP stub standing in for the real
                              Anthropic API
    run-synthetic.ts         Orchestrates all layers + the concurrency proof
  real-cli/
    run-real-cli.ts          Orchestrates real `claude` CLI subprocesses
  report/
    build-report.ts          Merges synthetic + real JSON into one HTML report
    template.html            Report shell (inline SVG bar charts, no new deps)
  results/                   Gitignored: raw JSON + generated report.html
```

### Layer matrix (`layers.ts`)

Cumulative feature layers, mapped onto cache-assembler's real config toggles
(`canonicalize`, `breakpoints`, `deferral`, `barrier`, `telemetry` in
`src/config.ts`):

| Layer | Config | Proves |
|---|---|---|
| L0 — Baseline | No proxy at all, direct to API | The floor: zero cache coordination |
| L1 — F2 naive | `breakpoints.enabled=true`, `canonicalize.enabled=false` | Breakpoints alone, over tool definitions that are deliberately re-jittered every turn — isolates what happens *without* F1 |
| L2 — F1+F2 | + `canonicalize.enabled=true` | F1's real contribution: does canonicalization rescue the cache from the same turn-to-turn tool jitter L1 suffers? |
| L3 — +F4 | + `barrier.enabled=true` (= library defaults) | Barrier effect on solo (non-concurrent) sessions — expected ~0 |
| L4 — +F3 dry-run | + `deferral.enabled=true, dryRun=true` w/ `claude-code` preset | Preview of what F3 *would* save, no bytes changed |
| L5 — +F3 active | + `deferral.dryRun=false` (`--defer`) | Full stack: does deferring scratchpad/session-UUID bytes rescue cache hits across turns? |

Each layer runs in **both** harnesses.

**Amendment (post-first-run correction):** the original L1 (`canonicalize.enabled=true`,
all else off) was a mechanical no-op — with no breakpoint present, F1 can never produce a
cache-hit signal regardless of whether it works, and the fixture never varied tool
serialization in the first place, so there was nothing for F1 to fix either. Fixed by (a)
adding deterministic per-turn tool key-order jitter to the fixture (`session-turns.ts`,
simulating a client that re-serializes tools inconsistently request to request), and (b)
redefining L1 as the naive breakpoint-without-canonicalization case, isolating F1's real
contribution as the L1→L2 delta. Separately, the synthetic harness's upstream stub
(`stub-upstream.ts`) originally hashed the growing message history as a closed JSON blob,
which structurally can never credit an earlier turn's shorter cached prefix as valid (closing
brackets land at different byte positions for different array lengths) — understating real
incremental cache reuse and making every layer look like a net loss. Fixed with an
incremental rolling hash over flat concatenated content, which is genuinely prefix-stable.

### Synthetic harness

- `stub-upstream.ts` is an in-process HTTP server that tracks the SHA-based
  prefix hash of every request body it receives (via a `Map<hash, seen>`). If
  a hash was seen before, it responds with `cache_read_input_tokens` set to a
  simulated prefix size and `cache_creation_input_tokens: 0`; if not, the
  reverse. This makes "cache hit" in the synthetic run a genuine function of
  whether the assembled request's bytes actually stabilized turn-to-turn —
  not a canned number — so the synthetic harness is a real functional proof,
  just against a fake upstream instead of the real API.
- Each simulated "instance" replays the shared 5-6 turn session
  (`fixtures/session-turns.ts`), with a fresh fake scratchpad-path/session-id
  per instance (mimicking real Claude Code volatile bytes) so F3's effect is
  visible.
- Default instance count: 30 per layer (configurable via `--instances`),
  since this path is free and fast — gives statistical smoothing that the
  small real-CLI run can't.
- Concurrency scenario: launch e.g. 20 instances' first request
  simultaneously via `Promise.all`, with an identical prefix, and assert
  `barrier.enabled` collapses `cacheWrites` to 1 vs. N with it disabled.

### Real-CLI harness

- Each "instance" is one long-lived
  `claude -p --input-format stream-json --output-format stream-json --no-session-persistence`
  child process, fed the shared 5-6 turn session sequentially over stdin
  (avoids needing `--resume`/session-ID bookkeeping across separate
  processes). Each turn's real `usage` block is read back from the
  stream-json output.
- Defaults to `--model claude-haiku-4-5` to hold cost down — caching
  mechanics are model-agnostic, so the cheapest model is fine for this
  purpose. Overridable via `--model`.
- Default instance count: 3 per layer (configurable, hard-capped in code —
  see Safety rails).
- Concurrency scenario: N (default 5) such processes launched together with
  an identical opening prompt/task, checking the proxy's `/stats.cacheWrites`
  after all N complete their first turn — expect 1 with the barrier on, N
  with it off.
- Requires a working `claude auth login` in the environment it runs in (this
  harness is meant to be run interactively by a human with valid credentials,
  not from an unattended/expired-session context).

### Safety rails (real-CLI harness only)

- Refuses to run without an explicit `--confirm` flag.
- Hard-caps total instance count in code (default cap: 50 total real CLI
  invocations across all layers + concurrency scenario); anything above
  requires an explicit `--force-instances <n>` override.
- Passes `--max-budget-usd` per child process.
- Prints an estimated total spend (rough: instances × turns × avg tokens ×
  Haiku pricing) and requires the user to confirm before executing, unless
  `--yes` is passed for non-interactive use.
- The synthetic harness has no such gate — it's free and local-only.

### Report

`build-report.ts` reads whichever of `results/synthetic.json` /
`results/real-cli.json` exist, computes per-layer aggregates (mean
cache-hit-rate, mean modeled $ saved using the same pricing formula as
`src/telemetry.ts`, and — for the real run only — actual $ spent), and
renders one self-contained HTML file: a bar chart of cache-hit-rate by layer,
a bar chart of $ saved by layer, a raw-numbers table, and a concurrency-proof
section (write count before/after). No new runtime dependency — charts are
hand-rolled inline SVG. Real-CLI numbers headline where available; synthetic
numbers back them up at higher N.

### Invocation

- `npm run e2e:synthetic` — free, no gating, safe to run any time
- `npm run e2e:real -- --confirm` — real cost, requires `claude auth login`
- `npm run e2e:report` — builds `results/report.html` from whichever result
  files exist

### Testing the harness code itself

The orchestration scripts (`run-synthetic.ts`, `run-real-cli.ts`,
`build-report.ts`) are scripts, not vitest suites, and are excluded from the
default `npm run test:unit`. Their pure logic (the stub-upstream cache
simulation, the per-layer aggregation math in the report builder) gets
regular vitest unit tests alongside the existing `test/*.test.ts` suite,
since that logic is easy to get subtly wrong and needs the same scrutiny as
the library code it's validating.

## Error handling

- Both harnesses fail closed: if a `claude` subprocess or synthetic request
  errors, that instance/turn is recorded as failed (not silently dropped),
  and the report surfaces a failure count per layer rather than only showing
  successful-run averages.
- If the real-CLI harness's `claude auth status`-equivalent check fails
  before starting (no valid session), it exits immediately with a clear
  message rather than burning through failed subprocess attempts.

## Open questions resolved during brainstorming

- **Traffic source**: both synthetic (fast, cheap, high-N) and real `claude`
  CLI (authentic, low-N, real dollars) — confirmed.
- **Real spend**: the "resets tomorrow, spend some usage" plan requires the
  real-CLI harness to run in a shell with valid OAuth (subscription-backed),
  not a bare API key — the proxy-routing mechanism itself was confirmed
  compatible with OAuth passthrough (matching `prism`/`proxy-manager`'s
  existing approach of forwarding headers verbatim), but this session's own
  `claude` login happened to be expired, unrelated to the proxy design.
- **Concurrency proof**: included as a dedicated scenario in both harnesses,
  not folded into the layer matrix.
- **Layering**: confirmed cumulative L0-L5 matrix mapped onto real config
  toggles, run identically in both harnesses.
