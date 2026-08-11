# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-08-11

### Security
- Fixed a ReDoS bypass in the regex-safety guard
- Fixed an info-disclosure bug: `/stats` was leaking raw request content over the
  network (now redacted; library callers via `TelemetryStore.stats()` still get full data)

### Fixed
- Write-barrier concurrency bug
- Upstream-path handling
- Deferral regex `lastIndex` bug that caused silent partial extraction
- Published package shipped no `.d.ts` files despite `package.json` declaring `types`
  (missing `declaration`/`declarationMap` in `tsconfig.build.json`)

### Added
- Divergence tracking (previously dead code) is now working
- New `--upstream-timeout` CLI flag
- `test/e2e/package/` - verifies the actual packed npm artifact (library import +
  type-check, CLI via npx, standalone proxy) rather than just source

### Changed
- **Breaking:** `assemble()` dropped its third parameter
- Documented `ANTHROPIC_BASE_URL` usage with Claude Code, with an explicit note that
  Claude Desktop is not supported
- Clarified that the validation report's production numbers came from real Claude Code
  subscription traffic routed through the proxy, not metered API billing

## [0.1.0] - 2026-07-19

Initial public release. Prompt-cache-optimizing proxy for the Anthropic Messages API:
canonicalization, breakpoint placement, volatile-byte deferral, write barrier, and
telemetry.
