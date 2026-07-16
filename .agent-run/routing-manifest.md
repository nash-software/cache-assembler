# Routing Manifest — e2e-real-metrics-iter1

- Tech stack: Node.js/TypeScript library (tsc + vitest), no framework.
- Complexity: low (config-only change, 2 files, no new logic).
- Domain: build configuration.
- Specialists: none required.
- Pipeline stages: PLAN(skip, pre-validated) → PLAN_REVIEW → CODEX_SPEC_REVIEW
  → BUILD → VERIFY_PLAN → CODE_QUALITY → TEST → VERIFY → REVIEW
  (delivery gates + PR skipped: --skip-delivery-gates, --nested)
- requires_human_gate: false (low complexity, --auto)
