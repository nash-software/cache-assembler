---
task: "Iteration 2: synthetic harness L0-L5 + concurrency proof (rubric criterion 2)"
run_slug: e2e-real-metrics-iter2
status: planning
current_stage: BUILD
pipeline_stages: [DISPATCH(skipped), PLAN(architect), PLAN_REVIEW, CODEX_SPEC_REVIEW(bypassed), BUILD, VERIFY_PLAN, CODE_QUALITY, TEST, VERIFY, REVIEW]
nested_mode: true
skip_delivery_gates: true
rubric_path: scratchpads/e2e-real-metrics-goal.md
plan_path: scratchpads/e2e-real-metrics-micro-2.md
default_branch: master
codex_unavailable: true
codex_bypass_reason: "gpt-5.4 model not supported for this ChatGPT-account Codex CLI config (same error as iteration 1, environment-level, not retried)"
---

plan_source: architect-authored (scope was large — stub upstream, layer matrix, fixture, orchestrator) at scratchpads/e2e-real-metrics-micro-2.md — passed structural check (4 Step N/M entries, ## Acceptance Criteria with 5 checkboxes+verify)

## Rubric

Full plan (steps, verified evidence, design decisions): see scratchpads/e2e-real-metrics-micro-2.md — builder read that file directly. Acceptance Criteria copied verbatim below for the deterministic verify-plan gate.

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
