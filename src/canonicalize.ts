import type { AnthropicRequestLike, ToolDefinition } from './types.js'
import type { CacheAssemblerConfig, ResolvedConfig } from './config.js'

/**
 * Recursively rebuilds a JSON-compatible value with object keys inserted in
 * lexicographic order at every level. Array element order and all primitive
 * values are left untouched — only object key insertion order changes, which
 * is what determines JSON.stringify's byte output.
 *
 * `result` is created with Object.create(null) rather than `{}`: a
 * request key named "__proto__" would otherwise hit Object.prototype's
 * __proto__ accessor on bracket-assignment, setting the object's prototype
 * instead of storing an own property — silently dropping that key's data
 * from the canonical form (and from the resulting prefix hash) while it's
 * still present in the original request.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue)
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of sortedKeys) {
      result[key] = canonicalizeValue((value as Record<string, unknown>)[key])
    }
    return result
  }
  return value
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value))
}

function canonicalizeTool(tool: ToolDefinition): ToolDefinition {
  return canonicalizeValue(tool) as ToolDefinition
}

/**
 * Canonicalizes a request's tool definitions for deterministic serialization:
 * recursive lexicographic key sort on every tool object (including
 * input_schema), with tool array ordering controlled by
 * cfg.canonicalize.toolOrder. Never mutates the input; never touches string
 * content values — only object key order changes.
 */
export function canonicalizeRequest(
  req: AnthropicRequestLike,
  cfg: Pick<ResolvedConfig, 'canonicalize'> | CacheAssemblerConfig,
): AnthropicRequestLike {
  if (!req.tools || req.tools.length === 0) {
    return { ...req }
  }

  const toolOrder = cfg.canonicalize?.toolOrder ?? 'preserve'
  const canonicalized = req.tools.map(canonicalizeTool)
  const ordered =
    toolOrder === 'sort-by-name'
      ? [...canonicalized].sort((a, b) => a.name.localeCompare(b.name))
      : canonicalized

  return { ...req, tools: ordered }
}
