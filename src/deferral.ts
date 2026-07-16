import type { AnthropicRequestLike, ContentBlock, Extractor, MovedSpan } from './types.js'
import type { CacheAssemblerConfig, ResolvedConfig } from './config.js'
import { resolveJsonPath, type PathAccessor } from './json-path.js'
import { prefixHash } from './prefix-hash.js'
import { canonicalizeRequest } from './canonicalize.js'

const RELOCATION_BLOCK_TYPE = 'text'

function toAccessorList(resolved: PathAccessor | PathAccessor[]): PathAccessor[] {
  return Array.isArray(resolved) ? resolved : [resolved]
}

function compileMatcher(extractor: Extractor): RegExp {
  return new RegExp(extractor.pattern, extractor.flags ?? '')
}

function extractSpans(req: AnthropicRequestLike, extractors: Extractor[]): { req: AnthropicRequestLike; moved: MovedSpan[] } {
  const clone = structuredClone(req)
  const moved: MovedSpan[] = []

  for (const extractor of extractors) {
    const matcher = compileMatcher(extractor)
    const accessors = toAccessorList(resolveJsonPath(clone, extractor.path))
    for (const accessor of accessors) {
      if (!accessor.exists) continue
      const value = accessor.get()
      if (value === undefined) continue
      const match = matcher.exec(value)
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
