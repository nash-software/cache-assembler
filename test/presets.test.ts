import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPreset } from '../src/presets.js'
import { resolveJsonPath } from '../src/json-path.js'
import type { AnthropicRequestLike } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(here, 'fixtures', 'claude-code-session.json')

function loadFixture(): AnthropicRequestLike {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as AnthropicRequestLike
}

describe('presets', () => {
  it('loads the built-in claude-code preset and validates against the extractor schema', () => {
    const preset = loadPreset('claude-code')
    expect(preset.name).toBe('claude-code')
    expect(typeof preset.version).toBe('string')
    expect(typeof preset.description).toBe('string')
    expect(preset.extractors.length).toBeGreaterThanOrEqual(3)
    for (const extractor of preset.extractors) {
      expect(typeof extractor.id).toBe('string')
      expect(typeof extractor.path).toBe('string')
      expect(typeof extractor.pattern).toBe('string')
    }
  })

  it('extracts every planted session-variant span from the synthetic Claude Code session fixture', () => {
    const preset = loadPreset('claude-code')
    const fixture = loadFixture()

    expect(fixture.tools?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(fixture.messages.length).toBeGreaterThanOrEqual(4)

    for (const extractor of preset.extractors) {
      const matcher = new RegExp(extractor.pattern, extractor.flags ?? '')
      const resolved = resolveJsonPath(fixture, extractor.path)
      const accessors = Array.isArray(resolved) ? resolved : [resolved]
      const matchedSomewhere = accessors.some((accessor) => {
        const value = accessor.get()
        return typeof value === 'string' && matcher.test(value)
      })
      expect(matchedSomewhere, `extractor "${extractor.id}" should match some value at path "${extractor.path}"`).toBe(true)
    }
  })

  it('throws a user-friendly error naming the invalid field for a malformed preset', () => {
    const badPresetPath = join(tmpdir(), `bad-preset-${Date.now()}.json`)
    writeFileSync(badPresetPath, JSON.stringify({ name: 'bad', version: '1.0.0', description: 'bad' }), 'utf8')
    try {
      expect(() => loadPreset(badPresetPath)).toThrow(/extractors/i)
    } finally {
      rmSync(badPresetPath)
    }
  })

  it('rejects a preset whose extractors entry is missing a required field, naming it', () => {
    const badPresetPath = join(tmpdir(), `bad-preset-extractor-${Date.now()}.json`)
    writeFileSync(
      badPresetPath,
      JSON.stringify({ name: 'bad', version: '1.0.0', description: 'bad', extractors: [{ id: 'x', path: 'a' }] }),
      'utf8',
    )
    try {
      expect(() => loadPreset(badPresetPath)).toThrow(/pattern/i)
    } finally {
      rmSync(badPresetPath)
    }
  })
})
