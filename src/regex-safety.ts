// Shared guard against the classic ReDoS shape in operator-configured
// extractor patterns (deferral.ts, telemetry.ts divergence attribution):
// a parenthesized group containing its own +/* quantifier, itself
// quantified again — e.g. `(a+)+`, `(a*)+`, `(a+)*`, `(a*)*`. This is the
// textbook catastrophic-backtracking construct; a length cap on the tested
// string does NOT help here, since blowup occurs even for short adversarial
// input (a 24-character string against `^(a+)+$` already takes ~1s). This
// heuristic won't catch every possible catastrophic pattern (deeper nesting,
// overlapping alternation), but it closes the common, well-known case
// without adding a runtime dependency or making extraction asynchronous.
const NESTED_QUANTIFIER_PATTERN = /\([^()]*[+*][^()]*\)[+*]/

export function isPotentiallyCatastrophicPattern(pattern: string): boolean {
  return NESTED_QUANTIFIER_PATTERN.test(pattern)
}
