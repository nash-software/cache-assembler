---
status: in-progress
spec_ref: docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md
files:
  - test/e2e/report/build-report.ts
  - test/e2e/report/template.html
  - test/e2e/report/build-report.test.ts
  - package.json
---

# Micro-plan 3: Report builder — self-contained HTML with SVG charts

## Context

Rubric criterion 3 (`scratchpads/e2e-real-metrics-goal.md`), quoted verbatim:

> 3. **Report builder produces a self-contained HTML report** (no external
>    script/link resources) with the cache-hit-rate chart, $-saved chart, raw
>    numbers table, and concurrency-proof section
>    verify:
>    ```sh
>    npm run e2e:report && node -e "
>    const fs = require('fs');
>    const h = fs.readFileSync('test/e2e/results/report.html', 'utf8');
>    if (/<script src=|<link[^>]+href=\"https?:/.test(h)) { console.error('report references external resources'); process.exit(1); }
>    const need = ['cache-hit-rate', 'saved', 'concurrency'];
>    for (const k of need) if (!h.toLowerCase().includes(k)) { console.error('missing section: ' + k); process.exit(1); }
>    console.log('ok');
>    "
>    ```

Rubric criterion 6 (partial — this iteration delivers the second half), quoted
verbatim:

> 6. **New pure-logic unit tests exist and pass** (stub-upstream cache
>    simulation, report aggregation math), alongside the existing suite
>    verify:
>    ```sh
>    test -f test/e2e/synthetic/stub-upstream.test.ts && test -f test/e2e/report/build-report.test.ts && npx vitest run test/e2e/synthetic/stub-upstream.test.ts test/e2e/report/build-report.test.ts
>    ```

Spec, "### Report" section, quoted verbatim:

> `build-report.ts` reads whichever of `results/synthetic.json` /
> `results/real-cli.json` exist, computes per-layer aggregates (mean
> cache-hit-rate, mean modeled $ saved using the same pricing formula as
> `src/telemetry.ts`, and — for the real run only — actual $ spent), and
> renders one self-contained HTML file: a bar chart of cache-hit-rate by layer,
> a bar chart of $ saved by layer, a raw-numbers table, and a concurrency-proof
> section (write count before/after). No new runtime dependency — charts are
> hand-rolled inline SVG. Real-CLI numbers headline where available; synthetic
> numbers back them up at higher N.

Spec, "Architecture" tree (relevant subset): `test/e2e/report/build-report.ts`
("Merges synthetic + real JSON into one HTML report"),
`test/e2e/report/template.html` ("Report shell (inline SVG bar charts, no new
deps)"), `test/e2e/results/` gitignored. Spec, "Invocation":
"`npm run e2e:report` — builds `results/report.html` from whichever result
files exist". Spec, "Architecture" intro: "Two independent test harnesses
producing a common JSON result shape" — so `real-cli.json` (future iteration)
will share the per-layer shape below; the report must render sensibly TODAY
with only `synthetic.json` present. Spec, "Error handling": "the report
surfaces a failure count per layer rather than only showing successful-run
averages". Spec, "Testing the harness code itself": `build-report.ts` is a
script "excluded from the default `npm run test:unit`", but "the per-layer
aggregation math in the report builder" gets "regular vitest unit tests".

### Verified codebase assumptions

- verified: actual `test/e2e/results/synthetic.json` (generated 2026-07-16 by
  `npm run e2e:synthetic -- --instances 2`) — top level is `{generatedAt,
  instances, turns, layers, concurrency}`; each `layers.L0..L5` is `{label,
  cacheHitRate, estSavedUsd, requests, cacheReads, cacheWrites,
  cacheReadTokens, cacheCreationTokens, failures}`; `concurrency` is
  `{instances, barrierOnWrites, barrierOffWrites}`. Matching TypeScript
  interfaces `LayerResult` / `ConcurrencyResult` / `SyntheticOutput` at
  `test/e2e/synthetic/run-synthetic.ts:31-55`.
