# Cost reduction: whose setup benefits most, and why

Question this answers: a reported cost-reduction multiplier (e.g. "8.2x") —
is that specific to a heavy-tooling, heavy-parallelism setup, or would most
Claude Code users see something similar? Analysis done 2026-07-19 against
real production trace-log data from a live VPS deployment.

## Real production numbers, split by deferral off vs. on

Computed directly from `/root/logs/cache-assembler-trace.jsonl` by summing
each request's `economics.actualUsd` and `economics.counterfactualUsd`
(counterfactual = what would have been paid with no caching at all) and
taking the ratio:

| Period | Requests | Actual paid | Counterfactual | Multiplier |
|---|---|---|---|---|
| Deferral off | 2,300 | $101.60 | $653.59 | **6.43x** |
| Deferral on | 1,041 | $42.95 | $268.47 | **6.25x** |

Two honest notes on this data:
- The multiplier didn't move much between the two periods. Deferral's job
  is preventing cache *misses* that would otherwise occur silently across
  sessions (a session-unique ID sitting in an otherwise-stable prefix
  breaks the whole prefix's cache match) — over a short window with
  already-decent hit rates in both periods, that doesn't show up as a big
  swing in the aggregate multiplier. Its value is more about *preventing a
  worse number* than *making a good number better*, and that's hard to see
  without a controlled A/B on otherwise-identical traffic.
- 6.2–6.4x is in the same ballpark as an externally-reported "8.2x" figure
  for this same deployment, but not identical — plausibly a different
  measurement window or methodology, not a contradiction.

## Why a heavy-tooling, heavy-parallelism setup plausibly sees a bigger multiplier

The multiplier is mechanically driven by one ratio: **how much of each
request's tokens are "the same stuff every time" vs. "genuinely new content
this turn."** Caching only discounts the stable part (roughly 90% off on a
cache read vs. full price), so the savings ceiling is set by how much of
total spend is stable to begin with.

- **More stable context per request** — a large system prompt assembled
  from MCP tool servers (e.g. a knowledge/handbook server), a stack of
  hooks (session-start briefing, skill-activation, config-protection, etc.),
  skills, and per-project instruction files all add tokens to the system
  prompt / tool definitions sent on *every single call*, and that content is
  largely identical call to call. A bigger stable block relative to what's
  actually new in a given turn mechanically produces a bigger multiplier
  when cached well — there's simply more to cache in the first place,
  compared to a minimal system prompt with few tools.
- **More parallel/concurrent agent traffic** — the write-coordination
  feature (WriteBarrier) exists specifically to stop N concurrent
  identical-prefix requests from each separately paying to write the cache.
  A single interactive user rarely generates true concurrent duplicate-
  prefix traffic. A fan-out-heavy setup (many parallel orchestrated agents/
  workers hitting the same prefix around the same time) generates this
  constantly, so there's more for that specific mechanism to save.

## But most Claude Code users would still see *some* benefit — just smaller

Two of the mechanisms apply regardless of setup size, not just to
heavy-tooling users:

- **Breakpoint placement** helps anyone whose client isn't already placing
  cache breakpoints optimally — a client-side default, unrelated to how many
  tools someone runs.
- **The baseline deferral targets** (scratchpad paths, session-id metadata,
  session URLs) are Claude-Code-specific noise, not custom-tooling-specific —
  they apply to essentially any Claude Code user.

So the shape of the answer: the floor isn't zero for a typical, lighter user,
but the ceiling scales with exactly the two things a heavy-tooling,
heavy-parallelism setup has a lot of — stable context volume and parallel
agent fan-out. A lighter, single-session user with a small system prompt and
few tools would plausibly land closer to 1.5–3x than 6–8x — not because the
mechanism doesn't apply to them, but because there's mechanically less
stable content and less concurrent traffic for it to act on. This last
estimate (1.5–3x for a lighter user) is reasoned from the mechanism, not
independently measured against a real lighter-weight deployment — flagged
here as the unverified part of this analysis, worth confirming against real
data from a smaller setup if that becomes available.
