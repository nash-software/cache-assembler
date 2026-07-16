# Stalled: e2e-real-metrics loop, iteration 1

**RESOLVED 2026-07-17T00:45:00Z** — operator applied the exact plan content
directly (commit `b746dd6`, pushed to origin) and confirmed
`npm run type-check` passes with zero errors. Loop resumed locally at
iteration 2. Left in place as a historical record (same convention as the
original VPS-dispatch-failure stall below it superseding commits didn't
delete).

**Reason:** unresolvable BLOCKED — global tooling safety rail, not a plan or
scope defect.

## What happened

Iteration 1 targeted rubric criterion 1 (inline the dangling
`../../tsconfig.base.json` extends directly into `tsconfig.json` and
`tsconfig.build.json`). The micro-plan (`scratchpads/e2e-real-metrics-micro-1.md`)
was pre-validated and passed run-pipeline's structural check (architect
dispatch correctly skipped). Codex spec-review (Stage 2.6) was unavailable
(`gpt-5.4` model not supported for this ChatGPT-account Codex CLI config —
logged as a bypass note for the eventual PR body, non-blocking per protocol).

The builder agent, dispatched to execute the 2-step plan, was blocked before
making any edit by `/root/.claude/hooks/pre-tool-config-protection.js` — a
global `PreToolUse` hook (registered for every `Edit`/`Write` call, tier
`minimal` so `ECC_HOOK_PROFILE` can't raise it out of range) that
unconditionally blocks writes to any file matching `^tsconfig.*\.json$`
(also `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `biome.json`),
returning `"Fix the code to pass checks, don't weaken the config."` Its only
bypass is `ECC_ALLOW_CONFIG_EDIT=1`, and — per the documented `SKIP_PLAN_GATE`
precedent in this environment — env vars like this only take effect if
exported **before the Claude Code host process itself launches**, not from
inside a Bash tool call in a running session.

I confirmed by reading the hook source directly (not by probing it) that
this would block the identical edit regardless of which tool-caller (main
loop or subagent) attempts it — it inspects `tool_input.file_path` on every
`Edit`/`Write` call. This is a global, user-authored safety rail (documented
in `/opt/relay-claude-vps/CLAUDE.md`'s Code Quality Config-protection rule:
"Never weaken linter configs or tsconfig strictness... Fix the code, not the
config") intended to stop agents from silencing type errors by loosening
config. This particular edit does the opposite — it *inlines and activates*
the base config's `strict: true` and related options that the dangling
`extends` was silently causing TypeScript to ignore — but the hook is a
mechanical basename match with no way to distinguish "loosening" from
"fixing/tightening" intent, and no session-scoped exemption channel exists.

No source or config files were touched — `git status --porcelain` on the
tree at halt time shows only new scratchpad/plan files (rubric, micro-plan,
memory, run-state mirror, routing manifest, run file, this stalled file).
`tsconfig.json`/`tsconfig.build.json` are byte-identical to HEAD.

## What did NOT happen (by design)

No workaround was attempted — not via the builder agent, not by me as
orchestrator. Writing the target JSON via a `Bash` heredoc/`cat`/`sed` (which
the hook wouldn't intercept, since it only fires on `Edit`/`Write` tool
calls) would have silently defeated a security control the user put in
place, with no documented exemption for this exact, legitimate case. That is
exactly the class of self-authorized bypass builder/orchestrator roles are
instructed never to take.

## Exact edits still needed (fully specified, unchanged from the plan)

`tsconfig.json` and `tsconfig.build.json` each need their `"extends":
"../../tsconfig.base.json"` key removed and the following `compilerOptions`
block (sourced from `/home/relay/code/proxy-manager/tsconfig.base.json`,
the actual monorepo this package was extracted from) merged in ahead of
each file's existing overrides:

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

Full before/after content for both files is in
`scratchpads/e2e-real-metrics-micro-1.md`.

## Next step (needs a human decision)

One of:
1. Export `ECC_ALLOW_CONFIG_EDIT=1` before relaunching the Claude Code host,
   then resume this loop (re-dispatch the builder for iteration 1 — nothing
   else needs to be redone).
2. Apply the two JSON edits directly (outside the agent harness) and let the
   loop verify + continue from iteration 2.
3. Some other explicit override the operator wants to authorize.

No rework needed either way — rubric, baseline, routing manifest, and this
micro-plan all stay valid.
