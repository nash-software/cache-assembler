// Structural Anthropic Messages API types — no SDK dependency (zero-runtime-deps
// constraint). Unknown fields are preserved via a Record<string, unknown>
// intersection so requests are never silently dropped.

export interface CacheControl {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

export interface ToolDefinition {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  cache_control?: CacheControl
  [key: string]: unknown
}

export interface TextBlock {
  type: 'text'
  text: string
  cache_control?: CacheControl
  [key: string]: unknown
}

export type SystemBlock = TextBlock

export type ContentBlock = TextBlock | ({ type: string } & Record<string, unknown>)

export interface MessageParam {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  [key: string]: unknown
}

export interface AnthropicRequestLike {
  model?: string
  system?: string | SystemBlock[]
  tools?: ToolDefinition[]
  messages: MessageParam[]
  [key: string]: unknown
}

export interface Usage {
  input_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  [key: string]: unknown
}

export interface BreakpointPlacement {
  location: 'tool' | 'system' | 'message'
  index: number
  ttl: '5m' | '1h'
}

export interface MovedSpan {
  id: string
  path: string
  text: string
}

export interface AssembleReport {
  prefixHash: string
  features: {
    canonicalize: { applied: boolean }
    breakpoints: { placed: BreakpointPlacement[]; existingRespected: number }
    deferral: {
      mode: 'off' | 'dry-run' | 'active'
      moved: MovedSpan[]
      prefixHashBefore: string
      prefixHashAfter: string
    }
  }
}

export interface Extractor {
  id: string
  path: string
  pattern: string
  flags?: string
}
