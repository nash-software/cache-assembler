# cache-assembler: what it does, what we measured, and how to verify it yourself

`cache-assembler` is a small, dependency-free library and standalone HTTP proxy
that rewrites Anthropic Messages API requests to maximize prompt-cache reuse.
Point your client at the proxy instead of `api.anthropic.com` and it
canonicalizes, arranges, and annotates each request so that as much of it as
possible is served from Anthropic's prompt cache at ~0.1x the base input price.

**TL;DR:** we sent the same conversation to the real Claude API twice - once
normally, once through cache-assembler. Direct cost $1.33, through the proxy
$0.16. That's an 8.2x reduction, zero errors either way, on the real API,
not a simulation. Testing against the real API also found four genuine bugs
that our own unit tests had missed, all fixed and written up honestly below
rather than quietly patched. Everything here is reproducible with your own
Anthropic API key for about a pound fifty - the how-to is near the bottom.

This document is the validation report for the initial public release. Every
number below was cross-checked against the raw data and test scripts (all
included in this repository), and it is organized by strength of evidence: a
controlled A/B experiment first, then projections, then supporting evidence,
then everything we know is still unproven.

**Headline result, up front:** an identical 100-turn conversation sent to the
real Anthropic API twice - once directly, once through the proxy - cost
**$1.33 direct vs $0.16 proxied** (Claude Haiku 4.5, real API, zero errors in
either arm). That is an **8.2x cost reduction**, and because Anthropic's cache
pricing multipliers are uniform proportions of each model's base price, the
ratio carries over to every model - only the absolute dollars scale.

---

## What the tool actually does

Five features, each individually toggleable:

