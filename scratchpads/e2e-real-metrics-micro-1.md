---
spec_ref: docs/superpowers/specs/2026-07-16-e2e-real-metrics-design.md
---

# Micro-plan 1: Inline dangling tsconfig.base.json extends

## Context

Rubric criterion 1 (`scratchpads/e2e-real-metrics-goal.md`), quoted verbatim:

> **Standalone build config** — repo was extracted from the `proxy-manager`
> monorepo; `tsconfig.json`/`tsconfig.build.json` still `extends` a dangling
> `../../tsconfig.base.json` path from that layout, which TypeScript silently
> ignores (falls back to weak defaults) and currently produces 10 errors.
> Inline the base config's compiler options directly so the repo is
> standalone, matching the README's "zero imports from other proxy-manager
> packages" design claim.
> verify: `npm run type-check`

README.md:101 states: "Zero runtime dependencies, zero imports from other
proxy-manager packages" — the dangling `extends` path violates this claim
even though it's a build-config reference, not a source import; the fix
brings the repo fully into line with it.

The dangling path currently resolves to `/root/tsconfig.base.json` (one
level above the actual proxy-manager monorepo root from this package's old
nested location), which doesn't exist, so `tsc` errors with
`TS5083: Cannot read file '/root/tsconfig.base.json'` and silently falls
back to default (non-strict) compiler options rather than failing loudly —
this is what currently produces 10 downstream `error TS...` results across
`vitest`'s own type declarations and `import.meta` usage in
`src/cli.ts`/`src/presets.ts`/`test/presets.test.ts`.

verified: `/home/relay/code/proxy-manager/tsconfig.base.json` (the actual
source-of-truth base config from the monorepo this package was extracted
from) contains exactly this `compilerOptions` block — inline it verbatim:

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

Current `tsconfig.json` (verified: `tsconfig.json:1-7`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "src/**/*.json", "test/**/*.ts"]
}
```

Current `tsconfig.build.json` (verified: `tsconfig.build.json:1-7`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": false,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

## Steps

Step 1/2: In `tsconfig.json`, remove the `"extends": "../../tsconfig.base.json"`
line and merge the base `compilerOptions` block (quoted above) with the
existing `compilerOptions` (`rootDir`, `noEmit`, `types`) into one flat
`compilerOptions` object — base options first, then the package-specific
overrides, so the file is fully standalone with no `extends` key at all.

Step 2/2: Do the same for `tsconfig.build.json` — remove the `extends` key,
merge the same base `compilerOptions` block with its existing
`compilerOptions` (`rootDir`, `outDir`, `noEmit`, `types`).

Do not change `include` arrays or any other file. Do not touch
`vitest.config.ts`.

## Acceptance Criteria

- [ ] `tsconfig.json` and `tsconfig.build.json` have no `extends` key and
      contain the full inlined `compilerOptions` (base + existing overrides)
  verify: `grep -L extends tsconfig.json tsconfig.build.json | wc -l` → `2`
- [ ] Type-check passes with zero errors
  verify: `npm run type-check`
