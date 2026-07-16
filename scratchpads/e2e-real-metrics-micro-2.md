---
spec_ref: docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md
---

# Micro-plan 2: Synthetic harness — L0-L5 layer matrix + concurrency proof

## Context

Rubric criterion 2 (`scratchpads/e2e-real-metrics-goal.md`), quoted verbatim:

> 2. **Synthetic harness covers all six layers (L0-L5) + the concurrency proof**
>    verify:
>    ```sh
>    npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json && node -e "
>    const r = require('./test/e2e/results/synthetic.json');
>    const layers = ['L0','L1','L2','L3','L4','L5'];
>    for (const l of layers) {
>      if (!r.layers?.[l] || typeof r.layers[l].cacheHitRate !== 'number' || typeof r.layers[l].estSavedUsd !== 'number') {
>        console.error('missing/invalid layer: ' + l); process.exit(1);
>      }
>    }
>    if (!r.concurrency || !(r.concurrency.barrierOnWrites < r.concurrency.barrierOffWrites)) {
>      console.error('concurrency proof missing or not demonstrating dedup'); process.exit(1);
>    }
>    console.log('ok');
>    "
>    ```

Spec, "Layer matrix (`layers.ts`)" section, quoted verbatim:

> Cumulative feature layers, mapped onto cache-assembler's real config toggles
> (`canonicalize`, `breakpoints`, `deferral`, `barrier`, `telemetry` in
> `src/config.ts`):
>
> | Layer | Config | Proves |
> |---|---|---|
> | L0 — Baseline | No proxy at all, direct to API | The floor: zero cache coordination |
> | L1 — F1 | `canonicalize.enabled=true`, all else off | Effect of deterministic key ordering alone |
> | L2 — F1+F2 | + `breakpoints.enabled=true` | This is what actually turns caching on |
> | L3 — +F4 | + `barrier.enabled=true` (= library defaults) | Barrier effect on solo (non-concurrent) sessions — expected ~0 |
> | L4 — +F3 dry-run | + `deferral.enabled=true, dryRun=true` w/ `claude-code` preset | Preview of what F3 *would* save, no bytes changed |
> | L5 — +F3 active | + `deferral.dryRun=false` (`--defer`) | Full stack: does deferring scratchpad/session-UUID bytes rescue cache hits across turns? |
>
> Each layer runs in **both** harnesses.

Spec, "Synthetic harness" section, quoted verbatim:

> - `stub-upstream.ts` is an in-process HTTP server that tracks the SHA-based
>   prefix hash of every request body it receives (via a `Map<hash, seen>`). If
>   a hash was seen before, it responds with `cache_read_input_tokens` set to a
>   simulated prefix size and `cache_creation_input_tokens: 0`; if not, the
>   reverse. This makes "cache hit" in the synthetic run a genuine function of
>   whether the assembled request's bytes actually stabilized turn-to-turn —
>   not a canned number — so the synthetic harness is a real functional proof,
>   just against a fake upstream instead of the real API.
> - Each simulated "instance" replays the shared 5-6 turn session
>   (`fixtures/session-turns.ts`), with a fresh fake scratchpad-path/session-id
>   per instance (mimicking real Claude Code volatile bytes) so F3's effect is
>   visible.
> - Default instance count: 30 per layer (configurable via `--instances`),
>   since this path is free and fast — gives statistical smoothing that the
>   small real-CLI run can't.
> - Concurrency scenario: launch e.g. 20 instances' first request
>   simultaneously via `Promise.all`, with an identical prefix, and assert
>   `barrier.enabled` collapses `cacheWrites` to 1 vs. N with it disabled.

Spec, "Architecture" file layout (relevant subset): `test/e2e/layers.ts`,
`test/e2e/fixtures/session-turns.ts`, `test/e2e/synthetic/stub-upstream.ts`,
`test/e2e/synthetic/run-synthetic.ts`, `test/e2e/results/` gitignored.
Spec, "Invocation": `npm run e2e:synthetic` — free, no gating, safe to run
any time. Spec, "Error handling": "if a `claude` subprocess or synthetic
request errors, that instance/turn is recorded as failed (not silently
dropped)". Spec, "Testing the harness code itself": orchestration scripts
"are scripts, not vitest suites"; "the stub-upstream cache simulation ...
gets regular vitest unit tests alongside the existing `test/*.test.ts`
suite".

### Verified codebase assumptions

