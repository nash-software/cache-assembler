# Handoff: cache-assembler launch follow-ups

Date: 2026-08-11 (updated same day after v0.2.0 release)
Context: this closes out the OSS launch session. Package is published and verified,
GitHub/npm are live, LinkedIn is posted, v0.2.0 is out. What's below is what's still open.
**Next focus: posting X, Hacker News, and Reddit.**

## 1. Version bump — DONE

Shipped as `v0.2.0` (not `v0.1.1` — MINOR bump, given a breaking API change and new
functionality since `v0.1.0`). Sequence completed:
- `package.json` bumped to 0.2.0 via [PR #9](https://github.com/nash-software/cache-assembler/pull/9),
  squash-merged.
- Full verification before publish: `type-check` clean, 204/204 unit tests, `build`
  clean, and `npm run e2e:package` — all 7 checks passed against the actual packed
  0.2.0 tarball (library types, type-check, runtime, CLI --help/--version, standalone
  proxy round-trip + canonicalization).
- Tagged `v0.2.0`, pushed tag, created a [GitHub Release](https://github.com/nash-software/cache-assembler/releases/tag/v0.2.0)
  with full notes (security fixes, correctness fixes, new divergence-tracking feature,
  `--upstream-timeout` flag, breaking `assemble()` signature change, docs updates).
- `npm publish` — you ran this yourself (OTP required, same friction as v0.1.0, see #2
  below). Confirmed live via `npm view cache-assembler version` → `0.2.0`.
- Added `CHANGELOG.md` at the repo root (Keep a Changelog style, covers v0.1.0 and
  v0.2.0) via [PR #10](https://github.com/nash-software/cache-assembler/pull/10),
  squash-merged — history is now discoverable in the repo, not just on the Releases
  page.

`master` is clean at the latest merge, no stale branches.

## 2. npm publish friction (informational, for next time)

`npm login` and `npm publish` both require live interactive input this environment
can't provide (a browser-based login flow, and an OTP/2FA step) — confirmed again on
the v0.2.0 publish: `prepublishOnly` ran clean (type-check, tests, build all passed,
tarball contents looked correct — 49 files, `.d.ts` present for every module) but the
actual publish failed with `EOTP` and had to be completed by hand. Not fixable from
this side — Claude shouldn't handle credentials/2FA regardless. Budget for a manual
OTP step on every future release.

## 3. GitHub org page — needs the user's own UI actions

- Pin `cache-assembler` on the `nash-software` org page — confirmed via the GitHub
  GraphQL API that pinning has no API/CLI path, it's UI-only. Org page → "Customize
  pins" → check `cache-assembler` → Save.
- Org avatar/logo — none exists, nothing was fabricated for it. Needs a real image
  from the user via org Settings → Profile picture.

## 4. Content — status per channel (NEXT FOCUS)

- **Blog** (nashsoftware.dev/writing/cut-claude-costs-8x): live, verified, includes
  the repo link fix and cross-provider caveat added earlier this session.
- **LinkedIn**: posted by the user (their own hand-edited final version, saved to
  `lifeDashboard/linkedin/staging/2026-07-19-cache-assembler-release.md` with
  `status: published`). The specific edits the user made were analyzed and fed back
  into `lifeDashboard/linkedin/anti-ai.md` and the global
  `~/.claude/skills/ai-content-checker/references/anti-ai-patterns.md`.
- **Hacker News / X — next up.** Ready-to-post content was drafted earlier in this
  session (Show HN title/first-comment, 5-tweet thread) but posting was never
  confirmed — status unknown, don't assume either happened. Before posting:
  - Re-check both drafts still match reality now that v0.2.0 is out (numbers, links,
    any "still v0.1.0" phrasing) — they were written against the v0.1.0 state.
  - Run `/ai-content-checker` on both if they haven't already been through the
    voice/anti-AI pass.
  - Locate the staged drafts (likely still in
    `lifeDashboard/linkedin/staging/2026-07-19-cache-assembler-x-reddit-hn.md`, or
    wherever the HN/X-specific content landed — worth a quick search if not found
    there) before rewriting from scratch.
- **Reddit** (3 posts, r/programming / r/ClaudeAI / r/LocalLLaMA): staged in
  `lifeDashboard/linkedin/staging/2026-07-19-cache-assembler-x-reddit-hn.md`. Held back
  deliberately — the user's Reddit account is auto-generated/newly relevant and needs
  some organic activity before a self-promotional post is safe from AutoModerator
  removal on stricter subreddits. Also flagged: Reddit allows a **one-time** username
  change on Google/Apple auto-generated accounts, but only before the account's first
  comment — worth checking that before posting anything there. Check account age/activity
  before deciding whether it's safe to post now.

## Files/locations for context

- Main repo: `C:/code/cache-assembler` (this repo)
- Blog: `C:/code/nash-software-services`
- Content staging: `C:/lifeDashboard/linkedin/staging/`
- Validation report: `docs/validation-report.md` in this repo
- Changelog: `CHANGELOG.md` in this repo
