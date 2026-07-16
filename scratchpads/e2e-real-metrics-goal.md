# Goal: Implement e2e test suite for real cache/cost metrics

Spec: docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md

## Must Pass

1. **Standalone build config** — repo was extracted from the `proxy-manager`
   monorepo; `tsconfig.json`/`tsconfig.build.json` still `extends` a dangling
   `../../tsconfig.base.json` path from that layout, which TypeScript silently
   ignores (falls back to weak defaults) and currently produces 10 errors.
   Inline the base config's compiler options directly so the repo is
   standalone, matching the README's "zero imports from other proxy-manager
   packages" design claim.
   verify: `npm run type-check`

2. **Synthetic harness covers all six layers (L0-L5) + the concurrency proof**
   verify:
   ```sh
   npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json && node -e "
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
   "
   ```

3. **Report builder produces a self-contained HTML report** (no external
   script/link resources) with the cache-hit-rate chart, $-saved chart, raw
   numbers table, and concurrency-proof section
   verify:
   ```sh
   npm run e2e:report && node -e "
   const fs = require('fs');
   const h = fs.readFileSync('test/e2e/results/report.html', 'utf8');
   if (/<script src=|<link[^>]+href=\"https?:/.test(h)) { console.error('report references external resources'); process.exit(1); }
   const need = ['cache-hit-rate', 'saved', 'concurrency'];
   for (const k of need) if (!h.toLowerCase().includes(k)) { console.error('missing section: ' + k); process.exit(1); }
   console.log('ok');
   "
   ```

4. **Real-CLI harness refuses to run without `--confirm`** (safety rail — no
   subprocess spawn, no network call)
   verify:
   ```sh
   OUT=$(npm run e2e:real 2>&1); CODE=$?
   test $CODE -ne 0 && echo "$OUT" | grep -qi "confirm"
   ```

5. **Real-CLI harness `--dry-run` exercises full orchestration logic without
   live credentials** (layer iteration, instance/turn counts, budget-estimate
   printing, against a stubbed `claude` executable — never the real network)
   verify:
   ```sh
   OUT=$(npm run e2e:real -- --dry-run --confirm --layers L0,L1,L2,L3,L4,L5 2>&1); CODE=$?
   test $CODE -eq 0 || exit 1
   for L in L0 L1 L2 L3 L4 L5; do echo "$OUT" | grep -q "$L" || exit 1; done
   echo ok
   ```

6. **New pure-logic unit tests exist and pass** (stub-upstream cache
   simulation, report aggregation math), alongside the existing suite
   verify:
   ```sh
   test -f test/e2e/synthetic/stub-upstream.test.ts && test -f test/e2e/report/build-report.test.ts && npx vitest run test/e2e/synthetic/stub-upstream.test.ts test/e2e/report/build-report.test.ts
   ```

## Should Pass

1. `test/e2e/README.md` documents invocation (`npm run e2e:synthetic`,
   `npm run e2e:report`, `npm run e2e:real -- --confirm`) and the real-CLI
   harness's cost/credential requirements
   verify: `test -f test/e2e/README.md`

## Loop Configuration

- max_iterations: 8
- no_progress_threshold: 3
- budget_ceiling_pct: 100
- memory_file: scratchpads/memory-e2e-real-metrics.md
