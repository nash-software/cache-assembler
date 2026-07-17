---
status: in-progress
spec_ref: docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md
files:
  - test/e2e/real-cli/run-real-cli.ts
  - test/e2e/real-cli/run-real-cli.test.ts
  - package.json
---

# Micro-plan 4: Real-CLI harness — `--confirm` safety rail + `--dry-run` orchestration

## Context

Rubric criterion 4 (`scratchpads/e2e-real-metrics-goal.md`), quoted verbatim:

> 4. **Real-CLI harness refuses to run without `--confirm`** (safety rail — no
>    subprocess spawn, no network call)
>    verify:
>    ```sh
>    OUT=$(npm run e2e:real 2>&1); CODE=$?
>    test $CODE -ne 0 && echo "$OUT" | grep -qi "confirm"
>    ```

Rubric criterion 5, quoted verbatim (bundled — natural byproduct of the same
script; criterion 4 is the formal target per the iteration-3 memory close-out):

> 5. **Real-CLI harness `--dry-run` exercises full orchestration logic without
>    live credentials** (layer iteration, instance/turn counts, budget-estimate
>    printing, against a stubbed `claude` executable — never the real network)
>    verify:
>    ```sh
>    OUT=$(npm run e2e:real -- --dry-run --confirm --layers L0,L1,L2,L3,L4,L5 2>&1); CODE=$?
>    test $CODE -eq 0 || exit 1
>    for L in L0 L1 L2 L3 L4 L5; do echo "$OUT" | grep -q "$L" || exit 1; done
>    echo ok
>    ```

Spec, "Real-CLI harness" section, quoted verbatim:

> - Each "instance" is one long-lived
>   `claude -p --input-format stream-json --output-format stream-json --no-session-persistence`
>   child process, fed the shared 5-6 turn session sequentially over stdin
>   (avoids needing `--resume`/session-ID bookkeeping across separate
>   processes). Each turn's real `usage` block is read back from the
>   stream-json output.
> - Defaults to `--model claude-haiku-4-5` to hold cost down — caching
>   mechanics are model-agnostic, so the cheapest model is fine for this
>   purpose. Overridable via `--model`.
> - Default instance count: 3 per layer (configurable, hard-capped in code —
>   see Safety rails).
> - Concurrency scenario: N (default 5) such processes launched together with
>   an identical opening prompt/task, checking the proxy's `/stats.cacheWrites`
>   after all N complete their first turn — expect 1 with the barrier on, N
>   with it off.
> - Requires a working `claude auth login` in the environment it runs in (this
>   harness is meant to be run interactively by a human with valid credentials,
>   not from an unattended/expired-session context).

Spec, "Safety rails (real-CLI harness only)" section, quoted verbatim:

> - Refuses to run without an explicit `--confirm` flag.
> - Hard-caps total instance count in code (default cap: 50 total real CLI
>   invocations across all layers + concurrency scenario); anything above
>   requires an explicit `--force-instances <n>` override.
> - Passes `--max-budget-usd` per child process.
> - Prints an estimated total spend (rough: instances × turns × avg tokens ×
>   Haiku pricing) and requires the user to confirm before executing, unless
>   `--yes` is passed for non-interactive use.
> - The synthetic harness has no such gate — it's free and local-only.

Spec, "Architecture" tree (relevant subset): `test/e2e/real-cli/run-real-cli.ts`
("Orchestrates real `claude` CLI subprocesses"). Spec, "Invocation":
"`npm run e2e:real -- --confirm` — real cost, requires `claude auth login`".
Spec, "Error handling": "if a `claude` subprocess or synthetic request errors,
that instance/turn is recorded as failed (not silently dropped)"; "If the
real-CLI harness's `claude auth status`-equivalent check fails before starting
(no valid session), it exits immediately with a clear message". Spec, "Testing
the harness code itself": `run-real-cli.ts` is a script, "not vitest suites",
excluded from default collection; its pure logic gets regular vitest unit
tests. Spec, "Non-goals": "This is not a CI-gating test suite. It requires
real credentials (for the real-CLI harness) and is invoked manually / on
demand."

