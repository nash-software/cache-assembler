import { createHash } from 'node:crypto'
import type { AnthropicRequestLike } from './types.js'
import { canonicalStringify } from './canonicalize.js'

/**
 * Computes a sha256 hex digest over the canonical JSON serialization of a
 * request segment. When uptoIndex is provided, only messages[0..uptoIndex]
 * (inclusive) are included — used to track prefix stability up to a specific
 * message boundary (e.g. the last placed breakpoint).
 */
export function prefixHash(canonical: AnthropicRequestLike, uptoIndex?: number): string {
  const segment: AnthropicRequestLike =
    uptoIndex === undefined
      ? canonical
      : { ...canonical, messages: canonical.messages.slice(0, uptoIndex + 1) }

  const serialized = canonicalStringify(segment)
  return createHash('sha256').update(serialized).digest('hex')
}
