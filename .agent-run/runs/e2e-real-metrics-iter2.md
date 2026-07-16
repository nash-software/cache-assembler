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

(from micro-plan Acceptance Criteria)

- [ ] Rubric criterion 2 passes end-to-end (all six layers + concurrency proof)
- [ ] Caching genuinely turns on at L2, L5 >= L2, L0/L1 hit rate 0
- [ ] Type-check stays green
- [ ] Stub-upstream unit tests exist and full vitest suite passes
- [ ] Harness scripts stay out of the unit-test collection

Full plan (steps, verified evidence, design decisions): see scratchpads/e2e-real-metrics-micro-2.md — copied here by reference to avoid duplication drift; builder reads that file directly.
