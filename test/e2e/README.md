# E2E test suite — real cache/cost metrics

Full design: `docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md`

This suite is **not part of CI**. It's invoked manually / on demand to
validate the cache assembler's hit-rate and cost-savings behavior across all
six layers (L0-L5), either against a free in-process stub (synthetic) or a
real `claude` CLI session (real-cli, live execution not yet implemented —
see below).

## Invocation

```sh
# Free, no gating, safe to run any time. Exercises all six layers (L0-L5)
# plus the write-barrier concurrency proof against an in-process stub
# upstream — no network, no real credentials.
npm run e2e:synthetic -- --instances 2 --out test/e2e/results/synthetic.json

# Builds a self-contained HTML report (results/report.html) from whichever
# result files exist (results/synthetic.json and/or results/real-cli.json).
npm run e2e:report

# Real-CLI harness. Refuses to run without --confirm (safety rail — no
# subprocess spawn, no network call happens before this gate).
npm run e2e:real                                    # refuses, exit != 0
npm run e2e:real -- --dry-run --confirm             # free rehearsal, see below
npm run e2e:real -- --confirm                       # see "Current status" below
```

## Real-CLI harness — cost and credentials

The real-CLI harness is designed to drive real `claude` CLI subprocesses
(one long-lived process per "instance", fed a shared 5-6 turn session over
stdin) and read back each turn's actual `usage` block — spending real API
credits. When it runs live:

- Requires a working `claude auth login` in the environment it runs in. This
  harness is meant to be run interactively by a human with valid
  credentials, not from an unattended/expired-session context.
- Defaults to `--model claude-haiku-4-5` to hold cost down (overridable via
  `--model`).
- Default instance count: 3 per layer, hard-capped in code at 50 total
  invocations across all layers + the concurrency scenario. Anything above
  the cap requires an explicit `--force-instances <n>` override.
- Prints an estimated total spend (rough: instances × turns × avg tokens ×
  Haiku pricing) before doing anything live.

### Safety rails

- Refuses to run at all without `--confirm` — this is checked before any
  layer resolution, budget estimation, or orchestration.
- `--dry-run --confirm` exercises the full orchestration loop (layer
  iteration, instance/turn counts, budget-estimate printing) against an
  in-process stub — never a real subprocess, never a network call. Safe to
  run any time, at no cost. Writes no result files.
- The synthetic harness (`npm run e2e:synthetic`) has no such gate — it's
  free and local-only by construction.

### Current status

Live execution (real `claude` subprocesses, the auth check, the
`--yes` non-interactive prompt, `--max-budget-usd` pass-through, and the
concurrency scenario) is not implemented in this build. Running
`npm run e2e:real -- --confirm` without `--dry-run` prints the budget
estimate, runs the hard-cap check, then exits with a message pointing you at
`--dry-run` — it never spawns a subprocess or makes a network call. The live
path lands in a later iteration.

## Testing the harness code itself

`run-synthetic.ts`, `run-real-cli.ts`, and `build-report.ts` are scripts, not
vitest suites, and are excluded from `npm run test:unit`. Their pure logic
(the stub-upstream cache simulation, the real-cli harness's arg parsing and
dry-run orchestration, the report builder's aggregation math) has its own
`*.test.ts` files alongside the existing suite.