- verified: `test/e2e/synthetic/run-synthetic.ts:31-55` — those interfaces are
  **not exported**, and the script calls `main()` unguarded at top level
  (`run-synthetic.ts:269`), so build-report.ts must NOT import anything from
  it (importing would execute the whole synthetic run). The report module
  defines its own structurally-identical input types.
- verified: real observed values build-report must reproduce — L2:
  `cacheHitRate 0.8333…`, `estSavedUsd -0.010227` (NEGATIVE — the $-saved
  chart must handle negative bars), tokens read 1770 / creation 5356; L5:
  `estSavedUsd 0.0055806`, tokens read 4072 / creation 2619; L0/L1 all zeros;
  `concurrency {instances: 8, barrierOnWrites: 1, barrierOffWrites: 8}`.
- verified: `src/telemetry.ts:52-60` — pricing constants, verbatim:
  `TOKENS_PER_MTOK = 1_000_000`, `DEFAULT_BASE_PRICE_PER_MTOK = 3`,
  `CACHE_READ_PRICE_MULTIPLIER = 0.1`, `CACHE_WRITE_PRICE_MULTIPLIER = 2`
  (read price = base×0.1, write price = base×2, `src/telemetry.ts:156-160`).
- verified: `src/telemetry.ts:213-222` — the pricing formula, verbatim:
  `estLostUsd = (cacheCreationTokens * cacheWritePricePerMTok − (cacheCreationTokens + cacheReadTokens) * basePricePerMTok) / TOKENS_PER_MTOK`;
  `estSavedUsd = (cacheReadTokens * cacheReadPricePerMTok) / TOKENS_PER_MTOK − estLostUsd`.
  The formula is **linear in the two token totals**, so feeding one aggregate
  usage record into a fresh `TelemetryStore` yields exactly the same
  `estSavedUsd` as the per-request sum — cross-checked by hand against the
  recorded JSON: (1770×0.3 − (5356×6 − 7126×3))/1e6 = **−0.010227** = L2's
  recorded value; (4072×0.3 − (2619×6 − 6691×3))/1e6 = **0.0055806** = L5's.
- verified: `src/telemetry.ts:165-178` — `record({prefixHash, usage})` works
  without `canonicalPrefix` (stability tracking skipped), so the aggregate
  single-record trick needs only `{prefixHash: 'aggregate', usage: {…}}`.
- verified: `src/telemetry.ts:141` + `src/types.ts:43-48` — `TelemetryStore`
  and `Usage` are exported; import paths use `.js` specifiers
  (`../../../src/telemetry.js`) like the rest of the repo.
- verified: `package.json:21-26` — script pattern to copy:
  `"e2e:synthetic": "tsx test/e2e/synthetic/run-synthetic.ts"`; `tsx ^4.19.2`
  already a devDependency (installed iteration 2). New script is one line:
  `"e2e:report": "tsx test/e2e/report/build-report.ts"`.
- verified: live check under tsx (scratchpad `guard-check.ts`, this session) —
  `process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href`
  evaluates **true** when run via `tsx <file>` and false when the module is
  merely imported (vitest), so build-report.ts can safely carry a guarded
  `main()` in the same file the tests import — matching the spec's two-file
  `report/` layout (no third entry file).
- verified: `vitest.config.ts:5` — include pattern `test/**/*.test.ts`, so
  `test/e2e/report/build-report.test.ts` joins `npm run test:unit`
  automatically while `build-report.ts` stays excluded.
- verified: `.gitignore` already contains `test/e2e/results/` — `report.html`
  lands there, no gitignore change needed.
- verified: `test/e2e/results/real-cli.json` does NOT exist at this point in
  the loop (only `synthetic.json`; real-CLI harness is criteria 4/5, a future
  iteration) — the synthetic-only rendering path is the one criterion 3's
  verify command will actually exercise.

### Design decisions resolved now (no executor judgment calls)

