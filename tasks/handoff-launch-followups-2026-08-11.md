# Handoff: cache-assembler launch follow-ups

Date: 2026-08-11
Context: this closes out the OSS launch session. Package is published and verified,
GitHub/npm are live, LinkedIn is posted. What's below is what's still open.

## 1. Version bump decision — open, not yet actioned

Since `v0.1.0` was tagged, real `src/` changes landed (not "mainly docs" — see PR #4,
#6, #7): a security fix (ReDoS bypass), a genuine info-disclosure fix (`/stats` leaking
request content), several correctness fixes (write-barrier concurrency, upstream-path
handling, a deferral regex bug), a previously-dead feature now working (divergence
tracking), a new CLI flag (`--upstream-timeout`), and a breaking API change
(`assemble()` dropped its third parameter).

**Recommendation given to the user**: `v0.2.0`, not `v0.1.1` — MINOR, not PATCH, given
the breaking signature change and new functionality. Awaiting the user's go-ahead.

**If proceeding**: bump `package.json` version, commit, tag `v0.2.0`, push tag, create
a GitHub Release with notes covering everything since `v0.1.0`, then `npm publish`
(needs the user's live login + OTP again — same friction as the v0.1.0 publish, see
below).

## 2. npm publish friction (informational, for next time)

`npm login` and `npm publish` both require live interactive input this environment
can't provide (a browser-based login flow, and either a TOTP/OTP code or a WebAuthn
device-pairing code depending on the account's 2FA setup) — Claude cannot and should
not handle credentials/2FA on the user's behalf. Also found: this machine has multiple
*other* projects with globally-linked `vitest` at different versions, which can shadow
the local one and break `prepublishOnly` if run from certain shells (PowerShell worked
reliably; CMD did not). Worth remembering next release so it's not re-discovered.

## 3. GitHub org page — needs the user's own UI actions

- Pin `cache-assembler` on the `nash-software` org page — confirmed via the GitHub
  GraphQL API that pinning has no API/CLI path, it's UI-only. Org page → "Customize
  pins" → check `cache-assembler` → Save.
- Org avatar/logo — none exists, nothing was fabricated for it. Needs a real image
  from the user via org Settings → Profile picture.

## 4. Content — status per channel

- **Blog** (nashsoftware.dev/writing/cut-claude-costs-8x): live, verified, includes
  the repo link fix and cross-provider caveat added this session.
- **LinkedIn**: posted by the user (their own hand-edited final version, saved to
  `lifeDashboard/linkedin/staging/2026-07-19-cache-assembler-release.md` with
  `status: published`). The specific edits the user made were analyzed and fed back
  into `lifeDashboard/linkedin/anti-ai.md` and the global
  `~/.claude/skills/ai-content-checker/references/anti-ai-patterns.md`.
- **Hacker News / X**: ready-to-post content was handed to the user (Show HN
  title/first-comment, 5-tweet thread) but **posting was never confirmed** — unclear
  whether either actually went out. Worth checking with the user directly rather than
  assuming either way.
- **Reddit** (3 posts, r/programming / r/ClaudeAI / r/LocalLLaMA): still staged in
  `lifeDashboard/linkedin/staging/2026-07-19-cache-assembler-x-reddit-hn.md`. Held back
  deliberately — the user's Reddit account is auto-generated/newly relevant and needs
  some organic activity before a self-promotional post is safe from AutoModerator
  removal on stricter subreddits. Also flagged: Reddit allows a **one-time** username
  change on Google/Apple auto-generated accounts, but only before the account's first
  comment — worth the user checking that before posting anything there.

## Files/locations for context

- Main repo: `C:/code/cache-assembler` (this repo)
- Blog: `C:/code/nash-software-services`
- Content staging: `C:/lifeDashboard/linkedin/staging/`
- Validation report: `docs/validation-report.md` in this repo
