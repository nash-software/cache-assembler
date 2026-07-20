# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, email **mike@nashsoftware.dev** with:
- A description of the issue and its potential impact
- Steps to reproduce (a minimal request shape is ideal — redact any real
  API keys, tokens, or user content)
- The version of cache-assembler you're using

We'll acknowledge your report within 3 business days and aim to have a fix
or mitigation plan within 14 days for confirmed issues.

## Scope

cache-assembler rewrites request bytes before they reach the Anthropic API.
Security-relevant areas include: the write-barrier concurrency logic
(`src/barrier.ts`), trace-log redaction (`src/telemetry.ts`), the F3
deferral extractor patterns (ReDoS surface), and the JSON-path traversal
used by presets (`src/json-path.ts`).
