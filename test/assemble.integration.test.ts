import { describe, expect, it } from 'vitest'
import { assemble } from '../src/assemble.js'
import type { AnthropicRequestLike } from '../src/types.js'
import type { CacheAssemblerConfig } from '../src/config.js'

const SESSION_EXTRACTOR = {
  id: 'session-id',
  path: 'system[*].text',
  pattern: 'session [a-z0-9-]+ context',
}

function makeSession(sessionId: string): AnthropicRequestLike {
  return {
    model: 'claude-fable-5',
    system: [{ type: 'text', text: `session ${sessionId} context` }],
    tools: [{ name: 't1', description: 'tool one', input_schema: {} }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first message stable' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'assistant reply stable' }] },
      { role: 'user', content: [{ type: 'text', text: `newest message unique ${sessionId}` }] },
    ],
  }
}

describe('assemble (orchestrator)', () => {
  it('produces identical prefix hashes for two sessions differing only in session UUID when deferral is active', () => {
    const cfg: CacheAssemblerConfig = { deferral: { enabled: true, dryRun: false, extractors: [SESSION_EXTRACTOR] } }

    const a = assemble(makeSession('abc-123'), cfg)
    const b = assemble(makeSession('xyz-789'), cfg)

    expect(a.report.prefixHash).toBe(b.report.prefixHash)
  })

  it('produces different prefix hashes for the same two sessions when deferral is disabled (control)', () => {
    const cfg: CacheAssemblerConfig = { deferral: { enabled: false } }

    const a = assemble(makeSession('abc-123'), cfg)
    const b = assemble(makeSession('xyz-789'), cfg)

    expect(a.report.prefixHash).not.toBe(b.report.prefixHash)
  })

  it('populates every AssembleReport field per enabled feature', () => {
    const cfg: CacheAssemblerConfig = { deferral: { enabled: true, dryRun: false, extractors: [SESSION_EXTRACTOR] } }
    const { report } = assemble(makeSession('abc-123'), cfg)

    expect(report.features.canonicalize.applied).toBe(true)
    expect(report.features.breakpoints.placed.length).toBeGreaterThan(0)
    expect(report.features.breakpoints.existingRespected).toBe(0)
    expect(report.features.deferral.mode).toBe('active')
    expect(report.features.deferral.moved.length).toBeGreaterThan(0)
    expect(typeof report.features.deferral.prefixHashBefore).toBe('string')
    expect(typeof report.features.deferral.prefixHashAfter).toBe('string')
  })

  it('skips disabled features cleanly and reports mode "off" for deferral', () => {
    const cfg: CacheAssemblerConfig = {
      canonicalize: { enabled: false },
      breakpoints: { enabled: false },
      deferral: { enabled: false },
    }
    const { report } = assemble(makeSession('abc-123'), cfg)

    expect(report.features.canonicalize.applied).toBe(false)
    expect(report.features.breakpoints.placed).toEqual([])
    expect(report.features.deferral.mode).toBe('off')
  })

  it('never mutates the input request', () => {
    const req = makeSession('abc-123')
    const snapshot = JSON.parse(JSON.stringify(req)) as AnthropicRequestLike
    assemble(req, { deferral: { enabled: true, dryRun: false, extractors: [SESSION_EXTRACTOR] } })
    expect(req).toEqual(snapshot)
  })

  it('F3 dry-run guardrail: reports mode "dry-run", leaves the request unchanged, and computes the would-be post-relocation hash', () => {
    const cfg: CacheAssemblerConfig = { deferral: { enabled: true, dryRun: true, extractors: [SESSION_EXTRACTOR] } }
    const { req: out, report } = assemble(makeSession('abc-123'), cfg)

    expect(report.features.deferral.mode).toBe('dry-run')
    expect(report.features.deferral.moved.length).toBeGreaterThan(0)
    // dry-run must not rewrite the request, but prefixHashAfter still reports
    // the hypothetical stability gain so an operator can see the value of F3
    // before opting in (spec F3: "logs what WOULD move + before/after prefix hash").
    expect(report.features.deferral.prefixHashBefore).not.toBe(report.features.deferral.prefixHashAfter)

    const system = out.system as { text: string }[]
    expect(system[0]?.text).toContain('session abc-123 context')
  })

  it('excludes all messages from the stable prefix hash when only tool/system breakpoints are placed (no message boundary)', () => {
    const cfg: CacheAssemblerConfig = {}
    const base = (message: string): AnthropicRequestLike => ({
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't1', input_schema: {} }],
      messages: [{ role: 'user', content: [{ type: 'text', text: message }] }],
    })

    const a = assemble(base('first unique message'), cfg)
    const b = assemble(base('completely different message'), cfg)

    expect(a.report.features.breakpoints.placed.every((p) => p.location !== 'message')).toBe(true)
    expect(a.report.prefixHash).toBe(b.report.prefixHash)
  })
})
