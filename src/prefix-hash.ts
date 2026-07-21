import { createHash } from 'node:crypto'
import type { AnthropicRequestLike } from './types.js'
import { canonicalStringify } from './canonicalize.js'

/**
 * Serializes the request segment (messages[0..uptoIndex] inclusive, or the
 * whole request when uptoIndex is undefined) into the exact canonical JSON
 * string that prefixHash() takes its digest over. Exposing this separately
 * lets callers (e.g. divergence attribution) inspect the actual prefix
 * content a hash was computed from, without the two ever being able to
 * drift apart.
 */
export function serializePrefixSegment(canonical: AnthropicRequestLike, uptoIndex?: number): string {
  const segment: AnthropicRequestLike =
    uptoIndex === undefined
      ? canonical
      : { ...canonical, messages: canonical.messages.slice(0, uptoIndex + 1) }

  return canonicalStringify(segment)
}

/**
 * Computes a sha256 hex digest over the canonical JSON serialization of a
 * request segment. When uptoIndex is provided, only messages[0..uptoIndex]
 * (inclusive) are included — used to track prefix stability up to a specific
 * message boundary (e.g. the last placed breakpoint).
 */
export function prefixHash(canonical: AnthropicRequestLike, uptoIndex?: number): string {
  const serialized = serializePrefixSegment(canonical, uptoIndex)
  return createHash('sha256').update(serialized).digest('hex')
}
