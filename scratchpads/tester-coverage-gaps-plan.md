---
status: approved
created: 2026-07-16T23:00:00Z
author: tester
model: claude-sonnet-5
task: Add missing unit test coverage for layers.ts and fixtures/session-turns.ts (pure logic gap identified by /run-tester on the e2e-real-metrics branch)
files:
  - test/e2e/layers.test.ts
  - test/e2e/fixtures/session-turns.test.ts
---

## Summary

`test/e2e/layers.ts` (cumulative L0-L5 config matrix + `getLayer` lookup) and
`test/e2e/fixtures/session-turns.ts` (deterministic per-instance volatile
params + session-turn fixture builder) are pure logic modules with no
dedicated vitest coverage. Both are exercised indirectly by
`run-synthetic.ts`'s acceptance run (confirmed passing), but that run only
asserts on aggregate cache-hit-rate numbers — it would not catch a silent
regression in, e.g., a layer config omitting an explicit toggle (falling back
to `defaultConfig()`'s `enabled: true` for breakpoints/barrier/telemetry) or
an off-by-one in `buildMessagesUpTo`'s turn-message-count logic. Per the
design spec's "Testing the harness code itself" section, pure logic embedded
in the harness "is easy to get subtly wrong and needs the same scrutiny as
the library code it's validating" — this plan closes that specific gap.

## Context

- `test/e2e/layers.ts` — read in full. `LayerDefinition.config` is
  `CacheAssemblerConfig` (all fields `Partial<>` and optional per
  `src/config.ts`), resolved via `resolveConfig()` which merges
  `{...defaults, ...partial}`. Defaults are `enabled: true` for
  breakpoints/barrier/telemetry, `enabled: false` for deferral — so an
  omitted key silently inherits the default rather than failing to compile.
- `test/e2e/fixtures/session-turns.ts` — read in full. `buildSessionTurns`
  builds `turns` request bodies with `[u1,a1,...,u_k]` messages (2k-1
  entries) using string `.replace()` (not regex) to template volatile spans
  into the fixture's system/tools blocks.
- Existing pattern followed: `test/presets.test.ts` (vitest `describe/it`,
  reads the same `test/fixtures/claude-code-session.json` fixture, asserts
  behavior via the real functions rather than re-asserting literals).
- `test/e2e/synthetic/stub-upstream.test.ts` already covers `stub-upstream.ts`
  — not touched by this plan.
- `test/e2e/synthetic/run-synthetic.ts` is an orchestration script per the
  design spec, intentionally excluded from vitest — not touched.

## Steps

1. Add `test/e2e/layers.test.ts`: assert `resolveConfig(getLayer(id).config)`
   (the real merge function, not a copy of the literal) yields the intended
   canonicalize/breakpoints/deferral/barrier booleans for L1-L5, L4/L5
   dry-run split, L0's `proxy: false` floor, L1-L5's `proxy: true`, `LAYERS`
   ordering, and `getLayer`'s throw-on-unknown-id branch.
   - Why: catches a future layer-config edit that omits an explicit toggle
     and silently inherits `defaultConfig()`'s `enabled: true`.
   - Verify: `npx vitest run test/e2e/layers.test.ts` passes.
   - Test: `npx vitest run test/e2e/layers.test.ts`
2. Add `test/e2e/fixtures/session-turns.test.ts`: assert
   `defaultVolatileParams` determinism (same index -> same params, different
   index -> different params) and UUID/URL shape; `buildSessionTurns` message
   count per turn (`2k-1`), role alternation, `[u_k]` as the final message;
   and that the fixture's placeholder scratchpad-UUID/session-id/session-URL
   are fully replaced by `params`' values in every turn's system/tools
   blocks (not left as the fixture's hardcoded placeholders).
   - Why: catches an off-by-one in the turn/message loop or a broken
     template-replacement that `run-synthetic.ts`'s aggregate-only assertions
     would not surface.
   - Verify: `npx vitest run test/e2e/fixtures/session-turns.test.ts` passes.
   - Test: `npx vitest run test/e2e/fixtures/session-turns.test.ts`

## Acceptance Criteria
- [ ] New tests pass in isolation and as part of the full suite
  verify: npx vitest run
- [ ] Type-check remains clean
  verify: npm run type-check

## Validation

- [ ] `npm run type-check`
- [ ] `npx vitest run`
