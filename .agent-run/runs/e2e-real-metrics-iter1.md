---
task: "Iteration 1: inline dangling tsconfig.base.json extends (rubric criterion 1)"
run_slug: e2e-real-metrics-iter1
status: planning
current_stage: PLAN
pipeline_stages: [DISPATCH, PLAN, PLAN_REVIEW, CODEX_SPEC_REVIEW, BUILD, VERIFY_PLAN, CODE_QUALITY, TEST, VERIFY, REVIEW]
nested_mode: true
skip_delivery_gates: true
rubric_path: scratchpads/e2e-real-metrics-goal.md
plan_path: scratchpads/e2e-real-metrics-micro-1.md
default_branch: master
---

plan_source: pre-validated scratchpads/e2e-real-metrics-micro-1.md — architect dispatch skipped (structural check passed: Step N/M steps present, ## Acceptance Criteria with checkbox+verify present)

## Rubric

(from micro-plan Acceptance Criteria — used by verifier)

- [ ] `tsconfig.json` and `tsconfig.build.json` have no `extends` key and contain the full inlined `compilerOptions` (base + existing overrides)
  verify: `grep -L extends tsconfig.json tsconfig.build.json | wc -l` → `2`
- [ ] Type-check passes with zero errors
  verify: `npm run type-check`

## plan

(copied verbatim from scratchpads/e2e-real-metrics-micro-1.md)

Step 1/2: In `tsconfig.json`, remove the `"extends": "../../tsconfig.base.json"` line and merge the base `compilerOptions` block with the existing `compilerOptions` (`rootDir`, `noEmit`, `types`) into one flat `compilerOptions` object.

Step 2/2: Do the same for `tsconfig.build.json` — remove the `extends` key, merge the same base `compilerOptions` block with its existing `compilerOptions` (`rootDir`, `outDir`, `noEmit`, `types`).

Base compilerOptions block (from `/home/relay/code/proxy-manager/tsconfig.base.json`):
```json
{
  "target": "ES2022",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "lib": ["ES2022"],
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "esModuleInterop": true,
  "forceConsistentCasingInFileNames": true,
  "skipLibCheck": true,
  "resolveJsonModule": true,
  "isolatedModules": true
}
```

Do not change `include` arrays or any other file.