| | Feature | What it does |
|---|---|---|
| F1 | **Canonicalization** | Deterministic JSON key ordering for tool definitions, so the same tools produce the same bytes every time - even when a client library serializes them inconsistently. |
| F2 | **Breakpoint placement** | Places up to 4 `cache_control` breakpoints (the API's per-request budget) at the highest-value boundaries, tiered `1h` then `5m`, without ever modifying a breakpoint the client set itself. |
| F3 | **Volatile-byte deferral** | Relocates session-unique spans (scratchpad paths, session IDs - matched by configurable regex extractors) out of the stable prefix into a trailing block. Opt-in, off by default. |
| F4 | **Write barrier** | Coordinates concurrent requests that share an identical not-yet-cached prefix so only the first pays the cache-write premium; the rest wait briefly and read what it just wrote. |
| F5 | **Telemetry** | Tracks cache reads/writes/tokens and estimates dollar savings, with optional per-request JSONL tracing. |

Why any of this matters: Anthropic prompt caching is a strict byte-prefix
match. One byte out of place near the front of a request - an unstably
serialized tool definition, a session ID embedded in the system prompt -
invalidates the cache for everything after it. Cache reads cost ~0.1x base
input price and 5-minute-tier writes cost 1.25x, so the difference between
"cache poisoned every turn" and "cache hit every turn" is roughly an order of
magnitude on input cost.

---

## The controlled experiment

This is the centerpiece of the evidence, and the part you can reproduce
yourself (instructions [below](#reproduce-it-yourself)).

### Method

A deterministic ~100-turn coding-assistant conversation is generated from a
fixed seed: a realistic system prompt (padded with stable project-conventions
text so the prefix comfortably clears Anthropic's minimum cacheable-prompt
floor), two tool definitions, and a message history that grows by one exchange
per turn. The same seed produces byte-identical output every run.

The identical content is then sent twice, against the real Anthropic API,
authenticated with a real Anthropic API key:

- **Arm A - direct:** straight to `api.anthropic.com`. cache-assembler is
  entirely out of the loop.
- **Arm B - proxied:** through a local cache-assembler instance with the full
  feature stack enabled.

Same model (`claude-haiku-4-5-20251001`, chosen to keep the real-dollar cost
of the experiment low - the caching mechanics are model-agnostic), same tools,
same growing history, 100 requests per arm, `max_tokens: 1` on every call
(only the `usage` accounting matters, not generated text).

Two properties make the comparison clean:

1. **The constructed content contains zero `cache_control` fields** -
   verified by grepping the generated request bodies. Any breakpoint that
   reaches the wire in arm B is placed by cache-assembler; arm A carries none
   at all. Without that field the API has no instruction to create or check a
   cache entry, which is why arm A mechanically shows zero cache activity on
   all 100 turns - that is real "no caching mechanism" behavior on real
   infrastructure, not a synthetic stand-in.
2. **Both arms process the same content.** Total token volume: 1,329,304
   (arm A) vs 1,333,104 (arm B) - a 0.3% difference from the cache-control
   metadata itself. The cost difference is attributable to how the tokens
   were billed, not to what was sent.

### Results

Raw per-turn data for both arms: [`validation-data/raw-data/ab-test-results.json`](validation-data/raw-data/ab-test-results.json).

| Arm | Requests | Uncached input tokens | Cache-write tokens | Cache-read tokens | Real cost (Haiku 4.5 pricing) |
|---|---:|---:|---:|---:|---:|
| A - direct | 100 | 1,329,304 | 0 | 0 | **$1.3293** |
| B - proxied | 100 | 18,165 | 11,172 | 1,303,767 | **$0.1625** |

**8.2x cost reduction. Zero errors in either arm.**

Costs are computed from the token counts at published Claude Haiku 4.5 pricing
($1.00/MTok base input, $1.25/MTok 5-minute cache write, $0.10/MTok cache
read). All of arm B's cache writes were confirmed 5-minute-tier (the
`cache_creation` breakdown in the raw responses shows 11,172 tokens at the
5m tier and 0 at the 1h tier), so 1.25x - not the 2x 1-hour-tier rate - is the
correct write multiplier for these numbers and for the projections below.

> **Two transparency notes.**
> **(1)** An earlier internal draft of this table computed the dollar figures
> at $0.80/MTok - the price of the *previous* Haiku generation - showing
> $1.06 vs $0.13. This was caught in review and corrected above using the
> actual Haiku 4.5 price. The 8.2x ratio is identical either way, since both
> arms scale by the same factor.
> **(2)** Arm B's turn 1 shows a cache *read* of 7,194 tokens rather than the
> cold write you'd expect. Cause: a small smoke test with the identical
> deterministic content (same seed, same bytes, same cache key) ran moments
> before the official run, and its turn-1 write - exactly 7,194 tokens - was
> still inside Anthropic's 5-minute TTL. The result is unaffected (arm A
> never caches regardless of timing, and every number above is the literal,
> unmodified value the API returned), but the true cold write happened one
> script invocation earlier than the official log shows. If you reproduce the
> experiment twice within five minutes you will see the same effect.

---

## What that saves at realistic usage levels

The measured per-session token shape scales linearly with usage and with each
model's base price, so projected savings are a straightforward multiplication.
**These are extrapolations from one measured 100-turn session, not new
measurements at each scale** - treat them as estimates. Conventions: "week" =
5 working days, "month" = 21 working days.

Priced at Claude Sonnet 5 **standard** rates ($3/MTok base - the rate in
effect after the introductory pricing period ends 2026-08-31), each session
of this measured shape costs $3.99 direct vs $0.49 proxied, saving **$3.50
per session**. Find your own usage pattern:

| Usage tier | Sessions/day | Saved / day | Saved / week | Saved / month |
|---|---:|---:|---:|---:|
| Solo developer, light use | 3 | $10.50 | $52.51 | $220.52 |
| Solo developer, daily agentic use | 10 | $35.00 | $175.02 | $735.08 |
| Small team (3–5 people) | 30 | $105.01 | $525.06 | $2,205.25 |
| Growing team, regular agent dispatch | 100 | $350.04 | $1,750.20 | $7,350.82 |
| Large automated fleet (upper bound) | 324 | $1,134.13 | $5,670.63 | $23,816.67 |

By model, per session of the measured shape (the ~8.2x ratio is identical
across every row - cache multipliers are fixed proportions of base price, so
the ratio is base-price-invariant by construction; only absolute dollars
change):

| Model | Per session, direct | Per session, proxied | Saved |
|---|---:|---:|---:|
| Haiku 4.5 | $1.33 | $0.16 | $1.17 |
| Sonnet 5 (introductory, through 2026-08-31) | $2.66 | $0.33 | $2.33 |
| Sonnet 5 (standard) | $3.99 | $0.49 | $3.50 |
| Opus 4.8 | $6.65 | $0.81 | $5.83 |
| Fable 5 | $13.29 | $1.63 | $11.67 |

At the largest scales the numbers get big - a 324-sessions/day fleet on the
most expensive model projects to roughly $79k/month - but if you're evaluating
this tool, the honest anchor is the row that describes you, times the models
you actually run.

Raw data: [`validation-data/raw-data/model-projections.json`](validation-data/raw-data/model-projections.json),
[`validation-data/raw-data/realistic-tiers.json`](validation-data/raw-data/realistic-tiers.json).

**Important calibration:** these projections compare against a client that
does *no* caching (arm A carries zero `cache_control`). A well-behaved client
- the official `claude` CLI, for instance - already sets at least one
breakpoint on its own and caches substantially by default (see
["A comparison we ran and rejected"](#a-comparison-we-ran-and-rejected)).
Against such a client, cache-assembler's marginal value comes from the failure
modes the client doesn't handle - unstable tool serialization, volatile bytes
in the prefix, concurrent cold-start writes - not from introducing caching
where there was none. If your client already caches perfectly, your savings
will be smaller than this table.

---

## Why it works: a feature-by-feature mechanism study

Before spending real money, each feature was isolated in a synthetic harness:
an in-process HTTP stub stands in for the Anthropic API, but every request
passes through the real `assemble()` pipeline (canonicalize → defer → place
breakpoints → hash), and cache hit/miss is a genuine function of whether the
assembled bytes stayed prefix-identical turn to turn - not a canned number.
30 simulated sessions × 6 turns per layer; each layer enables one more
feature. Raw data: [`validation-data/raw-data/synthetic-layers.json`](validation-data/raw-data/synthetic-layers.json).

| Layer | Configuration | Cache hit rate |
|---|---|---:|
| L0 | No proxy at all | 0.0% |
| L1 | Breakpoints placed, **no** canonicalization, tool key-order jittered per turn | 3.9% |
| L2 | + canonicalization (same jittered input) | 83.3% |
| L3 | + write barrier (no effect expected on solo sessions) | 83.3% |
| L4 | + deferral in dry-run preview mode (no bytes changed) | 83.3% |
| L5 | + deferral active | 99.4% |

The L1→L2 flip is the key mechanism result. With breakpoints placed but
unstable tool-serialization order, the cache is poisoned almost completely -
tool definitions sit at the very front of the prefix, so one reordered key
invalidates everything after it. Worse than useless, in fact: at L1 the
harness estimates a net *loss*, because every request still pays the 1.25x
cache-write premium and almost nothing is ever read back. Canonicalization
alone flips that to an 83% hit rate. Deferral then removes the per-session
volatile bytes from the prefix, letting even the first turn of a new session
read cache written by other sessions (99.4% - exactly one cold miss across
all 30 sessions).

Honest caveats on this study:

- The L1 jitter is a **constructed** failure mode, engineered to prove F1's
  mechanism works *when unstable serialization occurs*. We did not verify
  that current real-world Claude clients actually jitter tool order this way.
- The harness's dollar estimates are stub-model approximations; treat the hit
  rates as the finding and the synthetic dollar figures as directional. The
  real-dollar evidence is the A/B experiment above.

The write barrier's specific property was proven separately in the same
harness: 8 simulated sessions fired at the same instant with an identical
not-yet-cached prefix produce **1** cache write with the barrier on and **8**
with it off. This property has *only* been validated synthetically - see
[Known limitations](#known-limitations).

---

## Battle-testing against the real API

Synthetic tests and unit suites all passed - and then deliberately pointing
real traffic at the real API found four genuine bugs that none of them had
caught. All four are fixed, with regression tests, in this repository's
history; the commit messages were written when each fix landed and can be
read in full in the git log.

1. **Invalid cache TTL ordering (400 error), first direction.** The API
   requires TTL priority to be non-increasing across a request (`1h` can
   never follow `5m`). The placement logic tiered TTLs only within its own
   newly-placed batch, ignoring pre-existing client-set breakpoints - and a
   client breakpoint with no explicit TTL defaults to `5m` server-side. A
   real request with an existing client breakpoint got a `1h` block placed
   after it: 400.
2. **The mirror case.** The first fix handled existing *lower*-tier
   breakpoints forcing new placements down; a second live 400 revealed the
   opposite direction (an existing `1h` breakpoint after a new placement).
   The batch-position heuristic was replaced with a two-pass algorithm that
   computes a ceiling and floor rank for every new candidate, cascading
   right-to-left. An honest note: the first fix being incomplete is itself
   evidence for why live testing matters - the mirror case survived the
   first fix's review and tests.
3. **Telemetry silently blind to compressed responses.** The proxy forwarded
   the client's `accept-encoding` upstream verbatim, the upstream gzipped its
   response, and the usage extractor - which had no decompression path -
   silently parsed garbage and recorded nothing. Clients got perfectly valid
   responses; the proxy's stats stayed at zero forever. Fixed by forcing
   `accept-encoding: identity` upstream, with an integration test proving the
   old behavior failed silently against a gzipped response.
4. **Economics formula inflated every reported dollar figure.** The savings
   estimate netted the write premium against a baseline that included both
   creation *and* read token volume instead of creation-only - inflating
   reported savings by exactly `2 × readTokens × readPrice`. The existing
   unit tests missed it because one fixture coincidentally used equal
   read/write token counts, where the error term vanishes. It only diverges
   when reads substantially outnumber writes - the realistic shape of any
   long cached conversation. Caught by hand-recomputing a real production
   stats readout ($87.44 reported vs $70.69 honest). **Every dollar figure
   in this report uses the corrected formula.**

### The production run

As a final shakedown, the proxy carried genuine production traffic: a fleet
of nine coding agents was dispatched in parallel to fix nine real,
independently verified bugs in a separate internal codebase - bugs that had
themselves been found moments earlier by a ten-agent automated investigation
run through the same proxy. Every request from every agent - tool calls, file
reads, test runs, version-control operations - passed through cache-assembler
on its way to the real Anthropic API.

**Worth being precise about how this traffic got there:** this wasn't a raw
API key billed per token. It was the real Claude Code CLI, run normally, with
its `ANTHROPIC_BASE_URL` environment variable pointed at a locally-hosted
cache-assembler instance instead of `api.anthropic.com` directly - genuine
Claude subscription usage, not metered API billing. cache-assembler only
rewrites the request body; it forwards your own authentication through
unchanged. The dollar figures below are still a meaningful measure of value -
they're computed from the actual token counts at Anthropic's published
per-token API rates, which is the honest way to express what the caching
behavior saved, even though a subscription doesn't bill per-token directly.
See [README - Using with Claude Code](../README.md#using-with-claude-code)
for how to set this up yourself.

As reported by the (corrected) telemetry: 927 requests, 105.6M cache-read
tokens against 2.6M cache-creation tokens (a ~40x reuse ratio), an estimated
$277 net saved, zero request failures, and zero cache-ordering violations
across 933 traced requests. This run is real-world evidence that the proxy
holds up under concurrent agentic load - but it is deliberately *not* the
headline: it has no control arm, the agents ran organically mixed models, and
its aggregate is a self-report of the proxy's own telemetry rather than an
independently re-derivable dataset. The A/B experiment is the causal evidence;
this is the road test.

One structural finding from the run is worth passing on to anyone analyzing
multi-agent traffic through a proxy like this: the proxy sees no built-in
per-subagent identity. The only session header the client sends identifies
the *parent* orchestrating process - all nine agents shared one value. What
does recover per-agent structure is clustering by **prefix hash** (the hash
cache-assembler computes over each request's stable prefix): each agent's
conversation diverges from every other's at its first, differing task
instruction, so distinct prefix-hash lineages map one-to-one onto agents. That
clustering found exactly nine substantial multi-turn threads - matching the
nine dispatched fixes - plus 27 trivial one-shot calls.

---

## A comparison we ran and rejected

During validation we attempted to compare the production run's ~40x cache
reuse ratio against pre-existing usage history from the same operator's
ordinary (non-proxied) Claude Code sessions - roughly 520 historical session
transcripts, with one session closely matched in request count pulled out for
a side-by-side. The historical baseline's own read-to-write ratio came out at
41.6x - statistically indistinguishable from the proxied run's 40.1x.

**We are not presenting that comparison as evidence of anything, in either
direction, and neither should you.** The two sessions were different
projects, different tasks, different tool sets, different system prompts;
any difference (or absence of one) is confounded by "these are different
workloads." It was a methodological mistake, caught during validation, and
the controlled A/B experiment above was run precisely because this comparison
couldn't isolate the tool's effect.

What the exercise *did* legitimately establish is context: ordinary,
well-behaved Claude client traffic already caches quite well by default. The
official client sets at least one `cache_control` breakpoint on its own -
independently confirmed by bug 1's root cause, which was a real client-set
breakpoint colliding with the proxy's placement. cache-assembler is not "the
difference between no caching and full caching" for such a client; it is
insurance against the specific failure modes that silently poison an
otherwise-cached prefix, plus coordination that no single client can do alone.

---

## Known limitations

Read these before adopting. None are hidden in footnotes above; this is the
consolidated list.

- **The write barrier's concurrency-collapse property (F4) has only been
  validated synthetically** - 8 simulated simultaneous sessions, 1 write vs 8.
  The production run could not exercise it, because each agent's first
  instruction differed, so no two agents ever shared an identical uncached
  prefix. No real-traffic validation exists yet.
- **All projections extrapolate a single measured 100-turn session.** They
  scale linearly by sessions/day and by model base price; they are not new
  measurements at each listed scale, and your sessions' shape (turn count,
  prefix size, read/write mix) will differ.
- **The production run was organic, not controlled**: subagent models were
  not pinned, so it is a mixed-model road test, not a single-model benchmark
  - and its aggregates come from the proxy's own telemetry rather than an
  independently auditable raw dataset.
- **The four bugs were found by progressive, honest testing - not an
  exhaustive adversarial audit.** The absence of further known bugs is not a
  claim that none exist.
- **The synthetic study's L1 failure mode (tool-order jitter) is constructed**
  and was not verified to occur in current real client traffic.
- **Sonnet 5's introductory pricing expires 2026-08-31.** Tables above that
  use Sonnet pricing default to the standard (post-transition) rate;
  introductory-rate figures are labeled where shown.

---

## Reproduce it yourself

The A/B experiment needs a real Anthropic API key with billing enabled and
costs about **$1.50** in real usage (arm A is ~$1.33 of deliberately
uncached Haiku traffic; arm B is ~$0.16).

**Prerequisites:** Node.js 18+ (uses built-in `fetch`), an Anthropic API key
from [console.anthropic.com](https://console.anthropic.com/settings/keys),
and this repository.

**1. Get an API key** from the Anthropic Console and save it to a file:

```sh
echo "sk-ant-api03-..." > key.txt
```

**2. Start the cache-assembler proxy** (full feature stack on):

```sh
cache-assembler --upstream https://api.anthropic.com --preset claude-code --defer --port 8789
```

**3. Run both arms.** From the `docs/validation-data/scripts/` directory:

```sh
node run-ab-test.mjs 100 ./key.txt http://127.0.0.1:8789/v1/messages
```

The script builds the 100-turn deterministic content once
(`build-turns.mjs` + `fixture.json`, same seed → byte-identical output every
run), sends arm A directly to `api.anthropic.com`, then sends the identical
content through your local proxy as arm B, logging every turn's
`input/cache_creation/cache_read` token counts live and writing the complete
per-turn record to `results.json`.

**What to check in the output:**

- Arm A should show `create=0 read=0` on every turn - the content carries no
  `cache_control`, so the API has nothing to cache against.
- Arm B should show a large cold write on turn 1, then large `read` values
  and small `input` values on every subsequent turn.
- Sum each arm's tokens and price them at your model's published rates
  (base × input, 1.25 × base × 5m-writes, 0.1 × base × reads). The ratio
  should land near 8x for this content shape.

**Timing caveats:** if you run the script twice within 5 minutes, arm B's
turn 1 will show a cache *read* instead of a write - Anthropic's 5-minute TTL
is still warm from your previous run's identical bytes (this exact effect
appears in our own published raw data; see the transparency note in the
experiment section). Also run arm A before arm B, as the script does - the
arms don't share cache entries (arm A never writes any), but keeping the
order fixed makes runs comparable.

The fixture is turn-limited and small; feel free to raise the turn count or
edit the fixture - the deterministic generator will keep both arms
byte-identical regardless.

---

*All raw data referenced in this report ships alongside it, under
`docs/validation-data/`:* `raw-data/ab-test-results.json` (per-turn A/B
record, both arms), `raw-data/synthetic-layers.json` (mechanism study),
`raw-data/model-projections.json` and `raw-data/realistic-tiers.json`
(projection arithmetic), and `scripts/` (the reproducible experiment).
