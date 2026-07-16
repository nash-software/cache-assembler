// Constrained JSON path grammar for targeting string-valued leaves.
//
// Supported tokens:
//   field         object property access
//   .field        object property access (leading dot optional after [n]/[*])
//   [n]           numeric array index
//   [*]           wildcard: expands to one accessor per array element
//
// Examples: "system[*].text", "tools[*].description", "a.b.c", "tools[1].description"

export interface PathAccessor {
  path: string
  exists: boolean
  get(): string | undefined
  set(value: string): void
}

type Segment = { kind: 'field'; name: string } | { kind: 'index'; index: number } | { kind: 'wildcard' }

function parseSegments(pathStr: string): Segment[] {
  const segments: Segment[] = []
  const tokenPattern = /\[(\*|\d+)\]|\.?([A-Za-z0-9_$]+)/g
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(pathStr)) !== null) {
    const [, bracketed, field] = match
    if (bracketed === '*') {
      segments.push({ kind: 'wildcard' })
    } else if (bracketed !== undefined) {
      segments.push({ kind: 'index', index: Number(bracketed) })
    } else if (field !== undefined) {
      segments.push({ kind: 'field', name: field })
    }
  }
  return segments
}

function isIndexable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function buildAccessor(root: unknown, segments: Segment[], displayPath: string): PathAccessor {
  function walk(): { parent: Record<string, unknown>; key: string; exists: boolean } | undefined {
    let parent: unknown = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      if (!isIndexable(parent)) return undefined
      const key = seg.kind === 'field' ? seg.name : seg.kind === 'index' ? String(seg.index) : undefined
      if (key === undefined) return undefined
      parent = (parent as Record<string, unknown>)[key]
    }
    if (!isIndexable(parent)) return undefined
    const last = segments[segments.length - 1]
    const key = last?.kind === 'field' ? last.name : last?.kind === 'index' ? String(last.index) : undefined
    if (key === undefined) return undefined
    const exists = key in (parent as Record<string, unknown>)
    return { parent: parent as Record<string, unknown>, key, exists }
  }

  const located = walk()
  return {
    path: displayPath,
    exists: located?.exists ?? false,
    get(): string | undefined {
      if (!located || !located.exists) return undefined
      const value = located.parent[located.key]
      return typeof value === 'string' ? value : undefined
    },
    set(value: string): void {
      if (!located) return
      located.parent[located.key] = value
    },
  }
}

/**
 * Expands every `[*]` segment (including nested/repeated wildcards, e.g.
 * `messages[*].content[*].text`) into concrete index segments by walking the
 * object, producing one fully-concrete segment list per matched leaf.
 */
function expandWildcards(root: unknown, segments: Segment[]): Segment[][] {
  let contexts: Array<{ value: unknown; concrete: Segment[] }> = [{ value: root, concrete: [] }]

  for (const seg of segments) {
    const next: Array<{ value: unknown; concrete: Segment[] }> = []
    for (const ctx of contexts) {
      if (seg.kind === 'wildcard') {
        if (!Array.isArray(ctx.value)) continue
        ctx.value.forEach((element, i) => {
          next.push({ value: element, concrete: [...ctx.concrete, { kind: 'index', index: i }] })
        })
      } else {
        if (!isIndexable(ctx.value)) continue
        const key = seg.kind === 'field' ? seg.name : String(seg.index)
        next.push({ value: ctx.value[key], concrete: [...ctx.concrete, seg] })
      }
    }
    contexts = next
  }

  return contexts.map((ctx) => ctx.concrete)
}

/**
 * Resolves a constrained JSON path into one accessor, or — when the path
 * contains one or more `[*]` wildcard segments (including nested wildcards
 * like `messages[*].content[*].text`) — an array of one accessor per matched
 * leaf. Missing intermediate paths resolve gracefully to `exists: false`
 * rather than throwing.
 */
export function resolveJsonPath(obj: unknown, pathStr: string): PathAccessor | PathAccessor[] {
  const segments = parseSegments(pathStr)
  const hasWildcard = segments.some((s) => s.kind === 'wildcard')

  if (!hasWildcard) {
    return buildAccessor(obj, segments, pathStr)
  }

  return expandWildcards(obj, segments).map((concrete) => buildAccessor(obj, concrete, pathStr))
}

/**
 * Returns a deep-cloned copy of `obj` with the string-valued leaf(s) at
 * `pathStr` set to `value`. Wildcard paths set every matched element.
 * A no-op (returns a clone equal to the input) when the path doesn't exist.
 */
export function setJsonPath(obj: unknown, pathStr: string, value: string): unknown {
  const clone = structuredClone(obj)
  const resolved = resolveJsonPath(clone, pathStr)
  const accessors = Array.isArray(resolved) ? resolved : [resolved]
  for (const accessor of accessors) {
    if (accessor.exists) accessor.set(value)
  }
  return clone
}