- verified: `src/config.ts:40-46` — `CacheAssemblerConfig` accepts partial
  `canonicalize/breakpoints/deferral/barrier/telemetry`; `src/config.ts:48-58` —
  defaults have `canonicalize`, `breakpoints`, `barrier`, `telemetry` all
  `enabled: true` and `deferral {enabled:false, dryRun:true, extractors:[]}`.
  Therefore L1/L2 layer configs MUST explicitly set `breakpoints.enabled=false`
  / `barrier.enabled=false` — relying on defaults would silently give L3.
- verified: `src/server.ts:153-158` — `createProxyServer({upstream, config,
  barrier, telemetry, state})` returns a `node:http` Server; proxies POST
  `/v1/messages` (`src/server.ts:27,35-37`); GET `/stats` returns
  `telemetry.stats()` (`src/server.ts:231-234`). Barrier enter/firstByte wiring
  at `src/server.ts:183-210` keys on `assemble()`'s report prefixHash — N
  byte-identical concurrent requests share one hash, so leader/follower
  collapse works through the real proxy.
- verified: `src/telemetry.ts:141-235` — `TelemetryStore.record({prefixHash,
  usage})` increments `cacheWrites` when `usage.cache_creation_input_tokens > 0`
  and `cacheReads` when `cache_read_input_tokens > 0` (lines 165-178);
  `stats().estSavedUsd` implements the pricing formula (lines 213-233:
  `estLostUsd = (creationTokens*writePrice − totalCacheTokens*basePrice)/1e6`,
  `estSavedUsd = readTokens*readPrice/1e6 − estLostUsd`). The harness MUST
  compute `estSavedUsd` by feeding usage into a fresh `TelemetryStore` per
  layer — never reimplement the math. `canonicalPrefix` is optional
  (`src/telemetry.ts:13,175-178`) so `record()` works with just
  `{prefixHash, usage}`.
- verified: `src/types.ts:43-48` — `Usage = {input_tokens, cache_creation_input_tokens?, cache_read_input_tokens?}`.
- verified: `src/breakpoints.ts:43-114` — F2 places up to `maxSlots−existing`
  breakpoints in priority order: last tool (line 60-72), last system block
  (line 74-86), then final content block of `messages[messages.length−2]`
  **only when that message's `content` is a block array, not a string**
  (line 90-107: `typeof stableMessage.content !== 'string'` guard). The
  fixture's messages must therefore use `content: [{type:'text',text:...}]`
  block arrays or the 'message' placement never fires.
- verified: `src/deferral.ts:75-100` — `defer()` with `dryRun:true` returns the
  ORIGINAL `req` (line 91-93, bytes unchanged — L4 metrics are expected ≈ L3);
  with `dryRun:false` it strips extractor matches and appends one relocation
  block to the LAST message (line 95-99) — which sits after every breakpoint
  boundary, so stable segments become instance-invariant.
- verified: `src/presets.ts:80` — `export function loadPreset(nameOrPath: string): Preset`;
  built-in name `"claude-code"` resolves to `presets/claude-code.json`
  (`src/presets.ts:21-29`). Preset extractors (`presets/claude-code.json:5-21`)
  target `system[*].text` (scratchpad UUID path, `session-id: <uuid>`) and
  `tools[*].description` (`https://claude.ai/code/session_...`).
- verified: `test/fixtures/claude-code-session.json:1-31` — realistic session
  shape to adapt: 2 system text blocks (scratchpad path reminder, session-id
  line), 2 tools (`read_file`, `browse_session` whose description carries the
  volatile session URL), messages. All three volatile spans match the preset
  patterns. Its messages use plain-string content — the new fixture must
  convert these to block arrays (see breakpoints note above).
- verified: `package.json:21-25` — scripts today are only `type-check`,
  `test:unit`, `build`; no `e2e:*` scripts exist yet; devDependencies have no
  TS runner (`node_modules/.bin` contains only nanoid/rolldown/tsc/tsserver/
  vite/vitest/why-is-node-running). Node is v22.23.1, but src imports use
  `.js` specifiers (NodeNext) which Node's native type-stripping cannot map to
  `.ts` files — so the runner must be `tsx` (new devDependency; npm registry
  reachable, iteration 1 installed 51 packages).
- verified: `.gitignore` already contains `test/e2e/results/` — no gitignore
  change needed.
