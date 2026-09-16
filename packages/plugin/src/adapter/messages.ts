/**
 * Harness GenerateOptions -> pi-ai Context conversion (clean-room version of
 * dsh-llm-pi-ai's textOnlyContext, scoped to text-only models: dsh-llm strips
 * images before dispatch when the model declares text-only input modalities).
 */

export interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

export type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean; [key: string]: unknown }

export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant'
  content: HarnessBlock[]
  source?: { kind: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** pi-ai message vocabulary (subset we emit). */
export type PiMessage =
  | { role: 'user'; content: string | PiContentBlock[]; timestamp: number }
  | {
      role: 'assistant'
      content: PiAssistantBlock[]
      api: 'openai-completions'
      provider: string
      model: string
      usage: PiUsage
      stopReason: 'stop' | 'toolUse'
      timestamp: number
    }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: PiContentBlock[]; isError: boolean; timestamp: number }

export type PiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type PiContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface PiTool {
  name: string
  description: string
  parameters: unknown
}

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: PiTool[]
}

export function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw }
  }
}

function toPiAssistant(message: HarnessMessage, providerId: string): Extract<PiMessage, { role: 'assistant' }> {
  const content: PiAssistantBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      case 'image':
        throw new Error('kilo2dsh: assistant image output cannot be replayed to a text-only model')
      default:
        break
    }
  }
  const source = message.source
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : providerId,
    model: source?.kind === 'model' && typeof source.model === 'string' ? source.model : providerId,
    usage: zeroUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function flattenText(message: HarnessMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

function toolResultText(blocks: HarnessBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? toolResultText(block.content) : ''))
    .join('')
}

/**
 * Structural view of the durable attachment service (`ctx.get('attachments')`).
 * Only the request-image read is used; the full host interface is wider.
 */
export interface AttachmentStore {
  readImageRequest(
    ref: ImageAttachmentRef,
    policy?: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string }>
}
interface ImageAttachmentRef {
  attachmentId: string
  mediaType?: string
}
interface ImageRequestPolicy {
  maxPixels?: number
  maxBytes?: number
}

/**
 * Resolved request-image bytes, keyed by the durable attachment id: several
 * occurrences of one image in a request share a single read.
 */
export type ImageBytes = Map<string, { data: string; mimeType: string }>

/**
 * Convert the harness conversation into a pi-ai Context. Mirrors
 * textOnlyContext: user content keeps its image blocks (a vision-capable model
 * receives them; dsh-llm already projected images to text for a text-only
 * model before dispatch), tool results as toolResult messages, assistant
 * history as pi-ai assistant messages. Pass `images` to inline resolved
 * request bytes for vision models; without it every image block is dropped.
 */
export function toPiContext(options: HarnessGenerateOptions, images?: ImageBytes): PiContext {
  const providerId = options.provider
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message)
      if (text.length > 0) messages.push({ role: 'user', content: text, timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, providerId)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const blocks = userBlocks(message.content, images)
    const results = message.content.filter((block) => block.type === 'tool-result') as Array<
      Extract<HarnessBlock, { type: 'tool-result' }>
    >
    if (blocks.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: blocks, timestamp: 0 })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const context: PiContext = { messages }
  if (typeof options.system === 'string' && options.system.length > 0) context.systemPrompt = options.system
  const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (tools && tools.length > 0) context.tools = tools
  return context
}

/**
 * Read every image occurrence in the request once, base64-encoded. Occurrences
 * are keyed by attachment id, so one image reused across turns is decoded a
 * single time. A missing service or a failed read leaves that image out: the
 * turn still sends its text, and a text-only model is unaffected either way
 * (dsh-llm already projected its images to placeholders before dispatch).
 */
export async function resolveRequestImages(
  messages: HarnessMessage[],
  attachments?: AttachmentStore,
): Promise<ImageBytes | undefined> {
  if (attachments === undefined) return undefined
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of messages) collectImageRefs(message.content, refs)
  if (refs.size === 0) return undefined
  const resolved: ImageBytes = new Map()
  await Promise.all(
    [...refs.values()].map(async (ref) => {
      try {
        const version = await attachments.readImageRequest(ref, { maxPixels: 1568, maxBytes: 8 * 1024 * 1024 })
        const data = Buffer.from(version.data).toString('base64')
        const mimeType =
          typeof version.mediaType === 'string' && version.mediaType.length > 0
            ? version.mediaType
            : ref.mediaType ?? 'image/png'
        resolved.set(ref.attachmentId, { data, mimeType })
      } catch {
        // One unreadable image must not fail the whole turn.
      }
    }),
  )
  return resolved.size === 0 ? undefined : resolved
}

function collectImageRefs(blocks: HarnessBlock[], refs: Map<string, ImageAttachmentRef>): void {
  for (const block of blocks) {
    if (block.type === 'image') {
      const ref = (block as { attachment?: ImageAttachmentRef }).attachment
      if (ref && typeof ref.attachmentId === 'string') refs.set(ref.attachmentId, ref)
    } else if (block.type === 'tool-result') {
      collectImageRefs(block.content, refs)
    }
  }
}

/**
 * Build one pi-ai user message's content: a plain string when it carries no
 * image block, otherwise an ordered part list. pi-ai's openai-completions
 * serializer turns each image part into an inline `image_url` data URI, so a
 * model that declares image input receives the bytes rather than a placeholder.
 */
function userBlocks(content: HarnessBlock[], images?: ImageBytes): string | PiContentBlock[] {
  const parts: PiContentBlock[] = []
  let hasImage = false
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const id = (block as { attachment?: { attachmentId?: string } }).attachment?.attachmentId
      const hit = id === undefined ? undefined : images?.get(id)
      if (hit) {
        parts.push({ type: 'image', data: hit.data, mimeType: hit.mimeType })
        hasImage = true
      }
    }
  }
  return hasImage ? parts : parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
}
