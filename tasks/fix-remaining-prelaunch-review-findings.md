# Fix Remaining Pre-Launch Review Findings so cache-assembler Doesn't Ship with Known Rough Edges

**Type**: Chore

## Description

The fable-model final review before wider posting (HN/Reddit/X) found 8 launch-blocking
issues (already fixed and merged: PRs #3, #4) and 9 lower-severity findings that were
explicitly _not_ blockers. The user has decided to fix all 9 before going live rather than
ship with known rough edges, following the same pattern as the original 10-finding
production-readiness audit (PR #1), which was also fixed as a single bundled pass.

None of these are new features — every item is a gap between what the code/docs already
claim and what actually happens, found by an adversarial read of the existing
implementation. Fixing them closes that gap rather than adding new behavior.

## Acceptance Criteria

1. **`/stats` divergence tracking actually works for standalone proxy users.**
   `server.ts`'s call to `telemetry.record()` (line 366) passes only `{ prefixHash, usage }`
   — never `canonicalPrefix` or `chainPosition`, so `TelemetryStore.trackStability()`
   (telemetry.ts:218-219) never runs and `/stats`'s `divergences` array is always `[]` for
   every standalone-proxy user, despite the README's F5 row promising "flags when a cached
   prefix diverges (and why)."
   - [ ] `server.ts` threads a canonical prefix string and a chain-position value through
     to `telemetry.record()` for every request that has one (i.e. `assemble()` succeeded)
   - [ ] A standalone-proxy integration test sends two requests with a deliberately
     different prefix at the same chain position and asserts `/stats` returns a non-empty
     `divergences` array with the correct `feature` attribution
   - [ ] `chainPosition: number` must be derived from something already available in the request
     (e.g., message count / turn index as an integer) — do not require a new client-supplied header

2. **Trace-log header capture is allowlist-based, not blocklist-based.**
   `safeHeaders()` (server.ts:131-137) redacts by a fixed blocklist
   (`authorization`, `proxy-authorization`, `x-api-key`, `cookie`, `set-cookie`) and passes
   every other header through verbatim to the trace log file — a credential header this
   list hasn't anticipated (Azure's `api-key`, `x-goog-api-key`, a custom auth scheme)
   would be written to disk in plaintext.
   - [ ] Replace the blocklist with an explicit allowlist of headers safe to log verbatim
     (at minimum: `content-type`, `anthropic-version`, `anthropic-beta`, `user-agent`,
     `accept`) — anything not on the allowlist is either omitted or logged as
     `[not logged]`, never passed through raw
   - [ ] A test asserts a header not on the allowlist (e.g. a made-up
     `x-custom-api-key: secret`) never appears verbatim in trace output

3. **`forwardToUpstream` no longer silently drops a path segment on the upstream URL.**
   `new URL(pathname, upstream)` (server.ts:208) treats `upstream` purely as an origin —
   if a user configures `--upstream https://gateway.example.com/base`, the `/base` segment
   is discarded and requests go to `https://gateway.example.com/v1/messages` instead of
   `https://gateway.example.com/base/v1/messages`, silently breaking any upstream mounted
   at a subpath.
   - [ ] Upstream requests preserve any path segment already present in the configured
     `--upstream` URL, joining it with the proxied path rather than replacing it
   - [ ] A test configures an upstream URL with a path segment and asserts the outgoing
     request URL contains both the configured segment and the proxied path

4. **Write barrier only marks an entry "warm" on an actual successful cache write.**
   The leader's `barrier.firstByte(barrierKey)` calls in `server.ts` (inside and after the
   streaming loop) fire as soon as the first response byte arrives, regardless of
   `upstreamRes.statusCode` — a 4xx/5xx response (rate limit, invalid request) triggers
   `firstByte` exactly like a 200 would, so followers get released as though a cache entry
   now exists when it doesn't.
   - [ ] `firstByte` is only called when `upstreamRes.statusCode` is in the 2xx range
   - [ ] A test simulates a leader receiving a non-2xx upstream response and asserts the
     barrier entry does NOT become warm (a subsequent `enter()` call for the same hash
     still returns `role: 'leader'`, not `'follower'`)

