import type { AnthropicRequestLike, BreakpointPlacement, CacheControl, ContentBlock, SystemBlock } from './types.js'
import type { CacheAssemblerConfig, ResolvedConfig } from './config.js'

const TTL_INTERMEDIATE = '1h'
const TTL_FINAL = '5m'

function normalizeSystem(system: AnthropicRequestLike['system']): SystemBlock[] {
  if (system === undefined) return []
  if (typeof system === 'string') return [{ type: 'text', text: system }]
  return system
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

// Rank encodes TTL priority: the Anthropic API requires priority to be
// non-increasing across the full tools -> system -> messages sequence
// (a '1h' block may never appear after a '5m'/default block).
type Rank = 0 | 1
const RANK_5M: Rank = 0
const RANK_1H: Rank = 1

function rankOfTtl(ttl: '5m' | '1h' | undefined): Rank {
  return ttl === '1h' ? RANK_1H : RANK_5M
}

function maxRank(a: Rank, b: Rank): Rank {
  return a > b ? a : b
}

function minRank(a: Rank, b: Rank): Rank {
  return a < b ? a : b
}

// A breakpoint's location in final wire order: zone 0 = tools, 1 = system,
// 2 = messages (primary = message index, secondary = content-block index;
// primary/secondary are both 0 for tools and system entries).
type ZonePosition = { zone: 0 | 1 | 2; primary: number; secondary: number }

function isStrictlyBefore(a: ZonePosition, b: ZonePosition): boolean {
  if (a.zone !== b.zone) return a.zone < b.zone
  if (a.primary !== b.primary) return a.primary < b.primary
  return a.secondary < b.secondary
}

/**
 * Every EXISTING (client-set) breakpoint in the request, with its position
 * in final wire order and its rank. Existing breakpoints are never modified
 * — they're the fixed points that newly placed breakpoints must be
 * consistent with.
 */
function collectExistingBreakpoints(req: AnthropicRequestLike, system: SystemBlock[]): { position: ZonePosition; rank: Rank }[] {
  const out: { position: ZonePosition; rank: Rank }[] = []
  ;(req.tools ?? []).forEach((tool, idx) => {
    if (tool.cache_control !== undefined) {
      out.push({ position: { zone: 0, primary: idx, secondary: 0 }, rank: rankOfTtl(tool.cache_control.ttl) })
    }
  })
  system.forEach((block, idx) => {
    if (block.cache_control !== undefined) {
      out.push({ position: { zone: 1, primary: idx, secondary: 0 }, rank: rankOfTtl(block.cache_control.ttl) })
    }
  })
  req.messages.forEach((message, mIdx) => {
    if (typeof message.content === 'string') return
    ;(message.content as ContentBlock[]).forEach((block, bIdx) => {
      const cacheControl = block.cache_control as CacheControl | undefined
      if (cacheControl !== undefined) {
        out.push({ position: { zone: 2, primary: mIdx, secondary: bIdx }, rank: rankOfTtl(cacheControl.ttl) })
      }
    })
  })
  return out
}

type Candidate = {
  location: BreakpointPlacement['location']
  index: number
  position: ZonePosition
  apply: (ttl: '5m' | '1h') => void
}

/**
 * Places up to `maxSlots − existingBreakpoints` cache_control breakpoints in
 * priority order: (1) last tool definition, (2) last system block, (3) the
 * last-stable-message boundary (final content block of the last message
 * EXCLUDING the newest message). Never modifies or removes an existing
 * client-set breakpoint; existing ones count against the shared API budget.
 *
 * TTL tiering prefers '1h' for every placement except the very last, which
 * gets '5m' — but the API requires TTL priority to be non-increasing across
 * the full tools -> system -> messages sequence, and existing breakpoints
 * can never be modified to fix a violation, so every new placement's TTL is
 * bounded by the existing breakpoints around it: it can't exceed (in
 * priority) any existing breakpoint before it, and can't fall below any
 * existing breakpoint after it. Processed right-to-left so a later
 * placement's resolved rank also bounds an earlier one (also non-increasing
 * among themselves).
 */
export function placeBreakpoints(
  req: AnthropicRequestLike,
  cfg: Pick<ResolvedConfig, 'breakpoints'> | CacheAssemblerConfig,
): { req: AnthropicRequestLike; placed: BreakpointPlacement[] } {
  const maxSlots = cfg.breakpoints?.maxSlots ?? 4
  const system = normalizeSystem(req.system)
  const existing = countExistingBreakpoints(req)
  const freeSlots = Math.max(0, maxSlots - existing)
  const existingBreakpoints = collectExistingBreakpoints(req, system)

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
        position: { zone: 0, primary: lastIndex, secondary: 0 },
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
        position: { zone: 1, primary: lastIndex, secondary: 0 },
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
          position: { zone: 2, primary: stableIndex, secondary: lastBlockIndex },
          apply: (ttl) => {
            blocks[lastBlockIndex] = { ...lastBlock, cache_control: { type: 'ephemeral', ttl } }
          },
        })
      }
    }
  }

  const toPlace = candidates.slice(0, freeSlots)

  function ceilingFromLeft(position: ZonePosition): Rank {
    let ceiling: Rank = RANK_1H
    for (const existingBp of existingBreakpoints) {
      if (isStrictlyBefore(existingBp.position, position)) ceiling = minRank(ceiling, existingBp.rank)
    }
    return ceiling
  }

  function existingFloorFromRight(position: ZonePosition): Rank {
    let floor: Rank = RANK_5M
    for (const existingBp of existingBreakpoints) {
      if (isStrictlyBefore(position, existingBp.position)) floor = maxRank(floor, existingBp.rank)
    }
    return floor
  }

  const assignedRanks: Rank[] = new Array(toPlace.length)
  let dynamicFloor: Rank = RANK_5M
  for (let i = toPlace.length - 1; i >= 0; i--) {
    const candidate = toPlace[i]!
    const preferred: Rank = i === toPlace.length - 1 ? RANK_5M : RANK_1H
    const combinedFloor = maxRank(existingFloorFromRight(candidate.position), dynamicFloor)
    const ceiling = ceilingFromLeft(candidate.position)
    const assigned = minRank(ceiling, maxRank(preferred, combinedFloor))
    assignedRanks[i] = assigned
    dynamicFloor = maxRank(dynamicFloor, assigned)
  }

  const placed: BreakpointPlacement[] = toPlace.map((c, i) => {
    const ttl = assignedRanks[i] === RANK_1H ? TTL_INTERMEDIATE : TTL_FINAL
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
