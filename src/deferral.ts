import type { AnthropicRequestLike, ContentBlock, Extractor, MovedSpan } from './types.js'
import type { CacheAssemblerConfig, ResolvedConfig } from './config.js'
import { resolveJsonPath, type PathAccessor } from './json-path.js'
import { prefixHash } from './prefix-hash.js'
import { canonicalizeRequest } from './canonicalize.js'
import { isPotentiallyCatastrophicPattern } from './regex-safety.js'

const RELOCATION_BLOCK_TYPE = 'text'

// Operator-configured extractor patterns run against request content — a
// badly-written pattern with catastrophic backtracking (e.g. `^(a+)+$`)
// combined with an adversarial value could otherwise block the single-
// threaded proxy event loop indefinitely. Bounding the tested length puts a
// hard ceiling on worst-case regex time regardless of pattern quality, since
// backtracking blowup scales with input length. Known limitation: a
// volatile span located entirely past this cutoff in a single field won't
// be found — acceptable for the realistic case (scratchpad paths, session
// IDs) where the matched span sits near the front of the field.
const MAX_EXTRACTOR_INPUT_LENGTH = 20_000

function toAccessorList(resolved: PathAccessor | PathAccessor[]): PathAccessor[] {
  return Array.isArray(resolved) ? resolved : [resolved]
}

/**
 * Returns null (skip this extractor) rather than a RegExp when the pattern
 * matches a known catastrophic-backtracking shape — see regex-safety.ts.
 * Fail-open, matching the rest of this module: a bad preset should not take
 * down the whole request pipeline.
 */
function compileMatcher(extractor: Extractor): RegExp | null {
  if (isPotentiallyCatastrophicPattern(extractor.pattern)) {
    console.error(`[cache-assembler] deferral: extractor "${extractor.id}" skipped — pattern looks like it could cause catastrophic regex backtracking`)
    return null
  }
  return new RegExp(extractor.pattern, extractor.flags ?? '')
}

function extractSpans(req: AnthropicRequestLike, extractors: Extractor[]): { req: AnthropicRequestLike; moved: MovedSpan[] } {
  const clone = structuredClone(req)
  const moved: MovedSpan[] = []

  for (const extractor of extractors) {
    const matcher = compileMatcher(extractor)
    if (matcher === null) continue
    const accessors = toAccessorList(resolveJsonPath(clone, extractor.path))
    for (const accessor of accessors) {
      if (!accessor.exists) continue
      const value = accessor.get()
      if (value === undefined) continue
      const boundedValue = value.length > MAX_EXTRACTOR_INPUT_LENGTH ? value.slice(0, MAX_EXTRACTOR_INPUT_LENGTH) : value
      // A single matcher is compiled once per extractor and reused across every
      // accessor a wildcard path resolves to (see compileMatcher above). With a
      // g/y flag, RegExp.exec keeps lastIndex on the instance between calls, so
      // without this reset a later accessor's search silently starts wherever the
      // previous accessor's match ended, dropping matches instead of finding them.
      matcher.lastIndex = 0
      const match = matcher.exec(boundedValue)
      if (!match) continue
      moved.push({ id: extractor.id, path: accessor.path, text: match[0] })
      accessor.set(value.slice(0, match.index) + value.slice(match.index + match[0].length))
    }
  }

  return { req: clone, moved }
}

function buildRelocationBlock(moved: MovedSpan[]): ContentBlock {
  const lines = moved.map((span) => `[${span.id}] ${span.text}`)
  const text = `<system-reminder>relocated volatile context:\n${lines.join('\n')}\n</system-reminder>`
  return { type: RELOCATION_BLOCK_TYPE, text }
}

function appendRelocationBlock(req: AnthropicRequestLike, moved: MovedSpan[]): AnthropicRequestLike {
  if (moved.length === 0) return req
  const messages = [...req.messages]
  const lastIndex = messages.length - 1
  const lastMessage = messages[lastIndex]
  if (!lastMessage) return req

  const existingBlocks: ContentBlock[] =
    typeof lastMessage.content === 'string' ? [{ type: 'text', text: lastMessage.content }] : [...(lastMessage.content as ContentBlock[])]

  messages[lastIndex] = { ...lastMessage, content: [...existingBlocks, buildRelocationBlock(moved)] }
  return { ...req, messages }
}

function hashRelocated(req: AnthropicRequestLike, moved: MovedSpan[]): string {
  const relocated = appendRelocationBlock(req, moved)
  const canonical = canonicalizeRequest(relocated, { canonicalize: { enabled: true, toolOrder: 'preserve' } })
  return prefixHash(canonical)
}

/**
 * F3 volatile-byte deferral: for each configured extractor, finds its
 * matching span (via the JSON path grammar), removes it from its source
 * location, and — unless dryRun is set — appends a single trailing
 * `<system-reminder>` block to the final message listing every moved span
 * verbatim. RELOCATE never DELETE: dry-run mode leaves the request
 * byte-identical and only reports what would move; prefixHashAfter still
 * reflects the hypothetical post-relocation hash (the guardrail's whole
 * point is showing the stability gain before opting in), it's just never
 * applied to the returned request.
 */
export function defer(
  req: AnthropicRequestLike,
  cfg: Pick<ResolvedConfig, 'deferral'> | CacheAssemblerConfig,
): { req: AnthropicRequestLike; moved: MovedSpan[]; prefixHashBefore: string; prefixHashAfter: string } {
  const extractors = cfg.deferral?.extractors ?? []
  const dryRun = cfg.deferral?.dryRun ?? true

  const canonicalBefore = canonicalizeRequest(req, { canonicalize: { enabled: true, toolOrder: 'preserve' } })
  const prefixHashBefore = prefixHash(canonicalBefore)

  if (extractors.length === 0) {
    return { req, moved: [], prefixHashBefore, prefixHashAfter: prefixHashBefore }
  }

  const { req: extracted, moved } = extractSpans(req, extractors)

  if (dryRun) {
    return { req, moved, prefixHashBefore, prefixHashAfter: hashRelocated(extracted, moved) }
  }

  const out = appendRelocationBlock(extracted, moved)
  const canonicalAfter = canonicalizeRequest(out, { canonicalize: { enabled: true, toolOrder: 'preserve' } })
  const prefixHashAfter = prefixHash(canonicalAfter)

  return { req: out, moved, prefixHashBefore, prefixHashAfter }
}
