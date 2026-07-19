// Real A/B test: identical content, sent twice — once direct to the real
// Anthropic API (cache-assembler OFF), once through the local cache-assembler
// proxy (ON, full stack: canonicalization, breakpoint placement, volatile-byte
// deferral, write-barrier coordination, telemetry). Zero cache_control
// anywhere in the constructed content — any breakpoint on the wire in arm B
// is cache-assembler's own doing, none exist in arm A at all. This isolates
// cache-assembler's effect from every other confound (workload, model,
// client behavior) since both arms send byte-identical starting content.
//
// Setup:
//   1. Run `claude setup-token` (requires a Claude subscription) to produce a
//      long-lived token, and save it to a file.
//   2. Start the cache-assembler proxy: `cache-assembler --upstream
//      https://api.anthropic.com --preset claude-code --defer --port 8789`
//   3. Run: node run-ab-test.mjs <turns> <path-to-token-file> [proxy-url]
//      e.g. node run-ab-test.mjs 100 ./token.txt http://127.0.0.1:8789/v1/messages
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTurns, volatileParams } from './build-turns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIRECT_UPSTREAM = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const TURNS = Number(process.argv[2] ?? 100);
const TOKEN_PATH = process.argv[3];
const PROXY_UPSTREAM = process.argv[4] ?? 'http://127.0.0.1:8789/v1/messages';
const FIXTURE = join(__dirname, 'fixture.json');
const OUT_PATH = join(__dirname, 'results.json');

if (!TOKEN_PATH) {
  console.error('Usage: node run-ab-test.mjs <turns> <path-to-token-file> [proxy-url]');
  process.exit(1);
}

function readAccessToken() {
  const raw = readFileSync(TOKEN_PATH, 'utf8').trim();
  if (!raw.startsWith('sk-ant-oat01')) {
    throw new Error('Token file does not look like a valid long-lived setup-token (expected sk-ant-oat01 prefix).');
  }
  return raw;
}

function authHeaders(accessToken) {
  return {
    'content-type': 'application/json',
    'authorization': `Bearer ${accessToken}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
  };
}

async function sendTurn(url, headers, body) {
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const latencyMs = Date.now() - started;
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
  return { status: res.status, latencyMs, usage: parsed.usage, error: parsed.error, ok: res.ok };
}

async function runArm(label, url, headers, turns) {
  const results = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    let attempt;
    try {
      attempt = await sendTurn(url, headers, turn);
    } catch (err) {
      attempt = { status: 0, error: { message: String(err) }, ok: false };
    }
    results.push({ turn: i + 1, ...attempt });
    const u = attempt.usage;
    const summary = u
      ? `in=${u.input_tokens} create=${u.cache_creation_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0}`
      : JSON.stringify(attempt.error ?? attempt).slice(0, 150);
    console.log(`[${label}] turn ${i + 1}/${turns.length} status=${attempt.status} ${summary}`);
    if (!attempt.ok) {
      console.error(`[${label}] STOPPING on error at turn ${i + 1}`);
      break;
    }
  }
  return results;
}

async function main() {
  const accessToken = readAccessToken();
  const headers = authHeaders(accessToken);

  console.log(`Building ${TURNS}-turn identical content for both arms...`);
  const paramsA = volatileParams('arm-a-direct');
  const paramsB = volatileParams('arm-a-direct'); // SAME seed -> identical volatile bytes in both arms
  const turnsA = buildTurns(FIXTURE, TURNS, paramsA, MODEL);
  const turnsB = buildTurns(FIXTURE, TURNS, paramsB, MODEL);

  console.log('\n=== ARM A: direct to real Anthropic API (cache-assembler OFF) ===');
  const armA = await runArm('A-direct', DIRECT_UPSTREAM, headers, turnsA);

  console.log('\n=== ARM B: through local proxy (cache-assembler ON) ===');
  const armB = await runArm('B-proxied', PROXY_UPSTREAM, headers, turnsB);

  writeFileSync(OUT_PATH, JSON.stringify({ turns: TURNS, model: MODEL, armA, armB }, null, 2));
  console.log(`\nWrote results to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