5. **`WriteBarrier.fail()` no longer evicts an already-warm entry.**
   `fail()` (barrier.ts:101-107) unconditionally deletes the hash's entry — called from
   `server.ts`'s catch block for ANY caller's failure, not just the leader's. If a
   follower's own request fails for unrelated reasons (client abort, transient network
   error) after the leader already succeeded and warmed the entry, `fail()` deletes that
   legitimately-warm entry, forcing the next caller to become a fresh leader and pay an
   unnecessary cache-write cost.
   - [ ] `fail()` is a no-op when the entry is already warm (`entry.warm === true`) —
     it only resets/releases-followers/deletes when the entry is still in its pending
     (pre-warm) state
   - [ ] A test warms an entry via `firstByte()`, then calls `fail()` on the same hash,
     and asserts a subsequent `enter()` still returns `role: 'follower'` (entry survived)

6. **Remove the dead `AssemblerState`/`knownPrefixHashes` API surface.**
   `assemble()`'s third parameter is already named `_state` (conventionally-unused) and
   `AssemblerState.knownPrefixHashes` is populated nowhere and read nowhere in the
   codebase — accepted public API surface that does nothing, which reads as unfinished
   scaffolding to an external contributor.
   - [ ] `assemble()` drops the `_state`/`AssemblerState` parameter entirely (2-arg
     signature: `req`, `partialCfg`)
   - [ ] `AssemblerState` type, `ProxyServerOptions.state`, and the
     `opts.state ?? { knownPrefixHashes: [] }` line in `server.ts` are removed
   - [ ] All call sites (library usage in README, `createProxyServer`, tests) updated to
     match the new signature; type-check passes with no remaining references

7. **Relocated-content tag no longer imitates Anthropic's internal prompt formatting.**
   `deferral.ts:70` wraps relocated volatile spans in a literal `<system-reminder>` tag —
   the same tag Anthropic's own tooling uses for internal system-injected content. A
   security-minded reader could reasonably read this as prompt-injection-adjacent even
   though its actual purpose (labeling relocated content, never hidden or deceptive) is
   benign.
   - [ ] Rename the wrapping tag to something neutral that doesn't imitate any known
     internal-tooling convention (e.g. `<relocated-context>`)
   - [ ] Existing tests referencing the old tag name are updated; no behavior change
     beyond the tag string itself

8. **Response buffering for telemetry stops once `usage` has been found, not at stream end.**
   The proxied-request handler (`server.ts`, the `for await (const chunk of ...)` loop)
   pushes every chunk into `chunks` whenever `needsUsageBuffer` is true (the default, since
   telemetry defaults to enabled) and only calls `extractUsage()` after the full response
   has ended — for a long streamed response, this holds the entire body in memory even
   though `extractUsage()` (server.ts:89-114) already returns on the *first* `usage` object
   it finds (typically in an early `message_start`/`message_delta` SSE event, since
   `cache_creation_input_tokens`/`cache_read_input_tokens` are fixed at stream start and
   don't change on later events — only `output_tokens` accumulates, and this tool doesn't
   use `output_tokens`).
   - [ ] Buffering stops (no further chunks pushed to `chunks`) once `extractUsage()`
     applied to the accumulated buffer-so-far returns a defined `Usage` object
   - [ ] A test proves: (a) usage is still correctly extracted for a multi-chunk SSE
     response where the usage-bearing event arrives before the stream ends, and (b) chunks
     arriving after that point are still forwarded to the client (`res.write`) but are no
     longer retained in the buffered `chunks` array
   - [ ] A test verifies that non-streaming (single JSON blob) responses continue to extract
     usage correctly without unnecessary full-body buffering (regression guard: this path
     currently only sees `usage` once the full body has arrived, since a bare JSON object
     isn't parseable until complete — confirm it still works after the fix)

9. **`estLostUsd`'s sign convention is documented, not just internally consistent.**
   `telemetry.ts:257-265` computes `estLostUsd` as `<= 0` (a cost, expressed as a negative
   number) with a comment explaining why — but nothing surfaces that convention to a
   `/stats` API consumer, who could reasonably expect a "lost" amount to be positive.
   - [ ] `TelemetryStats.estLostUsd`'s JSDoc explicitly states the sign convention
     ("always <= 0; magnitude is the premium paid for cache writes vs. what those same
     tokens would have cost as plain input")
   - [ ] `README.md`'s F5 row or the `/stats` shape documentation (wherever `/stats`'s
     fields are described) states the same convention in plain language

### Testing

- [ ] Unit/integration tests for all 9 items above (specified inline per-item)
- [ ] `npm run type-check` clean, `npx vitest run` passing, including all new tests
- [ ] No change to any currently-passing test's expected behavior (all 9 items are either
  additive or fix an already-wrong behavior — none intentionally change a documented,
  correct behavior)