**ITERATION SAFETY SCOPE (hard constraint from the loop orchestrator, quoted):**
"this harness must NEVER spawn a real subprocess or make a real network call
unless explicitly confirmed AND not in dry-run mode — and even then, that's
out of scope for THIS iteration (criteria 4/5 only test the refusal rail and
the dry-run path, both of which must be network-free and subprocess-free)."
So THIS iteration ships zero subprocess-spawning code and zero network code:
the live-execution path (real `claude` children, proxy wiring, auth check,
interactive `--yes` prompt, concurrency scenario, `results/real-cli.json`
output) is explicitly deferred — see decision 10 and Out of scope.

### Verified codebase assumptions

- verified: live baseline run this session — `npm run e2e:real` exits 1 today
  (`npm error Missing script: "e2e:real"`) and `grep -qi "confirm"` finds NO
  match, so criterion 4's verify genuinely fails on baseline (baseline-must-
  fail holds; the exit code alone is not enough — the "confirm" message is
  the distinguishing half). Criterion 5 likewise fails (same missing script;
  re-confirmed at iteration-3 close in `scratchpads/memory-e2e-real-metrics.md`).
- verified: file-path discrepancy resolved — the iteration-3 memory note
  guessed `test/e2e/real/run-real.ts`, but the spec's Architecture tree
  (design doc, lines 44-45) says `test/e2e/real-cli/run-real-cli.ts`. The
  spec is authoritative; both rubric criteria check only the npm script name
  (`e2e:real`) and its stdout/exit code, never the file path. This plan uses
  the spec path. `test/e2e/real-cli/` does not exist yet (checked this
  session).
- verified: `package.json:21-27` — script naming pattern to copy:
  `"e2e:synthetic": "tsx test/e2e/synthetic/run-synthetic.ts"`,
  `"e2e:report": "tsx test/e2e/report/build-report.ts"`; `tsx ^4.19.2`
  already a devDependency. New script is one line:
  `"e2e:real": "tsx test/e2e/real-cli/run-real-cli.ts"`. npm propagates the
  script's exit code (baseline run above confirms non-zero propagation).
- verified: `test/e2e/layers.ts:4` exports `LayerId`, `:6-12` `LayerDefinition`,
  `:25` `LAYERS` (all six L0-L5 with labels that BEGIN with the layer id,
  e.g. `'L2 — F1+F2: …'`), `:89-93` `getLayer(id)` which throws on unknown
  ids. The module is import-safe: no top-level side effects beyond
  `loadPreset('claude-code')` (`layers.ts:17`), which only reads a local JSON
  file (`src/presets.ts:21-29,80`) — no network, no subprocess. The harness
  imports its layer matrix from here; it must NOT import anything from
  `run-synthetic.ts` (unguarded top-level `main()` at
  `test/e2e/synthetic/run-synthetic.ts:269` — importing executes the run).
- verified: `src/telemetry.ts:141` exports `TelemetryStore`;
  `record({prefixHash, usage})` works without `canonicalPrefix`
  (`src/telemetry.ts:165-178`, optionality at `:13,175-178` — established in
  micro-plans 2/3 and exercised by the shipped synthetic/report code);
  `stats()` returns `{requests, cacheReads, cacheWrites, cacheReadTokens,
  cacheCreationTokens, estSavedUsd, …}` (`src/telemetry.ts:213-235`).
  `src/types.ts:43-48` exports `Usage = {input_tokens,
  cache_creation_input_tokens?, cache_read_input_tokens?}`. Import specifiers
  use `.js` (`../../../src/telemetry.js`) like all repo code.