- verified: `vitest.config.ts:5` — include pattern `test/**/*.test.ts`, so
  `test/e2e/synthetic/stub-upstream.test.ts` is picked up by `npm run
  test:unit` automatically, while `run-synthetic.ts` (not `*.test.ts`) stays
  excluded, matching the spec's "scripts, not vitest suites" rule.
- verified: `scratchpads/e2e-real-metrics-micro-1.md` + git log `b746dd6` —
  criterion 1 (tsconfig inlining) already landed; `npm run type-check` is the
  regression guard for this iteration. Do NOT touch tsconfig files.

### Design decisions resolved now (no executor judgment calls)

1. **Stub cache simulation is breakpoint-anchored** (mirrors real Anthropic
   semantics: no `cache_control` → no caching). Pure function
   `simulateUsage(rawBody: string, seen: Set<string>, commit: boolean)`:
   parse body; collect breakpoints in prefix order — every `tools[i]` with
   `cache_control`, every `system[i]` with `cache_control`, every message
   whose content-block array contains `cache_control`; for each breakpoint
   compute a sha256 (reuse `node:crypto` directly) over
   `JSON.stringify({tools: tools.slice(0,i+1)})` /
   `JSON.stringify({tools, system: system.slice(0,i+1)})` /
   `JSON.stringify({tools, system, messages: messages.slice(0,i+1)})`
   respectively. The LONGEST segment whose hash is in `seen` yields
   `cache_read_input_tokens = ceil(readSegment.length/4)`; the byte delta from
   the read segment up to the LAST breakpoint segment yields
   `cache_creation_input_tokens = ceil((lastSegLen − readSegLen)/4)`;
   `input_tokens = ceil((rawBody.length − lastSegLen)/4)`. No breakpoints →
   `{input_tokens: ceil(rawBody.length/4)}` only. When `commit` is true, all
   segment hashes are added to `seen`.
2. **Delayed-commit for the concurrency race**: the HTTP wrapper
   `createStubUpstream({responseDelayMs})` does, per request: read body →
   `simulateUsage(body, seen, /*commit*/ false)` snapshot → `await
   delay(responseDelayMs)` → add the request's segment hashes to `seen` →
   respond. This makes barrier-OFF deterministic: N simultaneous requests all
   snapshot an empty `seen` inside the delay window → N writes; barrier-ON
   holds followers until the leader's first response byte, which is emitted
   strictly after the leader's commit → 1 write, N−1 reads. Layer runs use
   `responseDelayMs: 0` (sequential turns; keeps 6-layer runs fast);
   concurrency runs use `responseDelayMs: 100`.
3. **Metrics are recorded client-side, uniformly for all layers**: the harness
   parses each stub/proxy response's JSON `usage` and feeds
   `store.record({prefixHash: <sha256 of sent body>, usage})` into a fresh
   `TelemetryStore` per layer/run. L0 (no proxy) and L1-L5 (through
   `createProxyServer`) therefore use identical metric math.
   `cacheHitRate = stats.cacheReads / stats.requests` (0 when requests is 0);
   `estSavedUsd = stats.estSavedUsd`.
4. **Stub response body** is plain JSON:
   `{id, type:'message', role:'assistant', content:[{type:'text',text:'ok'}], usage:{...}}`
   with status 200 — parseable by both the harness and the proxy's
   `extractUsage` (`src/server.ts:78-104`).
5. **Runner**: add `tsx` devDependency;
   `"e2e:synthetic": "tsx test/e2e/synthetic/run-synthetic.ts"`. Arg parsing
   via `node:util` `parseArgs` (`--instances`, `--out`, `--concurrency`,
   `--turns` optional). Defaults: instances 30, concurrency 8,
   out `test/e2e/results/synthetic.json`, turns 6. `mkdir -p` the out dir
   before writing.
6. **Layer configs** (explicit, every toggle set — never rely on defaults):
   - L0: `proxy: false` (requests go straight to the stub, raw fixture bytes)
   - L1: `{canonicalize:{enabled:true}, breakpoints:{enabled:false}, deferral:{enabled:false}, barrier:{enabled:false}}`
   - L2: L1 + `breakpoints:{enabled:true}`
   - L3: L2 + `barrier:{enabled:true}` (= library defaults)
   - L4: L3 + `deferral:{enabled:true, dryRun:true, extractors: loadPreset('claude-code').extractors}`
   - L5: L4 but `dryRun:false`
7. **Per-layer isolation, per-layer sharing**: fresh stub server (fresh `seen`
   Map), fresh proxy, fresh `TelemetryStore` per layer; all instances within a
   layer share that stub, so L5's cross-instance F3 uplift is observable.
   Instances run sequentially, turns sequentially. Servers `listen(0)`
   (ephemeral ports) and are closed after each layer.