## Technical Notes

- Files touched: `src/server.ts` (items 1, 2, 3, 4, 8), `src/barrier.ts` (items 4, 5),
  `src/telemetry.ts` (items 1, 9), `src/assemble.ts` + `src/types.ts` (item 6),
  `src/deferral.ts` (item 7)
- Existing patterns to follow: fail-open error handling throughout `server.ts`; the
  project's own test convention of one `describe` block per audit finding with a comment
  explaining what was verified before the fix (see `test/audit-fix-medium-hardening.test.ts`
  for the exact style — continue in the same file or a new
  `test/audit-fix-quality-pass.test.ts`, matching whichever the architect/builder judges
  cleaner given the final diff size)
- Item 6 is the only one with a public API signature change (`assemble()` drops its third
  parameter) — grep all call sites (README code sample, `server.ts`, every test file
  importing `assemble`) before editing, per this project's own "grep all consumers before
  extracting/moving code" convention

## Failure Modes

- Item 1 (divergence tracking): if `chainPosition` is derived incorrectly (e.g. always 0),
  every request would appear to be "the same chain position," producing false-positive
  divergence records for what are actually unrelated independent conversations. The
  derivation must be scoped so unrelated conversations never collide on chain position —
  flagged as an Open Question below since the exact derivation isn't fully specified here.
- Item 8 (early-stop buffering): if the "usage found" check is applied incorrectly (e.g.
  checking too early, before a complete SSE event has arrived), a partial/malformed chunk
  boundary could cause `extractUsage`'s internal `JSON.parse` to throw — already handled
  by the function's existing try/catch returning `undefined` on parse failure, so a
  false-negative here just means buffering continues one more chunk than strictly
  necessary, not a crash. Confirm this remains true after the change.
- Item 5 (barrier fail() no-op on warm): if a genuine failure occurs while an entry is
  already warm, no state changes — this is intentional per the AC, but means a caller-side
  failure never causes an early warm-entry expiry. The existing `warmTtlMs` eviction timer
  (barrier.ts:92) remains the only cleanup path for a warm entry, unchanged by this fix.

## Out of Scope

- No new telemetry fields or `/stats` shape changes beyond documenting `estLostUsd`'s
  existing sign convention (item 9)
- No changes to the F1-F5 feature set's actual cache-assembly behavior — every item here
  is telemetry/coordination/documentation/dead-code, not the core `assemble()` pipeline's
  request-rewriting logic
- Not re-opening any of the 8 items already fixed and merged in PR #4
- No performance benchmarking of the item-8 buffering change beyond the specified
  correctness tests — if a future perf pass wants numbers, that's a separate ticket

## Dependencies

- None — all 9 items are independent of each other and can be implemented/tested in any
  order, though item 6 (removing `AssemblerState`) is worth doing early since it simplifies
  the `server.ts` diff for the other items touching that file

## Open Questions

- Item 1: what should `chainPosition` actually be derived from? The obvious candidate is
  the request's message count (`req.messages.length`), since a growing conversation's Nth
  turn should compare against the same conversation's own previous Nth-turn prefix — but
  this needs confirming against how `test/e2e/*` fixtures structure turns, so two
  *different* conversations that happen to have the same message count don't collide.
  Flagging for the architect/builder to confirm during planning rather than guessing here.

## Effort Estimate

**L** (single ticket, ~9 independent small fixes across 5 files + tests)

Rationale: each item individually is XS-S, but the total surface (5 files, 9 test
scenarios, one public API signature change) and the need to keep the existing 193 tests
green throughout puts this at L rather than M. Matches the sizing of the original
production-audit-fixes pass (PR #1), which had a comparable finding count.
