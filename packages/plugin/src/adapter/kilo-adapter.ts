import { createProvider, type Api, type Context, type Model, type ProviderHeaders, type ThinkingLevel } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

import {
  ANONYMOUS_API_KEY,
  KILO_GATEWAY_BASE_URL,
  KILO_GATEWAY_MAX_OUTPUT_TOKENS,
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
  /** Display name shown by DSH for this adapter. */
  displayName?: string
  /** Label shown by pi-ai when an account credential is requested. */
  authName?: string
  /** Private transport key used when the configured lane is keyless. */
  keylessTransportKey?: string
  /** Namespace used when deriving stable project correlation IDs. */
  projectNamespace?: string
  /** Provider-specific request header builder (Kilo is the default). */
  headerBuilder?: (ids: RequestIDs, options: KiloAdapterOptions, mode?: unknown) => Record<string, string>
  /** Select the OpenAI-compatible API for a model (Kilo defaults to chat completions). */
  apiResolver?: (model: KiloModel) => Api
  /** Gateway output ceiling; null disables the Kilo compatibility cap. */
  maxOutputTokens?: number | null
}

function numeric(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

/** Return a positive finite integer without allowing an unsafe request value. */
function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : undefined
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(parsed)))
}

/**
 * DSH materializes `defaultMaxTokens` before calling an adapter, so an
 * explicit value can still be larger than the model metadata seen by this
 * class. Clamp both paths at the final wire boundary.
 */
export function clampMaxTokens(value: unknown, modelMaxTokens: number): number | undefined {
  const requested = positiveInteger(value)
  if (requested === undefined) return undefined
  const cap = positiveInteger(modelMaxTokens)
  return cap === undefined ? requested : Math.min(requested, cap)
}

/**
 * Last-resort payload guard for future pi-ai versions or custom callers that
 * bypass the normal option path. It preserves the selected field spelling and
 * only changes a value when it exceeds the resolved model cap.
 */
