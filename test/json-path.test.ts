import { describe, expect, it } from 'vitest'
import { resolveJsonPath, setJsonPath, type PathAccessor } from '../src/json-path.js'

describe('resolveJsonPath', () => {
  it('resolves a simple field path that exists', () => {
    const obj = { model: 'claude', system: 'hello' }
    const accessor = resolveJsonPath(obj, 'model') as PathAccessor
    expect(accessor.exists).toBe(true)
    expect(accessor.get()).toBe('claude')
  })

  it('resolves a nested dotted field path', () => {
    const obj = { a: { b: { c: 'deep value' } } }
    const accessor = resolveJsonPath(obj, 'a.b.c') as PathAccessor
    expect(accessor.exists).toBe(true)
    expect(accessor.get()).toBe('deep value')
  })

  it('resolves an indexed array path', () => {
    const obj = { tools: [{ description: 'first' }, { description: 'second' }] }
    const accessor = resolveJsonPath(obj, 'tools[1].description') as PathAccessor
    expect(accessor.exists).toBe(true)
    expect(accessor.get()).toBe('second')
  })

  it('handles missing paths gracefully, reporting exists:false', () => {
    const obj = { a: { b: 'value' } }
    const accessor = resolveJsonPath(obj, 'a.missing.field') as PathAccessor
    expect(accessor.exists).toBe(false)
    expect(accessor.get()).toBeUndefined()
  })

  it('handles a missing array index gracefully', () => {
    const obj = { tools: [{ description: 'only one' }] }
    const accessor = resolveJsonPath(obj, 'tools[5].description') as PathAccessor
    expect(accessor.exists).toBe(false)
  })

  it('expands a wildcard [*] over an array into multiple accessors', () => {
    const obj = { system: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }
    const accessors = resolveJsonPath(obj, 'system[*].text') as PathAccessor[]
    expect(Array.isArray(accessors)).toBe(true)
    expect(accessors).toHaveLength(3)
    expect(accessors.map((a) => a.get())).toEqual(['one', 'two', 'three'])
  })

  it('wildcard over a missing array returns an empty accessor list', () => {
    const obj = { system: 'not an array' }
    const accessors = resolveJsonPath(obj, 'system[*].text') as PathAccessor[]
    expect(accessors).toEqual([])
  })
})

describe('setJsonPath', () => {
  it('sets a string-valued leaf at an existing path without mutating the input', () => {
    const obj = { system: [{ text: 'old' }] }
    const updated = setJsonPath(obj, 'system[0].text', 'new') as { system: { text: string }[] }
    expect(updated.system[0]!.text).toBe('new')
    expect(obj.system[0]!.text).toBe('old')
  })

  it('sets every match for a wildcard path', () => {
    const obj = { system: [{ text: 'one' }, { text: 'two' }] }
    const updated = setJsonPath(obj, 'system[*].text', 'redacted') as { system: { text: string }[] }
    expect(updated.system.map((b) => b.text)).toEqual(['redacted', 'redacted'])
  })

  it('is a no-op when the path does not exist', () => {
    const obj = { a: 'value' }
    const updated = setJsonPath(obj, 'missing.field', 'x')
    expect(updated).toEqual(obj)
  })

  it('does not traverse into Object.prototype via a __proto__ segment (audit finding LOW-10)', () => {
    const obj = { a: 'value' }
    setJsonPath(obj, '__proto__.polluted', 'x')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does not traverse into a shared prototype via a constructor.prototype segment (audit finding LOW-10)', () => {
    const obj = { a: 'value' }
    setJsonPath(obj, 'a.constructor.prototype.toString', 'polluted')
    expect(typeof Object.prototype.toString).toBe('function')
  })

  it('reports __proto__/constructor/prototype segments as not existing rather than as inherited members', () => {
    const obj = { a: 'value' }
    const accessor = resolveJsonPath(obj, 'constructor.name') as PathAccessor
    expect(accessor.exists).toBe(false)
    expect(accessor.get()).toBeUndefined()
  })
})