- verified: guarded-main pattern under tsx —
  `process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href`
  is true when run via `tsx <file>` and false under vitest import; live-checked
  in the iteration-3 session (micro-3 "guard-check" note) and shipped working
  in `test/e2e/report/build-report.ts` (commit 667d907/338c443, criterion 3
  verified PASS against it). Copy that exact guard so the unit tests can
  import the pure exports without triggering the CLI.
- verified: `node:util` `parseArgs` accepts kebab-case boolean flags with
  defaults — live-checked this session:
  `parseArgs({args:[], options:{confirm:{type:'boolean',default:false},'dry-run':{type:'boolean',default:false}}})`
  returns `{"confirm":false,"dry-run":false}`. With zero args (criterion 4's
  invocation) parseArgs succeeds on defaults, so the confirm gate — not a
  parse error — produces the refusal.
- verified: `vitest.config.ts:5` include pattern is `test/**/*.test.ts` —
  `test/e2e/real-cli/run-real-cli.test.ts` joins `npm run test:unit`
  automatically; `run-real-cli.ts` (not `*.test.ts`) stays excluded, matching
  the spec's "scripts, not vitest suites" rule.
- verified: current suite baseline — 15 test files under `test/` (listed this
  session via `find`), 122/122 tests passing at iteration-3 close
  (memory file, close-out section). This is the regression-guard baseline.
- verified: `test/e2e/results/real-cli.json` must NOT be created by dry-run —
  micro-3's shipped report AC (and its unit test in
  `test/e2e/report/build-report.test.ts`) asserts the synthetic-only report
  contains the "Real-CLI results not present" note; `build-report.ts` reads
  `results/real-cli.json` whenever it exists and headlines it. A dry-run
  writing stub numbers there would poison the report regression checks with
  fake "real" data. Dry-run therefore writes no result files (decision 9).
- verified: `scratchpads/e2e-real-metrics-goal.md` is the read-only rubric —
  never edit it. `.gitignore` already covers `test/e2e/results/` (no change
  needed; none is permitted anyway).
- verified: spec default model name `claude-haiku-4-5` (design doc, Real-CLI
  harness section) — used verbatim as the `--model` default; the budget
  estimate labels its pricing constant as a rough Haiku-class figure per the
  spec's own "rough" wording (decision 5). `src/telemetry.ts:52-60` pricing
  constants (`DEFAULT_BASE_PRICE_PER_MTOK = 3` etc.) are cache-economics
  constants for a Sonnet-class base price, NOT a Haiku spend estimate — the
  estimate uses its own named constant instead of reusing those.

### Design decisions resolved now (no executor judgment calls)

1. **One new module** `test/e2e/real-cli/run-real-cli.ts` (spec path), holding
   both criteria: exported pure logic + a guarded `main()` (same
   `pathToFileURL` guard as `build-report.ts` — verified above). npm script:
   `"e2e:real": "tsx test/e2e/real-cli/run-real-cli.ts"` — the ONLY
   `package.json` change. No new dependencies.