1. **Pure, import-safe module shape** (`test/e2e/report/build-report.ts`):
   - Local interfaces `LayerResult`, `ConcurrencyResult`, `HarnessOutput`
     (structural copies of `run-synthetic.ts:31-55` — see verified note on why
     they cannot be imported), all `export`ed.
   - `export interface ReportInput { synthetic?: HarnessOutput; real?: HarnessOutput }`
   - `export function computeEstSavedUsd(cacheReadTokens: number, cacheCreationTokens: number): number`
     — creates a fresh `TelemetryStore()` (default pricing), calls
     `store.record({prefixHash: 'aggregate', usage: {input_tokens: 0,
     cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens:
     cacheCreationTokens}})`, returns `store.stats().estSavedUsd`. NEVER
     reimplement the formula — linearity (verified above) makes this exact.
   - `export function computeCacheHitRate(l: LayerResult): number` —
     `l.requests === 0 ? 0 : l.cacheReads / l.requests` (same rule as
     `run-synthetic.ts:167`).
   - `export function renderBarChart(rows: ReadonlyArray<{label: string; value: number}>, opts: {title: string; format: (v: number) => string}): string`
     — hand-rolled inline `<svg>` string; domain `[min(0, …values),
     max(0, …values)]` with a drawn zero-baseline axis so NEGATIVE values
     (L2's −0.010227) render as bars below the line; value labels via
     `opts.format`; no rounding tricks that could NaN on all-zero input
     (all-zero domain → flat bars at baseline, not division by zero).
   - `export function buildReportHtml(input: ReportInput): string` — loads
     `template.html` via `readFileSync(new URL('./template.html', import.meta.url), 'utf8')`
     and substitutes a single `<!--REPORT_BODY-->` placeholder with the
     rendered sections. Throws if BOTH `synthetic` and `real` are undefined.
2. **Sections rendered per harness block** (real first when present —
   "Real-CLI numbers headline where available"; synthetic block follows,
   titled with its N: `Synthetic (N=<instances> instances × <turns> turns)`):
   (a) `<h2>Cache-hit-rate by layer</h2>` + `renderBarChart` over L0..L5 using
   `computeCacheHitRate`, formatted as percent; (b) `<h2>$ saved by layer
   (modeled)</h2>` + `renderBarChart` using
   `computeEstSavedUsd(l.cacheReadTokens, l.cacheCreationTokens)`, formatted
   `$x.xxxxxx`; (c) raw-numbers `<table>` with columns label / requests /
   cacheReads / cacheWrites / cacheReadTokens / cacheCreationTokens /
   estSavedUsd / **failures** (spec error-handling requirement); (d)
   `<h2>Concurrency proof</h2>` — instances, `barrierOnWrites` vs
   `barrierOffWrites`, and a pass/fail sentence (`barrierOnWrites <
   barrierOffWrites` → "barrier collapsed N concurrent identical-prefix
   writes to 1"). Section keywords `cache-hit-rate`, `saved`, `concurrency`
   thereby appear verbatim (lowercased) — satisfying the criterion's `need`
   scan. When `real` is absent, render a muted note: `Real-CLI results not
   present — run npm run e2e:real -- --confirm to add them.` Layer iteration
   order is fixed `['L0','L1','L2','L3','L4','L5']`, skipping ids missing
   from `layers` (future real runs may cover fewer layers via `--layers`).
3. **Template** (`test/e2e/report/template.html`): full HTML5 shell — inline
   `<style>` only, ZERO `<script>` tags of any kind, ZERO `<link>` tags
   (self-containment is structural, not just regex-passing), `<title>`
   cache-assembler E2E report, one `<!--REPORT_BODY-->` placeholder. All
   dynamic text passes through an `escapeHtml` helper in build-report.ts
   (labels come from JSON; escape `&<>"`).
4. **Guarded CLI entry in the same file** (verified tsx guard above):
   `main()` runs only when `import.meta.url === pathToFileURL(process.argv[1]).href`.
   `main()`: resolve `results/` as `new URL('../results/', import.meta.url)`
   (cwd-independent); read `synthetic.json` and `real-cli.json` — each parsed
   if present, `undefined` if missing (catch ENOENT only; a present-but-
   malformed JSON is a real error and must throw); if neither exists, print
   `no result files found — run npm run e2e:synthetic first` and set
   `process.exitCode = 1`; else `mkdir -p` the results dir, write
   `report.html` there, log the path. No CLI flags needed this iteration
   (criterion invokes bare `npm run e2e:report`).
5. **npm script**: add `"e2e:report": "tsx test/e2e/report/build-report.ts"`
   to `package.json` scripts — the ONLY package.json change; no new
   dependencies (spec: "No new runtime dependency").
6. **Unit-test scope** (`test/e2e/report/build-report.test.ts`) — aggregation
   math and rendering invariants, pinned to the verified real values:
   (a) `computeEstSavedUsd(1770, 5356)` ≈ −0.010227 and
   `computeEstSavedUsd(4072, 2619)` ≈ 0.0055806 (toBeCloseTo, 6 digits —
   proves the TelemetryStore formula is reused, not re-derived);
   (b) `computeEstSavedUsd(0, 0)` = 0; (c) `computeCacheHitRate` on
   `requests: 0` → 0 (no NaN); (d) `buildReportHtml({synthetic})` with a
   fixture literal shaped like the verified synthetic.json: contains
   `cache-hit-rate`, `saved`, `concurrency` (lowercased), contains NO
   `<script` and NO `<link`, contains the "Real-CLI results not present" note,
   renders the negative L2 bar without `NaN` anywhere in the output;
   (e) `buildReportHtml({synthetic, real})` puts the real block before the
   synthetic block (indexOf ordering); (f) `buildReportHtml({})` throws.
   Test fixture data is an inline literal in the test file — tests must not
   read `test/e2e/results/` (gitignored, absent on fresh checkouts).

## Steps

Step 1/3: Implement: `test/e2e/report/template.html` (decision 3) and the pure
exports of `test/e2e/report/build-report.ts` (decisions 1-2): types,
`escapeHtml`, `computeEstSavedUsd`, `computeCacheHitRate`, `renderBarChart`,
`buildReportHtml`. Imports: `TelemetryStore` from `../../../src/telemetry.js`,
`readFileSync` from `node:fs`, `URL` via `import.meta.url` — nothing from
`run-synthetic.ts` (unguarded top-level main, see verified notes).
needs: nothing prior — iteration 2's harness (commits 2391480..b0fff1b) and
`tsx` are already on the branch.
on-failure: if `TelemetryStore` aggregate-record reuse cannot reproduce the
recorded `estSavedUsd` values exactly (toBeCloseTo 6 digits), STOP and report
with both numbers — do NOT fall back to reimplementing the formula inline.

Step 2/3: Implement: the guarded `main()` in `build-report.ts` (decision 4)
and the `package.json` script line `"e2e:report": "tsx test/e2e/report/build-report.ts"`
(decision 5). Manually exercise both paths: `npm run e2e:report` against the
existing `test/e2e/results/synthetic.json` must exit 0 and write
`test/e2e/results/report.html`; then with `results/` temporarily emptied
(`mv test/e2e/results /tmp/… && mkdir test/e2e/results`, restore after) it
must exit non-zero with the "no result files" message.
needs: step 1's `buildReportHtml` export; existing `synthetic.json` from the
iteration-2 harness (regenerate via
`npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json`
if the workspace was cleaned).
on-failure: if the tsx main-guard misfires (main runs under vitest import or
fails to run under `npm run e2e:report`), revert to prior commit and STOP and
report — the guard behavior was live-verified this session, so a misfire
means an environment change worth surfacing, not patching around.

Step 3/3: Implement: `test/e2e/report/build-report.test.ts` per decision 6
(inline fixture literal, never reads `test/e2e/results/`). Then run full
validation: `npm run type-check`; `npx vitest run` (existing suite + new
file, 100%); the verbatim criterion-3 verify command; the verbatim
criterion-6 verify command.
needs: steps 1-2 landed (tests import the pure exports; criterion-3 command
runs the real npm script).
on-failure: a failing aggregation test means `computeEstSavedUsd` or the
renderer is wrong — fix `build-report.ts`, never loosen `toBeCloseTo`
precision or the assertion; if type-check or the existing suite regresses,
revert the offending file to the prior commit and re-apply minimally.

Regression guard (applies to every step): `npm run type-check` stays green
(criterion 1); `npm run e2e:synthetic -- --instances 2 --out
test/e2e/results/synthetic.json` plus the criterion-2 node check stays green
(criterion 2 — no changes to `test/e2e/synthetic/**`, `test/e2e/layers.ts`,
`test/e2e/fixtures/**`); the full `npx vitest run` suite stays 100% passing;
no changes to `src/**`, `tsconfig*.json`, `vitest.config.ts`, `.gitignore`,
or the rubric file (chmod 444); the only `package.json` change is the one
`e2e:report` script line. Out of scope: the real-CLI harness (criteria 4/5),
`test/e2e/README.md` (Should Pass, later iteration), the untracked
`test/e2e/layers.test.ts` / `test/e2e/fixtures/session-turns.test.ts` /
`scratchpads/tester-coverage-gaps-plan.md` files from a parallel tester
session — leave them untouched.

## Acceptance Criteria

- [ ] Rubric criterion 3 passes end-to-end (self-contained HTML with
      cache-hit-rate chart, $-saved chart, raw table, concurrency section)
  verify: `npm run e2e:report && node -e "
const fs = require('fs');
const h = fs.readFileSync('test/e2e/results/report.html', 'utf8');
if (/<script src=|<link[^>]+href=\"https?:/.test(h)) { console.error('report references external resources'); process.exit(1); }
const need = ['cache-hit-rate', 'saved', 'concurrency'];
for (const k of need) if (!h.toLowerCase().includes(k)) { console.error('missing section: ' + k); process.exit(1); }
console.log('ok');
"`
- [ ] Report is structurally self-contained and honest about missing real-CLI
      data: zero `<script`/`<link` tags at all (stronger than the criterion
      regex), and the synthetic-only run notes real results are absent
  verify: `node -e "
const h = require('fs').readFileSync('test/e2e/results/report.html','utf8');
if (/<script|<link/i.test(h)) { console.error('script/link tag present'); process.exit(1); }
if (!/real-cli results not present/i.test(h)) { console.error('missing real-absent note'); process.exit(1); }
if (/NaN/.test(h)) { console.error('NaN leaked into report'); process.exit(1); }
console.log('ok');
"`
- [ ] Rubric criterion 6 passes in full (both pure-logic test files exist and
      pass — stub-upstream from iteration 2, report aggregation from this one)
  verify: `test -f test/e2e/synthetic/stub-upstream.test.ts && test -f test/e2e/report/build-report.test.ts && npx vitest run test/e2e/synthetic/stub-upstream.test.ts test/e2e/report/build-report.test.ts`
- [ ] Aggregation math reuses the telemetry pricing formula exactly
      (recomputation from token counts reproduces the recorded per-layer
      `estSavedUsd`, including the negative L2 value)
  verify: `npx vitest run test/e2e/report/build-report.test.ts`
- [ ] Regression guard: type-check green, full suite 100%, synthetic harness
      (criterion 2) unaffected
  verify: `npm run type-check && npx vitest run && npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json`
- [ ] Report script stays out of the unit-test collection (spec: "scripts,
      not vitest suites") while its test file is collected
  verify: `npx vitest list 2>/dev/null | grep -v "build-report.test.ts" | grep -c "build-report" | grep -qx 0 && npx vitest list 2>/dev/null | grep -q "build-report.test.ts" && echo ok`
