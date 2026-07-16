import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Extractor } from './types.js'

export interface Preset {
  name: string
  version: string
  description: string
  extractors: Extractor[]
}

const BUILTIN_PRESET_NAMES = ['claude-code'] as const
type BuiltinPresetName = (typeof BUILTIN_PRESET_NAMES)[number]

function isBuiltinPresetName(value: string): value is BuiltinPresetName {
  return (BUILTIN_PRESET_NAMES as readonly string[]).includes(value)
}

/**
 * Built-in preset names resolve to `<package-root>/presets/<name>.json`.
 * Both the compiled (`dist/presets.js`) and source (`src/presets.ts`) module
 * locations sit one directory below the package root, so the relative
 * `../presets` segment resolves correctly either way.
 */
function resolvePresetPath(nameOrPath: string): string {
  if (isBuiltinPresetName(nameOrPath)) {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
    return join(packageRoot, 'presets', `${nameOrPath}.json`)
  }
  return nameOrPath
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid preset: "${field}" must be a non-empty string`)
  }
}

function assertExtractor(value: unknown, index: number): asserts value is Extractor {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid preset: extractors[${index}] must be an object`)
  }
  const candidate = value as Record<string, unknown>
  assertNonEmptyString(candidate.id, `extractors[${index}].id`)
  assertNonEmptyString(candidate.path, `extractors[${index}].path`)
  assertNonEmptyString(candidate.pattern, `extractors[${index}].pattern`)
  if (candidate.flags !== undefined) {
    assertNonEmptyString(candidate.flags, `extractors[${index}].flags`)
  }
}

function validatePreset(raw: unknown): Preset {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid preset: root value must be an object')
  }
  const candidate = raw as Record<string, unknown>
  assertNonEmptyString(candidate.name, 'name')
  assertNonEmptyString(candidate.version, 'version')
  assertNonEmptyString(candidate.description, 'description')
  if (!Array.isArray(candidate.extractors)) {
    throw new Error('Invalid preset: "extractors" must be an array')
  }
  candidate.extractors.forEach((extractor, index) => assertExtractor(extractor, index))

  return {
    name: candidate.name,
    version: candidate.version,
    description: candidate.description,
    extractors: candidate.extractors as Extractor[],
  }
}

/**
 * Loads and validates a preset by built-in name (e.g. `"claude-code"`) or by
 * filesystem path to a preset JSON file. Presets are pure data — no
 * executable code is ever loaded from `presets/`. Throws a user-friendly
 * error naming the first invalid field when the shape doesn't match.
 */
export function loadPreset(nameOrPath: string): Preset {
  const path = resolvePresetPath(nameOrPath)
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return validatePreset(raw)
}
