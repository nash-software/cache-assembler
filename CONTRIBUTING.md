# Contributing

## Setup

```sh
npm install
npm run type-check
npx vitest run
```

## Workflow

1. Fork and branch off `master`.
2. Make your change with tests - `test/*.test.ts` mirrors `src/*.ts` one-to-one.
3. `npm run type-check` and `npx vitest run` must both pass clean.
4. Open a PR against `master` using the PR template.

## Adding a preset

Presets describe F3 deferral extractors for a known client - see
[README § Presets](./README.md#presets) for the shape. Add
`presets/<name>.json`, a fixture under `test/fixtures/`, and a case in
`test/presets.test.ts` proving every planted volatile span is found.

## Design constraints (please keep these)

- Zero runtime dependencies.
- `assemble()` must stay pure - never mutate its inputs.
- Fail-open: an error in assembly or barrier coordination should log and
  fall back to forwarding the original request, never break the proxy path.
- Anything that rewrites model-visible content (F3) must ship opt-in, never
  on by default.

## Reporting bugs vs. security issues

Regular bugs: open a GitHub issue. Security vulnerabilities: see
[SECURITY.md](./SECURITY.md) - please don't file those as public issues.
