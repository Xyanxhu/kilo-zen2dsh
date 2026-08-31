import { createProvider, type Api, type Context, type Model, type ProviderHeaders, type ThinkingLevel } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'

import {
  ANONYMOUS_API_KEY,
  KILO_GATEWAY_BASE_URL,
  ModelCatalog,
  modelInfo,
  type KiloModel,
} from './catalog.ts'
import { toStreamChunks, type HarnessChunk, type PiEvent } from './events.ts'
import { deriveRequestIDs, kiloHeaders, kiloUserAgent, type RequestIDs } from './ids.ts'
import { toPiContext, type HarnessGenerateOptions } from './messages.ts'

/** Provider id shown in the DSH model picker. */
export const PROVIDER_ID = 'kilo2dsh'

export interface CatalogLike {
  list(): string[]
  decision(model: string): { allowed: boolean; source: string; known: boolean }
  get?(model: string): KiloModel | undefined
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768
// pi-ai's OpenAI transport requires a truthy key for client construction.
// OpenAI-compatible keyless endpoints can still be used by passing a private
// sentinel and suppressing the SDK-generated Authorization header with null.
const KEYLESS_TRANSPORT_KEY = '__kilo_keyless__'

export interface KiloAdapterOptions {
  /** Provider route registered in DSH. */
  providerId?: string
  /** Base URL ending in `/api/gateway`. */
  gatewayBaseUrl?: string
  /** @deprecated Use gatewayBaseUrl. Accepted for source compatibility. */
  zenBaseUrl?: string
  /** Optional authenticated Kilo token; free-only filtering remains enabled. */
  apiKey?: string
  /** Optional explicit gateway token. Omit it for Kilo's keyless free lane. */
  anonymousKey?: string
  /** Override the User-Agent used for diagnostics. */
  userAgent?: string
  /** Value sent in Kilo's editor-name header. */
  editorName?: string
}

function numeric(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

function thinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value
  }
  return undefined
}

function modelToPiModel(
  model: KiloModel,
  providerId: string,
  gatewayBaseUrl: string,
  headers: Record<string, string>,
): Model<Api> {
  const info = modelInfo(model)
  const pricing = model.pricing ?? {}
  const zero = 0
  const input = numeric(pricing.prompt ?? pricing.input, zero)
  const output = numeric(pricing.completion ?? pricing.output, zero)
  return {
    id: model.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    // Kilo's documented endpoint is /api/gateway/chat/completions (no /v1).
    baseUrl: gatewayBaseUrl.replace(/\/+$/, ''),
    reasoning: info.reasoning,
    input: ['text'],
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: info.maxTokens || DEFAULT_MAX_TOKENS,
    headers,
    compat: {
      // Kilo's gateway follows the OpenRouter reasoning field conventions.
      thinkingFormat: 'openrouter',
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      sendSessionAffinityHeaders: false,
      supportsLongCacheRetention: false,
    },
  }
}

function fallbackModel(id: string): KiloModel {
  return {
    id,
    name: id,
    context_length: DEFAULT_CONTEXT_WINDOW,
    max_completion_tokens: DEFAULT_MAX_TOKENS,
    isFree: true,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'],
  }
}

/** Build the adapter's Kilo-specific request headers. */
function requestHeaders(
  ids: RequestIDs,
  options: Pick<KiloAdapterOptions, 'userAgent' | 'editorName'>,
  mode?: unknown,
): Record<string, string> {
  const headers = kiloHeaders(ids, {
    userAgent: options.userAgent ?? kiloUserAgent(),
    editorName: options.editorName ?? 'DSH/kilo2dsh',
    mode: typeof mode === 'string' ? mode : undefined,
  })
  return headers
}

/**
 * Native DSH adapter for Kilo's anonymous/free gateway lane.
 *
 * The adapter intentionally keeps the provider surface structural, matching
 * dsh-llm's LlmAdapter contract without importing a particular host version.
 */
export class KiloAdapter {
  readonly #catalog: CatalogLike
  readonly #provider
  readonly #providerId: string
  readonly #gatewayBaseUrl: string
  /** Actual configured token; empty means Kilo's keyless free lane. */
  readonly #apiKey: string
  /** Non-empty value used only to satisfy pi-ai/OpenAI client construction. */
  readonly #transportApiKey: string
  readonly #anonymousKey: string
  readonly #options: KiloAdapterOptions

