// Builds a deterministic, realistic N-turn conversation from the same base
// fixture the synthetic harness uses (test/fixtures/claude-code-session.json),
// with volatile params substituted (scratchpad uuid, session-id, session url)
// but NO tool-order jitter and NO manually-added cache_control anywhere —
// this is the clean, identical-content baseline sent to BOTH arms of the A/B
// test. Any cache_control that ends up on the wire is cache-assembler's own
// doing (arm B) or absent entirely (arm A, direct).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FIXTURE_SCRATCHPAD_UUID = 'a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6';
const FIXTURE_SESSION_ID = '8f14e45f-ceea-467e-bd42-ce8ea5b1a12b';
const FIXTURE_SESSION_URL = 'https://claude.ai/code/session_012kpcX8paHadnC9wNqomTcE';

const CODING_TASK_TOPICS = [
  'refactor the pagination helper to avoid off-by-one errors',
  'add a retry wrapper around the flaky upstream client',
  'fix the race condition in the write-barrier follower queue',
  'extract the duplicate validation logic into a shared module',
  'write property tests for the canonicalization ordering',
  'reduce the bundle size of the CLI entrypoint',
];
const FILLER_TEXT = 'Consider edge cases, add tests, and keep functions under fifty lines. ';

function sha256Hex(seed) {
  return createHash('sha256').update(seed).digest('hex');
}
function uuidFromSeed(seed) {
  const hex = sha256Hex(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function volatileParams(runLabel) {
  const seed = `real-ab-test-${runLabel}`;
  const sessionUrlToken = sha256Hex(`${seed}-url`).slice(0, 20);
  return {
    scratchpadUuid: uuidFromSeed(`${seed}-scratchpad`),
    sessionId: uuidFromSeed(`${seed}-session`),
    sessionUrl: `https://claude.ai/code/session_${sessionUrlToken}`,
  };
}

function messageText(role, turn) {
  const topic = CODING_TASK_TOPICS[turn % CODING_TASK_TOPICS.length];
  const base = role === 'user'
    ? `Please help me with the following coding task, turn ${turn}: ${topic}. `
    : `Understood. Here is my analysis for turn ${turn} regarding: ${topic}. `;
  let text = base;
  while (text.length < 220) text += FILLER_TEXT;
  return text.slice(0, 280);
}

function buildMessagesUpTo(k) {
  const messages = [];
  for (let turn = 1; turn <= k; turn++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: messageText('user', turn) }] });
    if (turn < k) messages.push({ role: 'assistant', content: [{ type: 'text', text: messageText('assistant', turn) }] });
  }
  return messages;
}

// Anthropic requires a minimum stable-prefix size before prompt caching
// engages at all (~2048 tokens for Haiku, ~1024 for Sonnet/Opus) — the raw
// fixture alone (~250 tokens) sits well under that floor. This block is
// stable (identical every turn, no volatile content) and realistic in
// flavor (project conventions, the kind of thing a real CLAUDE.md carries),
// padding the system prompt comfortably past the threshold so caching has
// something real to engage with in both arms.
const PROJECT_CONVENTIONS_PADDING = Array.from({ length: 40 }, (_, i) => `
### Convention ${i + 1}
Functions stay under fifty lines; extract a helper rather than nesting past
two levels. Prefer explicit names over abbreviations (getUserById, not
get()). Every async operation gets a try/catch with a user-facing error
message, never a raw stack trace. Constants are UPPER_SNAKE_CASE and live
near their first use unless shared across three or more files, in which case
they move to a dedicated constants module. Tests live beside the code they
cover, not in a mirrored top-level tests/ tree. Comments explain why, never
what — if removing a comment wouldn't confuse a future reader, it shouldn't
exist. New dependencies require a one-line justification in the PR
description and must not duplicate an existing dependency's functionality.`).join('\n');

export function buildTurns(fixturePath, turns, params, model) {
  const base = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const system = base.system.map((block, i) => ({
    ...block,
    text: (i === 0 ? block.text + '\n' + PROJECT_CONVENTIONS_PADDING : block.text)
      .replace(FIXTURE_SCRATCHPAD_UUID, params.scratchpadUuid)
      .replace(FIXTURE_SESSION_ID, params.sessionId),
  }));
  const tools = base.tools.map((tool) => ({
    ...tool,
    description: tool.description?.replace(FIXTURE_SESSION_URL, params.sessionUrl),
  }));

  const requests = [];
  for (let k = 1; k <= turns; k++) {
    requests.push({
      model,
      max_tokens: 1,
      system,
      tools,
      messages: buildMessagesUpTo(k),
    });
  }
  return requests;
}
