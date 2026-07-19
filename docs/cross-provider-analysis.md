# Would this work for other providers? (Codex, Gemini, OpenCode, etc.)

Research done 2026-07-19. This looks at whether cache-assembler's approach —
built specifically against Anthropic's Messages API — transfers to other
providers, either as-is or with rework.

## Direct compatibility today: only genuine Anthropic-wire-format traffic

cache-assembler is a pure JSON-rewriting HTTP proxy — it doesn't care what
client sent a request, only that the body is in Anthropic's Messages API
shape (`system`, `messages`, `cache_control` blocks). It works unmodified for
anything speaking that exact protocol.

| Client | Works today | Why |
|---|---|---|
| Claude Code | Yes | Already proven in production |
| OpenCode, configured to use Anthropic as its backend | Yes | OpenCode is a multi-backend agent (Anthropic, OpenAI, Gemini, Bedrock, Azure, Groq, OpenRouter, Ollama — 75+ via the Vercel AI SDK); when pointed at Anthropic it emits genuine Messages API requests, so this is the same case as Claude Code |
| OpenCode, configured for OpenAI/Gemini/other backend | No | Inherits that provider's blockers below |
| Codex CLI | No | Different wire format (OpenAI Responses API, `/v1/responses`) |
| Gemini CLI/API | No | Different wire format, different caching paradigm entirely |

## Codex / OpenAI: different protocol, different caching model, but the underlying problem still exists

- **Wire format**: OpenAI Responses API — different field names and content-block
  shapes than Anthropic's Messages API. None of cache-assembler's JSON-path
  logic resolves against it as-is.
- **Caching model**: mostly *automatic* — the API auto-caches the longest
  matching prefix ≥1024 tokens, no explicit breakpoints needed, for most
  models. GPT-5.6 (GA July 9, 2026) added an opt-in explicit-breakpoint mode
  with its own field names, a 1.25× cache-write premium, and a 30-min TTL.
- **Does the underlying problem still apply?** Yes, and in one respect more
  acutely than for Anthropic. Confirmed independently (not just reasoned by
  analogy): production teams have seen **30 percentage points of cache
  hit-rate gain** from deterministically sorting tool schemas before sending
  — the exact class of bug F1 (canonicalization) already fixes for Anthropic.
  With Anthropic's *explicit* breakpoints, you choose where the cache
  boundary sits, so volatile content placed after your last breakpoint never
  touches the cache. With OpenAI's *automatic* longest-prefix match, there's
  no such boundary to hide behind — a volatile island early in the prompt
  (a session ID, a timestamp) truncates the entire matchable cache at that
  point, even if everything after it is otherwise identical. Deferring
  volatile content out of the way (F3's job) is arguably *more* load-bearing
  here, not less, precisely because there's no manual control to route
  around it.
- **What wouldn't transfer**: F2 (breakpoint placement) has no direct
  equivalent for the default automatic-caching case — there's nothing to
  place. It would only apply for GPT-5.6's opt-in explicit mode, and would
  need a from-scratch implementation against that API's own field names.
- **A separate, unrelated cache-breaking issue Codex has**: automatic context
  compaction, triggered when a session nears its context-window limit,
  rewrites conversation history and resets the cache regardless of
  serialization quality. No amount of canonicalization or deferral fixes
  this — it would need an entirely different kind of solution (e.g.
  preserving cache-stable regions across a compaction event).

## Gemini: different protocol, fundamentally different caching paradigm

- **Wire format**: Gemini's own API shape (`contents`, `systemInstruction`) —
  not Anthropic's Messages API.
- **Caching model**: explicit but *out-of-band* — you `create()` a cache as
  its own resource with an ID and TTL, then *reference that ID* in later
  calls, rather than annotating blocks inline within each request. This is a
  different paradigm than "mark a block ephemeral inline, per-request."
- **Does the underlying problem still apply?**
  - F1's purpose (a stable identity hash for "is this the same prefix I've
    already cached") still applies — just serving a different decision
    (should I create a new cache object or reference an existing one) rather
    than "will the API's own hash auto-match this."
  - F3's purpose (separate volatile bytes from the stable region before
    deciding what to persist) still applies to deciding what belongs *inside*
    a created cache object vs. sent fresh every call.
  - The write-coordination idea (WriteBarrier: only one concurrent identical
    request pays to establish the cache, the rest wait and reuse it) maps
    cleanly here, and arguably matters *more* than for Anthropic: Gemini's
    explicit caches carry an ongoing **storage cost** ($4.50/M tokens/hour)
    independent of whether they're ever read again, so N agents racing to
    each create a duplicate cache for the same content isn't just a wasted
    write — it's an ongoing cost until someone remembers to expire it. This
    specific claim is reasoned from the mechanism, not independently
    evidenced with a case study the way the OpenAI canonicalization number
    above is — worth treating as the weaker-confidence claim of the three.
- **What wouldn't transfer**: F2 as currently built (inline breakpoint
  placement) has no equivalent at all — Gemini has no in-request breakpoint
  concept. The analogous decision (what to include in a created cache object)
  would need a genuinely different implementation.

## Bottom line

Real, evidenced benefit — not just "in theory." But it's three separate
from-scratch builds, one per provider's actual wire format and caching
mechanism, sharing this codebase's underlying design philosophy (stabilize
what should be stable, separate what's actually volatile, don't pay twice
for the same cache write) rather than sharing any code. The OpenAI case has
the strongest independent evidence behind it of the three.

### Sources
- [Optimize JSON property order for prompt caching · openai/openai-java #316](https://github.com/openai/openai-java/issues/316)
- [Anthropic vs OpenAI Prompt Caching 2026: Cost Math + 3 Cache-Miss Fixes](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/)
- [Prompt Caching for AI Agents: How to Cut Cost and Latency Without Breaking Context](https://medium.com/toward-next-ai/prompt-caching-for-ai-agents-how-to-cut-cost-and-latency-without-breaking-context-245dc2502b4b)
- [Prompt Caching in Codex CLI: How the Agent Loop Stays Linear](https://codex.danielvaughan.com/2026/04/21/codex-cli-prompt-caching-maximise-cache-hits-cost-reduction/)
- [Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks (arXiv 2601.06007)](https://arxiv.org/pdf/2601.06007)
- [Gemini API Context Caching: Complete Guide (2026)](https://www.aifreeapi.com/en/posts/gemini-api-context-caching-reduce-cost)
- [Prompt caching | OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Context caching | Gemini API | Google AI for Developers](https://ai.google.dev/gemini-api/docs/caching)
- [OpenCode Deep Dive: Provider-Agnostic AI CLI in 2026](https://sanj.dev/post/opencode-deep-dive-2026/)
