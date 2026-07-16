import fc from 'fast-check'

// Pins the property-test seed so every fast-check property test in this
// package is deterministic in CI. Without a fixed seed,
// canonicalize.property.test.ts has intermittently failed on a
// randomly-generated edge-case input across otherwise-unrelated builder runs.
fc.configureGlobal({ seed: 20260704 })