2. **Zero-subprocess / zero-network guarantee (this iteration's invariant):**
   the new files import ONLY `node:util` (parseArgs), `node:url`
   (pathToFileURL), `../layers.js`, `../../../src/telemetry.js`, and
   `../../../src/types.js`. NO `node:child_process`, NO `node:http(s)`, NO
   `fetch`, NO server creation, NO file writes — in ANY code path, including
   dry-run. The "stubbed `claude` executable" of criterion 5 is realized as
   an in-process stub behind a spawner seam (decision 7), which is what keeps
   the dry-run path subprocess-free while still exercising the full
   orchestration loop. An AC greps the new directory to enforce this
   structurally.
3. **CLI flags** (kebab-case, `node:util` `parseArgs`, defaults verified
   above). All flags the spec names are accepted NOW so the interface is
   stable when the live path lands later; unused ones are parsed and carried
   but inert this iteration:
   - `--confirm` boolean, default false
   - `--dry-run` boolean, default false
   - `--yes` boolean, default false (live-path interactive-gate skip; inert)
   - `--layers` string, default `'L0,L1,L2,L3,L4,L5'` — comma-separated
     `LayerId` list, resolved via `getLayer()`; an unknown id → print
     `unknown layer id: <id> (valid: L0..L5)` to stderr, exit 1
   - `--instances` string, default `'3'` (spec: "Default instance count: 3
     per layer")
   - `--turns` string, default `'6'` (the shared 5-6 turn session; matches
     the synthetic harness's `DEFAULT_TURNS = 6`,
     `run-synthetic.ts:18`)
   - `--model` string, default `'claude-haiku-4-5'` (spec verbatim)
   - `--force-instances` string, optional (cap override, decision 6)
   - `--max-budget-usd` string, default `'1'` (live-path per-child budget;
     inert this iteration)
   Numeric strings parsed with `Number.parseInt(..., 10)`; NaN or < 1 →
   stderr message + exit 1.
4. **Gate ordering in `main()` — exact, criterion 4 depends on it:**
   (1) parseArgs → (2) **confirm gate**: if `!confirm`, print the refusal
   (decision 8) to stderr, set `process.exitCode = 1`, `return` — BEFORE any
   layer resolution, counting, estimating, or orchestration → (3) validate
   `--layers`/numeric flags → (4) compute totals + print the budget estimate
   (decision 5) → (5) hard-cap check (decision 6) → (6) if `--dry-run`: run
   the dry-run orchestration (decision 7), exit 0 on success → (7) else
   (confirmed live run): print
   `live real-CLI execution is not implemented in this build — re-run with --dry-run (live path lands in a later iteration)`
   to stderr, exit 1 (decision 10).
5. **Budget estimate** (spec: "rough: instances × turns × avg tokens × Haiku
   pricing") — printed to stdout in step (4) of the gate order, so it appears
   in BOTH dry-run and live-refusal outputs (criterion 5 names
   "budget-estimate printing"). Named constants, WHY-commented as rough
   figures per the spec's own wording:
   `ESTIMATE_PRICE_PER_MTOK = 1` (rough Haiku-class input $/MTok — distinct
   from `src/telemetry.ts`'s Sonnet-class cache constants, see verified note)
   and `ESTIMATE_AVG_TOKENS_PER_TURN = 1000` (order-of-magnitude from the
   recorded synthetic run: L2 read+creation 7126 tokens over 12 requests ≈
   600/turn, rounded up).
   `export function estimateSpendUsd(layerCount: number, instances: number, turns: number): number`
   = `layerCount * instances * turns * ESTIMATE_AVG_TOKENS_PER_TURN * ESTIMATE_PRICE_PER_MTOK / 1_000_000`.
   Printed line (single line, stdout):
   `estimated total spend: $<value.toFixed(4)> (<layerCount> layers x <instances> instances x <turns> turns x ~1000 tok/turn @ $1/MTok, model <model>)`.
6. **Hard cap** (spec: "default cap: 50 total real CLI invocations"):
   `MAX_TOTAL_INVOCATIONS = 50`; `total = selectedLayers.length * instances`.
   If `total > cap` and `--force-instances` absent → stderr
   `refusing: <total> total invocations exceeds the hard cap of 50 — pass --force-instances <n> to override`,
   exit 1. `--force-instances <n>` raises the cap to `n` for this run. The
   check runs in dry-run too (it IS orchestration logic; defaults 6×3=18
   stay well under 50, so criterion 5's invocation is unaffected).
7. **Dry-run orchestration — the in-process "stubbed `claude` executable":**
   - Seam type: `export type TurnRunner = (ctx: {layerId: LayerId; instanceIndex: number; turnIndex: number; model: string}) => Promise<Usage>`.
     The (future) live runner will implement this same seam by driving a real
     `claude` child through a proxy; THIS iteration only ships the stub.
   - `export function createDryRunRunner(): TurnRunner` — deterministic,
     pure, in-process: `turnIndex === 0` →
     `{input_tokens: 260, cache_creation_input_tokens: 1200}`; `turnIndex > 0`
     → `{input_tokens: 260, cache_read_input_tokens: 1200, cache_creation_input_tokens: 140}`
     (fixed arbitrary values shaped like a real cached session; asserted
     verbatim by unit tests — never randomized).
   - `export async function runLayerDry(layer: LayerDefinition, instances: number, turns: number, runner: TurnRunner): Promise<RealLayerResult>`
     — fresh `TelemetryStore` per layer; sequential
     instance × turn loop calling `runner`; each result recorded via
     `store.record({prefixHash: \`dry-${layer.id}-${instanceIndex}\`, usage})`;
     per spec error handling a runner rejection increments `failures` instead
     of aborting. Returns
     `{id, label, requests, cacheReads, cacheWrites, cacheHitRate, estSavedUsd, failures}`
     with `cacheHitRate = requests === 0 ? 0 : cacheReads / requests` (same
     rule as `run-synthetic.ts:167`).
   - `main()`'s dry-run branch iterates the selected layers IN the order
     given, awaiting `runLayerDry` with `createDryRunRunner()`, printing one
     stdout line per layer that STARTS with the layer id (guaranteeing
     criterion 5's `grep -q "$L"` independently of npm's echo of the command
     line):
     `<id> <label>: requests=<n> cacheHitRate=<x.toFixed(3)> estSavedUsd=$<x.toFixed(6)> failures=<n>`
     — followed by a closing line
     `dry-run complete: no subprocesses spawned, no network calls made`,
     then exit 0. If any layer ends with `requests === 0`, exit 1 with a
     stderr message (fail closed, mirroring `run-synthetic.ts:248-255`).
8. **Refusal message** (criterion 4's contract), exported as a constant so the
   unit test pins it:
   `export const CONFIRM_REFUSAL_MESSAGE = 'real-cli harness: refusing to run without --confirm — this harness spends real API credits when run live (use --dry-run --confirm for a free, network-free rehearsal)'`.
   Contains "confirm" (satisfies `grep -qi "confirm"`); printed via
   `console.error`; the criterion captures stderr via `2>&1`.
9. **No file output in dry-run.** Dry-run prints to stdout only — it must
   NEVER write `test/e2e/results/real-cli.json` (would poison the report
   builder's "Real-CLI results not present" regression checks — see verified
   note). Result-file writing belongs to the live path, deferred.
10. **Live path is a safe stub this iteration.** After `--confirm` without
    `--dry-run`: budget estimate prints, cap check runs, then exit 1 with the
    not-implemented message (decision 4 step 7). No auth check, no prompt, no
    spawn — there is nothing live to protect yet, and this guarantees zero
    spend risk if the loop's verifier ever runs `e2e:real -- --confirm` bare.
    The rubric never verifies live execution (it can't — needs credentials);
    the spec's auth check, `--yes` prompt, `--max-budget-usd` pass-through,
    concurrency scenario, and stream-json child-process driving all land with
    the live runner in a later iteration (or post-loop). Documented in Out of
    scope.
11. **Unit-test scope** (`test/e2e/real-cli/run-real-cli.test.ts`) — pure
    exports only; never executes the script, never spawns anything:
    (a) `CONFIRM_REFUSAL_MESSAGE` matches `/confirm/i`;
    (b) `estimateSpendUsd(6, 3, 6)` === `6*3*6*1000*1/1e6` = 0.108 exactly;
    (c) layer selection: parsing `'L0,L5'` yields those two definitions in
    order; an unknown id (`'L9'`) throws/returns an error result (pin
    whichever shape decision 3's validator uses — a pure
    `export function selectLayers(csv: string): LayerDefinition[]` that
    throws `Error('unknown layer id: L9 (valid: L0..L5)')`);
    (d) `createDryRunRunner()` determinism: turn 0 usage equals the decision-7
    literal, turn 2 usage equals the follow-up literal;
    (e) `runLayerDry` aggregation with the stub runner, 2 instances × 3
    turns: `requests === 6`, `cacheWrites === 6` (every stub turn has
    creation tokens), `cacheReads === 4` (turns > 0), `cacheHitRate ≈ 4/6`,
    `failures === 0`; and with an always-rejecting runner: `requests === 0`,
    `failures === 6`;
    (f) safety invariant: read the `run-real-cli.ts` source
    (`readFileSync(new URL('./run-real-cli.ts', import.meta.url))`) and
    assert it contains neither `child_process` nor `fetch(` nor
    `node:http` (structural enforcement of decision 2).

## Steps

Step 1/3: Implement: the pure exports of `test/e2e/real-cli/run-real-cli.ts`
per decisions 2-3 and 5-8: constants (`CONFIRM_REFUSAL_MESSAGE`,
`ESTIMATE_PRICE_PER_MTOK`, `ESTIMATE_AVG_TOKENS_PER_TURN`,
`MAX_TOTAL_INVOCATIONS`), types (`RealCliOptions`, `TurnRunner`,
`RealLayerResult`), `parseRealCliArgs(argv)`, `selectLayers(csv)`,
`estimateSpendUsd(...)`, `createDryRunRunner()`, `runLayerDry(...)`. Imports
strictly per decision 2 (layers/telemetry/types/util/url — nothing else).
needs: nothing prior — iterations 1-3 (commits b746dd6..9e57932) are on the
branch; `test/e2e/layers.ts` and `TelemetryStore` are the only internal
dependencies.
on-failure: if `TelemetryStore.record` cannot express the stub usage shapes
(e.g. cacheWrites/cacheReads counting deviates from the decision-11e expected
numbers), STOP and report with the observed stats object — do NOT reimplement
telemetry math locally.

Step 2/3: Implement: the guarded `main()` (decision 4's exact gate order,
decisions 9-10) in the same file, and the one-line `package.json` script
`"e2e:real": "tsx test/e2e/real-cli/run-real-cli.ts"`. Manually exercise all
three paths and confirm outputs/exit codes: (a) the verbatim criterion-4
command (expect exit != 0 AND "confirm" in output); (b) the verbatim
criterion-5 command (expect exit 0, every layer id present, the budget-
estimate line present); (c) `npm run e2e:real -- --confirm` (expect exit 1,
"not implemented … --dry-run" message, budget estimate printed, and NO
subprocess/network activity by construction). Also confirm
`test/e2e/results/real-cli.json` does not exist after all three runs.
needs: step 1's exports; tsx already installed (package.json:32).
on-failure: if the tsx main-guard misfires (main runs under vitest import or
fails to run under `npm run e2e:real`), revert to prior commit and STOP and
report — the guard pattern is live-verified twice (micro-3 session +
shipped build-report.ts), so a misfire signals an environment change worth
surfacing, not patching around.

Step 3/3: Implement: `test/e2e/real-cli/run-real-cli.test.ts` per decision 11
(pure exports only; includes the 11f source-level no-subprocess/no-network
assertion). Then run full validation: `npm run type-check`; `npx vitest run`
(15 existing files at 100% + the new file); the verbatim criterion-4 verify
command; the verbatim criterion-5 verify command; and the criterion-2 and
criterion-3 regression verifies from the rubric (unchanged files, but the
loop re-checks all criteria fresh — catch drift now, not at verify time).
needs: steps 1-2 landed (tests import the pure exports; criteria commands run
the real npm script).
on-failure: a failing 11e aggregation test means `runLayerDry` or the stub
usage shapes are wrong — fix `run-real-cli.ts`, never loosen the expected
counts; if type-check or the existing suite regresses, revert the offending
file to the prior commit and re-apply minimally.

Regression guard (applies to every step): `npm run type-check` stays green
(criterion 1); the existing suite — 15 test files, 122 tests, 100% passing at
iteration-3 close — stays 100% (new tests may only ADD); rubric criteria 2
and 3 verify commands stay green; NO changes to `src/**`, `tsconfig*.json`,
`vitest.config.ts`, `.gitignore`, the rubric file
(`scratchpads/e2e-real-metrics-goal.md`), `test/e2e/synthetic/**`,
`test/e2e/report/**`, `test/e2e/layers.ts`, `test/e2e/fixtures/**` (all
verified prior-iteration work — note the fixtures' real-CLI prompt-string
export explicitly deferred by micro-2 decision 10 stays deferred, since the
dry-run stub consumes no prompts); the ONLY `package.json` change is the one
`e2e:real` script line; dry-run writes NO files (decision 9). Out of scope:
live `claude` subprocess execution, the auth-status pre-check, the
interactive `--yes` spend prompt, `--max-budget-usd` pass-through behavior,
the real-CLI concurrency scenario, `results/real-cli.json` output, and
`test/e2e/README.md` (Should Pass, later iteration). Also leave untouched:
the stray `C:/` hook-cache directory (move aside before commits per the
memory file's environmental note), and `scratchpads/tester-coverage-gaps-plan.md`.

## Acceptance Criteria

- [ ] Rubric criterion 4 passes end-to-end (bare `npm run e2e:real` exits
      non-zero with a message containing "confirm", before any orchestration)
  verify: `OUT=$(npm run e2e:real 2>&1); CODE=$?; test $CODE -ne 0 && echo "$OUT" | grep -qi "confirm" && echo ok`
- [ ] Rubric criterion 5 passes end-to-end (dry-run exits 0 and mentions all
      six layer ids)
  verify: `OUT=$(npm run e2e:real -- --dry-run --confirm --layers L0,L1,L2,L3,L4,L5 2>&1); test $? -eq 0 && echo "$OUT" | grep -q "L0" && echo "$OUT" | grep -q "L1" && echo "$OUT" | grep -q "L2" && echo "$OUT" | grep -q "L3" && echo "$OUT" | grep -q "L4" && echo "$OUT" | grep -q "L5" && echo ok`
- [ ] Dry-run prints the budget estimate and the subprocess-free closing line
      (criterion 5's "budget-estimate printing" named requirement)
  verify: `npm run e2e:real -- --dry-run --confirm 2>&1 | grep -q "estimated total spend" && npm run e2e:real -- --dry-run --confirm 2>&1 | grep -q "no subprocesses spawned" && echo ok`
- [ ] Harness source is structurally subprocess-free and network-free (this
      iteration's safety invariant, decision 2)
  verify: `! grep -rE "child_process|node:http|fetch\(" test/e2e/real-cli/ && echo ok`
- [ ] Dry-run writes no result files (report-builder regression protection,
      decision 9)
  verify: `npm run e2e:real -- --dry-run --confirm >/dev/null 2>&1; test ! -f test/e2e/results/real-cli.json && echo ok`
- [ ] Confirmed non-dry-run invocation refuses safely this iteration (live
      path deferred; zero spend risk)
  verify: `OUT=$(npm run e2e:real -- --confirm 2>&1); test $? -ne 0 && echo "$OUT" | grep -qi "not implemented" && echo ok`
- [ ] New unit tests pass and the FULL suite (15 existing files + new one)
      stays 100%
  verify: `test -f test/e2e/real-cli/run-real-cli.test.ts && npx vitest run`
- [ ] Type-check stays green (criterion 1 regression guard)
  verify: `npm run type-check`
- [ ] Harness script stays out of the unit-test collection (spec: "scripts,
      not vitest suites") while its test file is collected
  verify: `npx vitest list 2>/dev/null | grep -v "run-real-cli.test.ts" | grep -c "run-real-cli" | grep -qx 0 && npx vitest list 2>/dev/null | grep -q "run-real-cli.test.ts" && echo ok`
- [ ] Criteria 2 and 3 stay green (untouched prior-iteration work, re-checked
      fresh)
  verify: `npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json && npm run e2e:report && echo ok`
