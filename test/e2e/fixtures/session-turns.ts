import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnthropicRequestLike, ContentBlock, MessageParam, SystemBlock, ToolDefinition } from '../../../src/types.js'

// The base fixture's hardcoded volatile spans — replaced with per-instance
// generated values so each simulated instance mimics fresh Claude Code
// volatile bytes (scratchpad path, session-id, session URL) while every
// other byte of the session stays identical across instances.
const FIXTURE_SCRATCHPAD_UUID = 'a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6'
const FIXTURE_SESSION_ID = '8f14e45f-ceea-467e-bd42-ce8ea5b1a12b'
const FIXTURE_SESSION_URL = 'https://claude.ai/code/session_012kpcX8paHadnC9wNqomTcE'

const MIN_MESSAGE_TEXT_LENGTH = 220
const MAX_MESSAGE_TEXT_LENGTH = 280
const SESSION_URL_TOKEN_LENGTH = 20

const CODING_TASK_TOPICS = [
  'refactor the pagination helper to avoid off-by-one errors',
  'add a retry wrapper around the flaky upstream client',
  'fix the race condition in the write-barrier follower queue',
  'extract the duplicate validation logic into a shared module',
  'write property tests for the canonicalization ordering',
  'reduce the bundle size of the CLI entrypoint',
]

const FILLER_TEXT = 'Consider edge cases, add tests, and keep functions under fifty lines. '

export interface VolatileParams {
  scratchpadUuid: string
  sessionId: string
  sessionUrl: string
}

function readFixtureFile(): AnthropicRequestLike {
  const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const fixturePath = join(packageRoot, 'fixtures', 'claude-code-session.json')
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as AnthropicRequestLike
}

function sha256Hex(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

/** Formats a 32-hex-char digest as a UUID-shaped `8-4-4-4-12` string. */
function uuidFromSeed(seed: string): string {
  const hex = sha256Hex(seed)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Deterministic per-instance volatile params that match the three
 * `presets/claude-code.json` extractor regexes verbatim, mimicking a fresh
 * Claude Code session's scratchpad path, session-id metadata, and tool
 * session URL for each simulated instance.
 */
export function defaultVolatileParams(instanceIndex: number): VolatileParams {
  const seed = `synthetic-instance-${instanceIndex}`
  const sessionUrlToken = sha256Hex(`${seed}-url`).slice(0, SESSION_URL_TOKEN_LENGTH)
  return {
    scratchpadUuid: uuidFromSeed(`${seed}-scratchpad`),
    sessionId: uuidFromSeed(`${seed}-session`),
    sessionUrl: `https://claude.ai/code/session_${sessionUrlToken}`,
  }
}

function templatedSystem(system: SystemBlock[], params: VolatileParams): SystemBlock[] {
  return system.map((block) => ({
    ...block,
    text: block.text
      .replace(FIXTURE_SCRATCHPAD_UUID, params.scratchpadUuid)
      .replace(FIXTURE_SESSION_ID, params.sessionId),
  }))
}

/**
 * Deterministic key-order shuffle: sorts an object's own keys by the hash of
 * `${seed}:${key}` rather than insertion order. Mimics the real problem F1
 * canonicalization fixes — different client libraries, or different runs of
 * the SAME library/process, serializing the same tool definition with
 * different JSON key order. Seeded by instanceIndex + turn + tool name, so
 * jitter varies **per request** (simulating a client that re-serializes
 * tools inconsistently turn to turn within one session) — not just across
 * instances, since two independent instances never share cache lineage with
 * each other anyway (each has unique volatile scratchpad/session-id
 * content), so instance-only jitter can never produce a measurable F1
 * effect. Volatile system content (scratchpad uuid, session id) is
 * deliberately NOT jittered this way — those stay stable across a session's
 * own turns, matching real Claude Code behavior; only tool serialization
 * order is modeled as request-to-request unstable.
 */
function jitterKeyOrder<T extends Record<string, unknown>>(obj: T, seed: string): T {
  const keys = Object.keys(obj).sort((a, b) => sha256Hex(`${seed}:${a}`).localeCompare(sha256Hex(`${seed}:${b}`)))
  const jittered: Record<string, unknown> = {}
  for (const key of keys) jittered[key] = obj[key]
  return jittered as T
}

function templatedTools(tools: ToolDefinition[], params: VolatileParams, instanceIndex: number, turn: number): ToolDefinition[] {
  return tools.map((tool) =>
    jitterKeyOrder(
      { ...tool, description: tool.description?.replace(FIXTURE_SESSION_URL, params.sessionUrl) },
      `synthetic-instance-${instanceIndex}-turn-${turn}-tool-${tool.name}`,
    ),
  )
}

/** Deterministic ~200-280 char coding-task message text — identical across every instance for a given (role, turn). */
function messageText(role: 'user' | 'assistant', turn: number): string {
  const topic = CODING_TASK_TOPICS[turn % CODING_TASK_TOPICS.length]
  const base =
    role === 'user'
      ? `Please help me with the following coding task, turn ${turn}: ${topic}. `
      : `Understood. Here is my analysis for turn ${turn} regarding: ${topic}. `
  let text = base
  while (text.length < MIN_MESSAGE_TEXT_LENGTH) text += FILLER_TEXT
  return text.slice(0, MAX_MESSAGE_TEXT_LENGTH)
}

function textBlockMessage(role: 'user' | 'assistant', turn: number): MessageParam {
  const block: ContentBlock = { type: 'text', text: messageText(role, turn) }
  return { role, content: [block] }
}

/** Builds messages `[u1,a1,...,u_k]` (2k-1 entries) for a session at turn k. */
function buildMessagesUpTo(k: number): MessageParam[] {
  const messages: MessageParam[] = []
  for (let turn = 1; turn <= k; turn++) {
    messages.push(textBlockMessage('user', turn))
    if (turn < k) messages.push(textBlockMessage('assistant', turn))
  }
  return messages
}

/**
 * Adapts `test/fixtures/claude-code-session.json` into a sequence of `turns`
 * full request bodies (one per turn k = 1..turns), each containing messages
 * `[u1,a1,...,u_k]` as text-block arrays. The two system blocks carry
 * `params`' volatile spans templated in place of the fixture's hardcoded
 * ones, so every turn of a given instance shares the same volatile bytes
 * (mimicking a real Claude Code session). Tool definitions get a fresh
 * per-turn key-order jitter (see `jitterKeyOrder`) — deliberately
 * non-identical raw bytes turn to turn within the SAME instance, so F1
 * canonicalization has a real effect to test: without it, tool-serialization
 * noise breaks the cache every single turn; with it, the noise is erased and
 * the cache holds.
 */
export function buildSessionTurns(instanceIndex: number, params: VolatileParams, turns = 6): AnthropicRequestLike[] {
  const base = readFixtureFile()
  const system = templatedSystem((base.system ?? []) as SystemBlock[], params)

  const requests: AnthropicRequestLike[] = []
  for (let k = 1; k <= turns; k++) {
    requests.push({
      model: base.model,
      system,
      tools: templatedTools(base.tools ?? [], params, instanceIndex, k),
      messages: buildMessagesUpTo(k),
    })
  }
  return requests
}