function clampPayloadMaxTokens(payload: unknown, modelMaxTokens: number): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
  let next: Record<string, unknown> | undefined
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    const value = positiveInteger(record[field])
    if (value !== undefined && value > modelMaxTokens) {
      next ??= { ...record }
      next[field] = modelMaxTokens
    }
  }
  return next ?? payload
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
  api: Api = 'openai-completions',
  gatewayMaxOutputTokens: number | null = KILO_GATEWAY_MAX_OUTPUT_TOKENS,
): Model<Api> {
  const info = modelInfo(model, { gatewayMaxOutputTokens })
  const pricing = model.pricing ?? {}
  const zero = 0
  const input = numeric(pricing.prompt ?? pricing.input, zero)
  const output = numeric(pricing.completion ?? pricing.output, zero)
  const base = {
    id: model.id,
    name: info.name,
    api,
    provider: providerId,
    // Kilo's documented endpoint is /api/gateway/chat/completions (no /v1);
    // Zen's responses-capable models use the same base and let pi-ai append
    // `/responses` based on the selected API.
    baseUrl: gatewayBaseUrl.replace(/\/+$/, ''),
    reasoning: info.reasoning,
    input: ['text'],
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: info.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxTokens: info.maxTokens || DEFAULT_MAX_TOKENS,
    headers,
  }
  if (api === 'openai-responses') {
    return {
      ...base,
      compat: {
        supportsDeveloperRole: true,
        supportsStrictMode: false,
        supportsLongCacheRetention: false,
      },
    } as Model<Api>
  }
  return {
    ...base,
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
  } as Model<Api>
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
  options: KiloAdapterOptions,
  mode?: unknown,
): Record<string, string> {
  if (options.headerBuilder) return options.headerBuilder(ids, options, mode)
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
  readonly #providerName: string
  readonly #options: KiloAdapterOptions
  readonly #apiResolver: (model: KiloModel) => Api
  readonly #maxOutputTokens: number | null

  constructor(catalog: CatalogLike, options: KiloAdapterOptions = {}) {
    this.#catalog = catalog
    this.#providerId = options.providerId?.trim() || PROVIDER_ID
    this.#gatewayBaseUrl = (options.gatewayBaseUrl ?? options.zenBaseUrl ?? KILO_GATEWAY_BASE_URL).replace(/\/+$/, '')
    this.#anonymousKey = options.anonymousKey?.trim() || ANONYMOUS_API_KEY
    this.#apiKey = options.apiKey?.trim() || this.#anonymousKey
    this.#transportApiKey = this.#apiKey || options.keylessTransportKey?.trim() || KEYLESS_TRANSPORT_KEY
    this.#providerName = options.displayName?.trim() || 'Kilo Gateway (free)'
    this.#options = options
    this.#apiResolver = options.apiResolver ?? (() => 'openai-completions')
    this.#maxOutputTokens = options.maxOutputTokens === null
      ? null
      : (() => {
          const parsed = numeric(options.maxOutputTokens, KILO_GATEWAY_MAX_OUTPUT_TOKENS)
          return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(parsed)))
        })()
    this.#provider = createProvider<Api>({
      id: this.#providerId,
      name: this.#providerName,
      baseUrl: this.#gatewayBaseUrl,
      auth: {
        apiKey: {
          name: options.authName?.trim() || 'Kilo Gateway API key (optional)',
          resolve: async () => ({
            auth: { apiKey: this.#transportApiKey },
            ...(this.#apiKey ? {} : { headers: { authorization: null } }),
          }),
        },
      },
      models: [],
      api: {
        'openai-completions': openaiCompletions,
        'openai-responses': openaiResponses,
      },
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: this.#providerName }
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
      const info = detail
        ? modelInfo(detail, { gatewayMaxOutputTokens: this.#maxOutputTokens })
        : { id, name: id, inputModalities: ['text'] }
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
    const info = detail
      ? modelInfo(detail, { gatewayMaxOutputTokens: this.#maxOutputTokens })
      : modelInfo(
          {
            id: model,
            name: model,
            context_length: DEFAULT_CONTEXT_WINDOW,
            max_completion_tokens: DEFAULT_MAX_TOKENS,
          },
          { gatewayMaxOutputTokens: this.#maxOutputTokens },
        )
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

  /** Stream one turn through the configured OpenAI-compatible endpoint. */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const modelId = options.model.trim()
    const decision = this.#catalog.decision(modelId)
    if (!decision.allowed) {
      throw new Error(`${this.#providerId}: model "${modelId}" is not available in the configured free catalog (${decision.source})`)
    }

    const context = toPiContext(options)
    const ids = deriveRequestIDs(options.messages, this.#options.projectNamespace ?? 'kilo2dsh:default-project')
    const detail = this.#catalog.get?.(modelId) ?? fallbackModel(modelId)
    const info = modelInfo(detail, { gatewayMaxOutputTokens: this.#maxOutputTokens })
    const baseHeaders = requestHeaders(ids, this.#options, options.mode)
    const headers: ProviderHeaders = { ...baseHeaders }
    if (!this.#apiKey) {
      // OpenAI SDK 6.x (used by pi-ai) insists on a non-empty constructor key
      // and would otherwise emit `Bearer __kilo_keyless__`. A null header is
      // the SDK-supported way to remove that generated header.
      headers.authorization = null
    }
    const model = modelToPiModel(
      detail,
      this.#providerId,
      this.#gatewayBaseUrl,
      baseHeaders,
      this.#apiResolver(detail),
      this.#maxOutputTokens,
    )
    const events = this.#provider.streamSimple(model, context as unknown as Context, {
      apiKey: this.#transportApiKey,
      sessionId: ids.session,
      headers,
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: clampMaxTokens(options.maxTokens, info.maxTokens),
      reasoning: thinkingLevel(options.reasoningEffort),
      onPayload: (payload) => clampPayloadMaxTokens(payload, info.maxTokens),
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
export function createKiloAdapter(catalog: CatalogLike, options?: KiloAdapterOptions): KiloAdapter {
  return new KiloAdapter(catalog, options)
}

/** Deprecated compatibility alias for consumers of the reference project. */
export const ZenAdapter = KiloAdapter
export const createZenAdapter = createKiloAdapter
