---
status: approved
created: 2026-07-16T18:39:21Z
author: architect
model: claude-opus-4-6
task: Synthetic harness — L0-L5 layer matrix + concurrency proof (CACHE-001 e2e real metrics, iteration 2)
files:
  - test/e2e/fixtures/session-turns.ts
  - test/e2e/layers.ts
  - test/e2e/synthetic/stub-upstream.ts
  - test/e2e/synthetic/stub-upstream.test.ts
  - test/e2e/synthetic/run-synthetic.ts
  - package.json
  - package-lock.json
spec_ref: docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md
---

### Summary
This is the plan-gate-compliant registration of the already-approved micro-plan
at `scratchpads/e2e-real-metrics-micro-2.md` (mirrored at
`.agent-run/runs/e2e-real-metrics-iter2.md`). That file is the canonical,
fully detailed plan — verified codebase assumptions, 11 resolved design
decisions, and the 4 steps with `needs`/`on-failure` fields — and is not
duplicated here verbatim; this file exists solely because the generic
plan-gate hook only discovers files matching `*-plan.md` with `status`/`files`
frontmatter, and the canonical micro-plan file predates/uses a different
naming convention from this repo's orchestration pipeline. Read
`scratchpads/e2e-real-metrics-micro-2.md` for full context before
implementing.

### Context
See `scratchpads/e2e-real-metrics-micro-2.md` in full — it contains the
verified source-code evidence (config.ts, server.ts, telemetry.ts,
breakpoints.ts, deferral.ts, presets.ts, existing fixture) and all design
decisions already resolved by the architect. No new judgment calls are
expected here.

### Steps
1. Implement `test/e2e/fixtures/session-turns.ts` and `test/e2e/layers.ts`;
   update `package.json` (tsx devDependency + `e2e:synthetic` script); run
   `npm install`.
   - Why: per micro-plan Step 1/4 (decisions 6, 10).
   - Verify: `npm run type-check` passes; `node -e "require('./package.json').scripts['e2e:synthetic']"` succeeds.
   - Test: `npm run type-check`

2. Implement `test/e2e/synthetic/stub-upstream.ts` (`simulateUsage`,
   `collectSegments`, `createStubUpstream`).
   - Why: per micro-plan Step 2/4 (decisions 1, 2, 4).
   - Verify: `npm run type-check` passes.
   - Test: `npm run type-check`

3. Implement `test/e2e/synthetic/run-synthetic.ts` (CLI, layer loop,
   concurrency scenario, JSON output).
   - Why: per micro-plan Step 3/4 (decisions 3, 5, 6, 7, 8, 9).
   - Verify: `npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json` exits 0.
   - Test: `npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json`

4. Implement `test/e2e/synthetic/stub-upstream.test.ts`; run full validation.
   - Why: per micro-plan Step 4/4 (decision 11); regression guard.
   - Verify: `npx vitest run` passes (12 existing + 1 new file).
   - Test: `npx vitest run`

### Acceptance Criteria
See `scratchpads/e2e-real-metrics-micro-2.md`'s `## Acceptance Criteria`
section — the 5 checkboxes there (rubric criterion 2 end-to-end,
L0/L1 zero + L2 positive + L5 >= L2 hit rates, type-check green, stub-upstream
unit tests + full suite green, harness scripts excluded from vitest
collection) are the authoritative, verbatim acceptance criteria for this
work and are not restated here to avoid drift between two copies.

### Validation
- [ ] `npm run type-check`
- [ ] `npx vitest run`
- [ ] `npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json` + the criterion-2 verify command

### Risks
See micro-plan's per-step `on-failure` fields.

### Out of Scope
Real-CLI harness, report-builder (criterion 6's `build-report.test.ts`) — both
deferred to later iterations per the micro-plan.