8. **Concurrency scenario** (runs after the layer loop): build ONE turn-1
   request body (fixed volatile params), send the identical body
   `--concurrency` times via `Promise.all` through a fresh stub
   (`responseDelayMs:100`) + proxy, once with L3's config (barrier on), once
   with L2's config (barrier off), each with fresh stub/proxy/store. Output
   `{instances, barrierOnWrites, barrierOffWrites}` from each run's
   `stats().cacheWrites`.
9. **Output JSON shape** (superset of what the rubric checks):
   `{generatedAt, instances, turns, layers: {L0..L5: {label, cacheHitRate, estSavedUsd, requests, cacheReads, cacheWrites, cacheReadTokens, cacheCreationTokens, failures}}, concurrency: {instances, barrierOnWrites, barrierOffWrites}}`.
   Per spec error handling, each turn request is try/caught and counted in
   `failures` rather than silently dropped; the script exits non-zero if any
   layer recorded zero successful requests.
10. **Fixture** `test/e2e/fixtures/session-turns.ts`: export
    `buildSessionTurns(params: {scratchpadUuid, sessionId, sessionUrl}, turns = 6): AnthropicRequestLike[]`
    — adapts `test/fixtures/claude-code-session.json` (same 2 system blocks
    with the volatile spans templated in, same 2 tools with the volatile
    session URL templated in), messages as text-block ARRAYS (not strings),
    turn k's body containing messages `[u1,a1,...,u_k]` (2k−1 messages) with a
    couple hundred chars of deterministic coding-task text per message. Also
    export `defaultVolatileParams(instanceIndex: number)` generating
    deterministic per-instance UUIDs/URLs that match the three preset regexes
    verbatim (`scratchpad/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
    `session-id:\s*[0-9a-f-]{36}`, `https://claude\.ai/code/session_[A-Za-z0-9_-]+`).
    Real-CLI prompt-string export is deferred to the real-CLI iteration.
11. **Criterion 6 scope**: `test/e2e/synthetic/stub-upstream.test.ts` IS
    included in this iteration (the simulation logic is pure and easy to get
    subtly wrong). `test/e2e/report/build-report.test.ts` is NOT — criterion 6
    remains open until the report-builder iteration delivers it.

## Steps

Step 1/4: Implement: `test/e2e/fixtures/session-turns.ts` (per decision 10)
and `test/e2e/layers.ts` exporting
`LAYERS: ReadonlyArray<{id:'L0'|...|'L5', label:string, proxy:boolean, config:CacheAssemblerConfig}>`
with exactly the six configs from decision 6 (L4/L5 extractors via
`loadPreset('claude-code').extractors` from `../../src/presets.js`
— import paths use `.js` specifiers like the rest of the repo). Also update
`package.json`: add `"tsx": "^4.19.2"` to devDependencies, add script
`"e2e:synthetic": "tsx test/e2e/synthetic/run-synthetic.ts"`, and run
`npm install`.
needs: nothing prior — criterion 1's inlined tsconfigs (commit b746dd6) are
already on the branch.
on-failure: npm install unreachable or tsx resolution broken → revert
package.json changes and STOP and report (runner choice needs revisiting).

Step 2/4: Implement: `test/e2e/synthetic/stub-upstream.ts` — pure exported
`simulateUsage(rawBody, seen, commit)` + `collectSegments(rawBody)` helpers
implementing decision 1 exactly, and `createStubUpstream(options: {responseDelayMs?: number})`
returning `{server, url(), seen, requestsReceived, close()}` implementing the
delayed-commit ordering of decision 2 (snapshot lookup on receipt → delay →
commit → respond with decision-4 body). Handles only POST with a JSON body;
anything else → 400 JSON error (fail-closed, counted by the harness as a
turn failure).
needs: nothing from step 1 (standalone module; only imports `node:http`,
`node:crypto`).
on-failure: STOP and report — every later step depends on this module's
semantics.

Step 3/4: Implement: `test/e2e/synthetic/run-synthetic.ts` — parseArgs CLI
(decision 5); layer loop implementing decisions 3/6/7 (L0 posts fixture
bodies straight to the stub; L1-L5 post to a `createProxyServer({upstream:
stubUrl, config: layer.config})` instance listening on an ephemeral port,
path `/v1/messages`); concurrency scenario per decision 8; writes the
decision-9 JSON to `--out` (mkdir -p first); per-turn try/catch failure
counting; exits 0 on success, non-zero with a message if any layer had zero
successful requests or the JSON write fails. All imports from `../../../src/*.js`
(server, telemetry, presets) and `../fixtures/session-turns.js` / `../layers.js`.
needs: step 1's fixture + layers modules and package.json script/tsx install;
step 2's stub module.
on-failure: if `npm run e2e:synthetic -- --instances 2 --out
test/e2e/results/synthetic.json` fails, fix within this step (it is the
criterion under construction); if the barrier-on run does not produce fewer
writes than barrier-off after one focused fix attempt, STOP and report with
the captured JSON (do not weaken the stub's delayed-commit to force a pass).

Step 4/4: Implement: `test/e2e/synthetic/stub-upstream.test.ts` — vitest unit
tests for the pure simulation logic: (a) body with no `cache_control`
breakpoints → usage has `input_tokens` only, nothing enters `seen`;
(b) first sight of a breakpointed body with commit → `cache_creation_input_tokens > 0`,
`cache_read_input_tokens` 0/absent, hashes committed; (c) identical body seen
again → `cache_read_input_tokens > 0` and `cache_creation_input_tokens: 0`;
(d) longest-prefix selection: a body sharing only the tools-segment with a
previously committed body reads the tools segment and writes the delta;
(e) `commit:false` leaves `seen` unchanged (the delayed-commit snapshot
contract). Then run full validation: `npm run type-check`,
`npx vitest run`, and the verbatim criterion-2 verify command.
needs: step 2's exported pure functions; step 3 landed (so the criterion-2
verify command can run against the real script).
on-failure: a failing test here means the stub logic is wrong — fix
`stub-upstream.ts`, never weaken the assertion; if type-check regresses,
revert the offending file to the prior commit and re-apply minimally.

Regression guard (applies to every step): `npm run type-check` must stay
green (criterion 1); the existing `npx vitest run` suite (12 files under
`test/`) must stay 100% passing; no changes to `src/**`, `tsconfig*.json`,
`vitest.config.ts`, or existing tests; the only `package.json` changes are
the one script line and the tsx devDependency.

## Acceptance Criteria

- [ ] Rubric criterion 2 passes end-to-end (all six layers present with
      numeric `cacheHitRate`/`estSavedUsd`, concurrency proof demonstrates
      barrier dedup)
  verify: `npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json && node -e "
const r = require('./test/e2e/results/synthetic.json');
const layers = ['L0','L1','L2','L3','L4','L5'];
for (const l of layers) {
  if (!r.layers?.[l] || typeof r.layers[l].cacheHitRate !== 'number' || typeof r.layers[l].estSavedUsd !== 'number') {
    console.error('missing/invalid layer: ' + l); process.exit(1);
  }
}
if (!r.concurrency || !(r.concurrency.barrierOnWrites < r.concurrency.barrierOffWrites)) {
  console.error('concurrency proof missing or not demonstrating dedup'); process.exit(1);
}
console.log('ok');
"`
- [ ] Caching genuinely turns on at L2 and F3-active beats F1-only baseline
      (stub proof is functional, not canned): L0 and L1 hit rate 0, L2 > 0,
      L5 ≥ L2
  verify: `node -e "
const r = require('./test/e2e/results/synthetic.json'); const L = r.layers;
if (L.L0.cacheHitRate !== 0 || L.L1.cacheHitRate !== 0) { console.error('L0/L1 should not cache'); process.exit(1); }
if (!(L.L2.cacheHitRate > 0)) { console.error('L2 must enable caching'); process.exit(1); }
if (!(L.L5.cacheHitRate >= L.L2.cacheHitRate)) { console.error('L5 must not regress vs L2'); process.exit(1); }
console.log('ok');
"`
- [ ] Type-check stays green (criterion 1 regression guard, new files
      included via tsconfig's `test/**/*.ts` include)
  verify: `npm run type-check`
- [ ] Stub-upstream unit tests exist and the FULL vitest suite (existing 12
      files + new one) passes
  verify: `test -f test/e2e/synthetic/stub-upstream.test.ts && npx vitest run`
- [ ] Harness scripts stay out of the unit-test collection (spec: "scripts,
      not vitest suites")
  verify: `npx vitest list 2>/dev/null | grep -c "run-synthetic" | grep -qx 0 && echo ok`
