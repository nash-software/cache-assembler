// Shared guard against catastrophic-backtracking shapes in operator-configured
// extractor patterns (deferral.ts, telemetry.ts divergence attribution).
//
// Catches a parenthesized group that is itself quantified (`+`, `*`, or an
// unbounded/ranged `{n,}` / `{n,m}` — all three make the engine revisit the
// group repeatedly, same as `+`/`*`) whose own contents contain EITHER
// another quantifier — nested repetition, e.g. `(a+)+`, `(a{1,}){1,}` — OR
// an alternation — overlapping repetition, e.g. `(a|a)+`, `(a|ab)+`. Both
// are the textbook catastrophic-backtracking constructs; a length cap on the
// tested string does NOT help here, since blowup occurs even for short
// adversarial input (under 30 characters against any of the shapes above).
// This heuristic won't catch every possible catastrophic pattern (arbitrary
// nesting depth split across multiple groups, cross-group overlap), but it
// closes the common, well-known cases without adding a runtime dependency or
// making extraction asynchronous.
const QUANTIFIED_GROUP = /\(([^()]*)\)(?:[+*]|\{\d+,\d*\})/g
const INNER_QUANTIFIER_OR_ALTERNATION = /[+*]|\{\d+,\d*\}|\|/

export function isPotentiallyCatastrophicPattern(pattern: string): boolean {
  QUANTIFIED_GROUP.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = QUANTIFIED_GROUP.exec(pattern)) !== null) {
    if (INNER_QUANTIFIER_OR_ALTERNATION.test(match[1] ?? '')) return true
  }
  return false
}
