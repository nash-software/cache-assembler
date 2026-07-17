import type { AnthropicRequestLike, BreakpointPlacement, CacheControl, ContentBlock, SystemBlock } from './types.js'
import type { CacheAssemblerConfig, ResolvedConfig } from './config.js'

const TTL_INTERMEDIATE = '1h'
const TTL_FINAL = '5m'

function normalizeSystem(system: AnthropicRequestLike['system']): SystemBlock[] {
  if (system === undefined) return []
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  return system
}

function isLowerTierTtl(cacheControl: CacheControl | undefined): boolean {
  return cacheControl !== undefined && cacheControl.ttl !== '1h'
}

/**
 * True if any EXISTING (client-set) breakpoint anywhere in the request is at
 * the lower tier ('5m', or no ttl — which the API defaults to 5m). The
 * Anthropic API requires TTLs non-increasing in priority across the full
 * tools -> system -> messages sequence, and existing breakpoints can never be
 * modified, so once one of them is at the lower tier, every breakpoint placed
 * anywhere in the request (existing or new) must also be at the lower tier.
 */
function hasExistingLowerTierBreakpoint(req: AnthropicRequestLike, system: SystemBlock[]): boolean {
  if ((req.tools ?? []).some((t) => isLowerTierTtl(t.cache_control))) return true
  if (system.some((b) => isLowerTierTtl(b.cache_control))) return true
  for (const message of req.messages) {
    if (typeof message.content === 'string') continue
    const blocks = message.content as ContentBlock[]
    if (blocks.some((b) => isLowerTierTtl(b.cache_control as CacheControl | undefined))) return true
  }
  return false
}

function countExisting(req: AnthropicRequestLike, system: SystemBlock[]): number {
  const toolBreakpoints = (req.tools ?? []).filter((t) => t.cache_control !== undefined).length
  const systemBreakpoints = system.filter((b) => b.cache_control !== undefined).length
  const messageBreakpoints = req.messages.reduce((count, message) => {
    if (typeof message.content === 'string') return count
    const blocks = message.content as ContentBlock[]
    return count + blocks.filter((b) => b.cache_control !== undefined).length
  }, 0)
  return toolBreakpoints + systemBreakpoints + messageBreakpoints
}

/**
 * Counts cache_control breakpoints already present on a request (tools,
 * system blocks, and message content blocks combined) — the shared API
 * budget that any newly placed breakpoints must respect.
 */
export function countExistingBreakpoints(req: AnthropicRequestLike): number {
  return countExisting(req, normalizeSystem(req.system))
}

type Candidate = { location: BreakpointPlacement['location']; index: number; apply: (ttl: '5m' | '1h') => void }

/**
 * Places up to `maxSlots − existingBreakpoints` cache_control breakpoints in
 * priority order: (1) last tool definition, (2) last system block, (3) the
 * last-stable-message boundary (final content block of the last message
 * EXCLUDING the newest message). Never modifies or removes an existing
 * client-set breakpoint; existing ones count against the shared API budget.
 * TTL tiering: '1h' for every placement except the last, which gets '5m' —
 * UNLESS an existing (client-set) breakpoint anywhere in the request is
 * already at the lower tier ('5m' or no ttl), in which case every new
 * placement is forced to '5m'. The Anthropic API requires TTLs
 * non-increasing in priority across tools -> system -> messages, and an
 * existing breakpoint can never be modified to fix an ordering violation —
 * only new placements can adapt. This is conservative (it forces '5m' even
 * for new placements that would sit before the conflicting existing one),
 * trading some cache longevity for a guarantee the assembled request is
 * always valid.
 */
export function placeBreakpoints(
  req: AnthropicRequestLike,
  cfg: Pick<ResolvedConfig, 'breakpoints'> | CacheAssemblerConfig,
): { req: AnthropicRequestLike; placed: BreakpointPlacement[] } {
  const maxSlots = cfg.breakpoints?.maxSlots ?? 4
  const system = normalizeSystem(req.system)
  const existing = countExistingBreakpoints(req)
  const freeSlots = Math.max(0, maxSlots - existing)
  const forceLowerTier = hasExistingLowerTierBreakpoint(req, system)

  const tools = req.tools ? [...req.tools] : undefined
  const messages = req.messages.map((m) => ({
    ...m,
    content: typeof m.content === 'string' ? m.content : [...(m.content as ContentBlock[])],
  }))

  const candidates: Candidate[] = []

  if (tools && tools.length > 0) {
    const lastIndex = tools.length - 1
    const lastTool = tools[lastIndex]
    if (lastTool && lastTool.cache_control === undefined) {
      candidates.push({
        location: 'tool',
        index: lastIndex,
        apply: (ttl) => {
          tools[lastIndex] = { ...lastTool, cache_control: { type: 'ephemeral', ttl } }
        },
      })
    }
  }

  if (system.length > 0) {
    const lastIndex = system.length - 1
    const lastBlock = system[lastIndex]
    if (lastBlock && lastBlock.cache_control === undefined) {
      candidates.push({
        location: 'system',
        index: lastIndex,
        apply: (ttl) => {
          system[lastIndex] = { ...lastBlock, cache_control: { type: 'ephemeral', ttl } }
        },
      })
    }
  }

  // Last-stable-message boundary: the final content block of the last message
  // EXCLUDING the newest (final) message in the conversation.
  if (messages.length >= 2) {
    const stableIndex = messages.length - 2
    const stableMessage = messages[stableIndex]
    if (stableMessage && typeof stableMessage.content !== 'string') {
      const blocks = stableMessage.content as ContentBlock[]
      const lastBlockIndex = blocks.length - 1
      const lastBlock = blocks[lastBlockIndex]
      if (lastBlock && lastBlock.cache_control === undefined) {
        candidates.push({
          location: 'message',
          index: stableIndex,
          apply: (ttl) => {
            blocks[lastBlockIndex] = { ...lastBlock, cache_control: { type: 'ephemeral', ttl } }
          },
        })
      }
    }
  }

  const toPlace = candidates.slice(0, freeSlots)
  const placed: BreakpointPlacement[] = toPlace.map((c, i) => {
    const ttl = forceLowerTier || i === toPlace.length - 1 ? TTL_FINAL : TTL_INTERMEDIATE
    c.apply(ttl)
    return { location: c.location, index: c.index, ttl }
  })

  const out: AnthropicRequestLike = {
    ...req,
    ...(tools ? { tools } : {}),
    ...(req.system !== undefined ? { system } : {}),
    messages,
  }

  return { req: out, placed }
}