  constructor(catalog: CatalogLike, options: KiloAdapterOptions = {}) {
    this.#catalog = catalog
    this.#providerId = options.providerId?.trim() || PROVIDER_ID
    this.#gatewayBaseUrl = (options.gatewayBaseUrl ?? options.zenBaseUrl ?? KILO_GATEWAY_BASE_URL).replace(/\/+$/, '')
    this.#anonymousKey = options.anonymousKey?.trim() || ANONYMOUS_API_KEY
    this.#apiKey = options.apiKey?.trim() || this.#anonymousKey
    this.#transportApiKey = this.#apiKey || KEYLESS_TRANSPORT_KEY
    this.#options = options
    this.#provider = createProvider<Api>({
      id: this.#providerId,
      name: 'Kilo Gateway (free)',
      baseUrl: this.#gatewayBaseUrl,
      auth: {
        apiKey: {
          name: 'Kilo Gateway API key (optional)',
          resolve: async () => ({
            auth: { apiKey: this.#transportApiKey },
            ...(this.#apiKey ? {} : { headers: { authorization: null } }),
          }),
        },
      },
      models: [],
      api: openaiCompletions,
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: 'Kilo Gateway (free)' }
  }

  /** Let DSH own retry policy; the gateway itself enforces IP limits. */
  providerRetryPolicy(_provider: string): undefined {
    return undefined
  }

  listModels(provider: string): Array<{ provider: string; id: string; name: string; inputModalities: string[] }> {
    const seen = new Set<string>()
    const models: Array<{ provider: string; id: string; name: string; inputModalities: string[] }> = []
    for (const id of this.#catalog.list()) {
      if (seen.has(id)) continue
      seen.add(id)
      const detail = this.#catalog.get?.(id)
      const info = detail ? modelInfo(detail) : { id, name: id, inputModalities: ['text'] }
      models.push({ provider, id, name: info.name, inputModalities: ['text'] })
    }
    return models
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
  } {
    const detail = this.#catalog.get?.(model)
    const info = detail ? modelInfo(detail) : { id: model, name: model, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
    return {
      provider,
      id: model,
      name: info.name,
      inputModalities: ['text'],
      context: { contextWindow: numeric(info.contextWindow, DEFAULT_CONTEXT_WINDOW) },
      defaultMaxTokens: numeric(info.maxTokens, DEFAULT_MAX_TOKENS),
    }
  }

  async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<KiloAdapter['resolveModel']>
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>
  }> {
    return { model: this.resolveModel(provider, model), stream: (options) => this.stream(options) }
  }

  /** Stream one chat turn through Kilo's OpenAI-compatible endpoint. */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const modelId = options.model.trim()
    const decision = this.#catalog.decision(modelId)
    if (!decision.allowed) {
      throw new Error(`kilo2dsh: model "${modelId}" is not available in the free Kilo catalog (${decision.source})`)
    }

    const context = toPiContext(options)
    const ids = deriveRequestIDs(options.messages)
    const detail = this.#catalog.get?.(modelId) ?? fallbackModel(modelId)
    const baseHeaders = requestHeaders(ids, this.#options, options.mode)
    const headers: ProviderHeaders = { ...baseHeaders }
    if (!this.#apiKey) {
      // OpenAI SDK 6.x (used by pi-ai) insists on a non-empty constructor key
      // and would otherwise emit `Bearer __kilo_keyless__`. A null header is
      // the SDK-supported way to remove that generated header.
      headers.authorization = null
    }
    const model = modelToPiModel(detail, this.#providerId, this.#gatewayBaseUrl, baseHeaders)
    const events = this.#provider.streamSimple(model, context as unknown as Context, {
      apiKey: this.#transportApiKey,
      sessionId: ids.session,
      headers,
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      reasoning: thinkingLevel(options.reasoningEffort),
    })
    yield* toStreamChunks(events as unknown as AsyncIterable<PiEvent>, model.contextWindow)
  }

  catalogStatus(): { total: number; exposed: number } {
    const snapshot = this.#catalog instanceof ModelCatalog ? this.#catalog.snapshot() : undefined
    return snapshot ? { total: snapshot.total, exposed: snapshot.exposed } : { total: this.#catalog.list().length, exposed: this.#catalog.list().length }
  }

  decisionFor(model: string): { allowed: boolean; source: string } {
    const decision = this.#catalog.decision(model)
    return { allowed: decision.allowed, source: decision.source }
  }
}

/** Build an adapter over a live Kilo catalog. */
export function createKiloAdapter(catalog: ModelCatalog, options?: KiloAdapterOptions): KiloAdapter {
  return new KiloAdapter(catalog, options)
}

/** Deprecated compatibility alias for consumers of the reference project. */
export const ZenAdapter = KiloAdapter
export const createZenAdapter = createKiloAdapter
