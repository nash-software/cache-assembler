# Stalled: e2e-real-metrics VPS dispatch

**Reason:** VPS relay dispatch failed — nash-vps/fleet unreachable.

- `orchestration__worktree_open` failed twice (run orch-20260716-13f404,
  orch-20260716-4c713d), both times at "Failed to create context doc ...
  Context writes go over SSH ... Redis error: connect ECONNREFUSED
  127.0.0.1:6379 ... Fleet offline: Connection is closed."
- `relay status` (local) independently confirms nash-vps unreachable right
  now (RAM 0.0G/0.0G, Load ?, Sessions: 0 active, Fleet offline).
- This is an infra connectivity issue, not a problem with the rubric,
  branch, or repo setup — those all completed successfully (see below).

**What already succeeded (safe to reuse once VPS is back):**
- git repo initialized, pushed to `93michaelnash/cache-assembler` (private),
  default branch `master`.
- Cloned onto nash-vps via `relay clone` (before the connectivity drop).
- Task CACHE-001 created, claimed, linked to branch
  `feat/CACHE-001-e2e-real-metrics` (pushed to origin).
- Rubric locked at `scratchpads/e2e-real-metrics-goal.md`, `.ready` marker
  at `scratchpads/e2e-real-metrics-goal.ready`.
- Baseline-must-fail gate executed; all 6 Must Pass criteria confirmed
  genuinely failing on the untouched tree.

**Next step once nash-vps is reachable again:** re-run
`orchestration__worktree_open` with the same lane definition (session
vc-cache-assembler, project cache-assembler, branch
feat/CACHE-001-e2e-real-metrics, baseBranch master) — no rework needed.
