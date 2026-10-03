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
  type KiloModelInfo,
} from './catalog.ts'
import { toStreamChunks, CONTEXT_WINDOW_EXCEEDED, type HarnessChunk, type PiEvent } from './events.ts'
import { estimateRequestTokens, blendCalibration, overflowMessage, resolveWireBudget, MIN_ANSWER_TOKENS } from './budget.ts'
import { deriveRequestIDs, kiloHeaders, kiloUserAgent, type RequestIDs } from './ids.ts'
import {
  toPiContext,
  resolveRequestImages,
  type AttachmentStore,
  type HarnessGenerateOptions,
} from './messages.ts'

/**
 * Structural mirror of dsh-llm's `LlmModelReasoningInfo`, which the harness
 * reads off `resolveModel()` to populate thinking-level selectors. Declared
 * locally because this plugin deliberately keeps no dependency on the harness
 * packages; the registry validates the shape (non-empty ids and names, unique
 * ids, a known `defaultEffort`) when the adapter is registered.
 */
export interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
  /** Effort the harness materializes into a request when the caller omits one. */
  defaultEffort?: string
}

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
  /**
   * Vision-capable model ids for gateways whose directory publishes no
   * capability metadata (Zen); merged into modelInfo's modalities.
   */
  visionOverrides?: ReadonlySet<string>
  /**
   * Durable attachment service; enables image input for vision models. Pass a
   * function to resolve it lazily per request (the service registers after
   * this plugin boots), or a plain object to bind it for the adapter's life.
   */
  attachments?: AttachmentStore | (() => AttachmentStore | undefined)
  /**
   * Final wire-payload transform, invoked by pi-ai's onPayload hook after the
   * request params are built. Zen uses it to satisfy the free tier's agent
   * shape check (stream + core agent tools) on requests that would otherwise
   * be plain chat turns.
   */
  payloadDecorator?: (payload: Record<string, unknown>) => Record<string, unknown>
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

/**
 * Human-readable labels for the effort ids a Kilo reasoning model offers. DSH
 * shows these names in selectors and diagnostics, so the id (what dispatch
 * sends) and the name (what the user reads) both live here.
 */
const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

/**
 * Translate catalog reasoning metadata into the dsh-llm contract.
 *
 * Without this the harness has no levels to offer for adapter-owned models: no
 * selector appears, and every request dispatches with whatever the adapter
 * defaults to — which, before `modelToPiModel` gained
 * `thinkingLevelMap: { off: null }`, was an explicit `{"effort":"none"}` that
 * disabled thinking on reasoning models.
 */
function reasoningInfo(info: Pick<KiloModelInfo, 'reasoning' | 'reasoningEfforts'>): LlmModelReasoningInfo | undefined {
  if (!info.reasoning || !Array.isArray(info.reasoningEfforts) || info.reasoningEfforts.length === 0) return undefined
  type EffortId = LlmModelReasoningInfo['efforts'][number]['id']
  const efforts = info.reasoningEfforts.map((id) => ({ id: id as EffortId, name: REASONING_EFFORT_LABELS[id] ?? id }))
  // No `defaultEffort` on purpose: measured against the live gateway, an omitted
  // effort spends the strongest tier the provider offers, so pinning one here
  // would silently make every session think less than the model would on its own.
  return { efforts }
}

function modelToPiModel(
  model: KiloModel,
  providerId: string,
  gatewayBaseUrl: string,
  headers: Record<string, string>,
  api: Api = 'openai-completions',
  gatewayMaxOutputTokens: number | null = KILO_GATEWAY_MAX_OUTPUT_TOKENS,
  visionOverrides?: ReadonlySet<string>,
): Model<Api> {
  const info = modelInfo(model, { gatewayMaxOutputTokens, visionOverrides })
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
    // pi-ai treats `off: null` as "this model has no explicit off wire value",
    // so an omitted effort sends no reasoning field at all and the provider
    // keeps its own default. Without it pi-ai's openrouter format emits
    // `{"effort":"none"}` whenever no level is selected, which silently disabled
    // thinking on every reasoning model (and, until reasoning metadata was
    // declared, no level could ever be selected). `xhigh`/`max` are mapped to
    // themselves because pi-ai only counts a level as available when the map
    // declares it; otherwise it clamps them down to `high`.
    ...(info.reasoning ? { thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' } } : {}),
    // pi-ai gates inline image parts on `input` including "image"; keep it in
    // sync with the modalities the gateway actually declares for this model.
    input: info.inputModalities,
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
  /**
   * Per-model ratio of gateway-reported input tokens to this adapter's raw
   * prompt estimate. Absent means "use the raw, deliberately conservative
   * estimate"; every successful request refines it.
   */
  readonly #calibration = new Map<string, number>()
  /** Vision ids for metadata-less directories; undefined means no overrides. */
  readonly #visionOverrides: ReadonlySet<string> | undefined
  /**
   * Resolved per request, not cached at construction: the attachment service
   * registers later in the boot order than this plugin, so a value read once
   * in the constructor would still be undefined when the first request lands.
   */
  readonly #resolveAttachments?: () => AttachmentStore | undefined

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
    this.#resolveAttachments =
      typeof options.attachments === 'function'
        ? (options.attachments as () => AttachmentStore | undefined)
        : options.attachments === undefined
          ? undefined
          : () => options.attachments as AttachmentStore
    this.#maxOutputTokens = options.maxOutputTokens === null
      ? null
      : (() => {
          const parsed = numeric(options.maxOutputTokens, KILO_GATEWAY_MAX_OUTPUT_TOKENS)
          return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(parsed)))
        })()
    this.#visionOverrides = options.visionOverrides
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

  listModels(provider: string): Array<{ provider: string; id: string; name: string; description?: string; inputModalities: string[] }> {
    const seen = new Set<string>()
    const models: Array<{ provider: string; id: string; name: string; description?: string; inputModalities: string[] }> = []
    for (const id of this.#catalog.list()) {
      if (seen.has(id)) continue
      seen.add(id)
      const detail = this.#catalog.get?.(id)
      const info = detail
        ? modelInfo(detail, { gatewayMaxOutputTokens: this.#maxOutputTokens, visionOverrides: this.#visionOverrides })
        : { id, name: id, description: undefined, inputModalities: this.#visionOverrides?.has(id) ? ['text', 'image'] : ['text'] }
      // Reasoning metadata is not part of the list contract (dsh-llm keeps only
      // identity, description, and modalities here); callers that need the
      // selectable efforts resolve the model, which is where DSH validates them.
      models.push({
        provider,
        id,
        name: info.name,
        ...(info.description === undefined ? {} : { description: info.description }),
        inputModalities: info.inputModalities,
      })
    }
    return models
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    description?: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
    reasoning?: LlmModelReasoningInfo
  } {
    const detail = this.#catalog.get?.(model)
    const info = detail
      ? modelInfo(detail, { gatewayMaxOutputTokens: this.#maxOutputTokens, visionOverrides: this.#visionOverrides })
      : modelInfo(
          {
            id: model,
            name: model,
            context_length: DEFAULT_CONTEXT_WINDOW,
            max_completion_tokens: DEFAULT_MAX_TOKENS,
          },
          { gatewayMaxOutputTokens: this.#maxOutputTokens, visionOverrides: this.#visionOverrides },
        )
    const reasoning = reasoningInfo(info)
    return {
      provider,
      id: model,
      name: info.name,
      ...(info.description === undefined ? {} : { description: info.description }),
      inputModalities: info.inputModalities,
      context: { contextWindow: numeric(info.contextWindow, DEFAULT_CONTEXT_WINDOW) },
      defaultMaxTokens: numeric(info.maxTokens, DEFAULT_MAX_TOKENS),
      ...(reasoning === undefined ? {} : { reasoning }),
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

    const images = await resolveRequestImages(options.messages, this.#resolveAttachments?.())
    const context = toPiContext(options, images)
    const ids = deriveRequestIDs(options.messages, this.#options.projectNamespace ?? 'kilo2dsh:default-project')
    const detail = this.#catalog.get?.(modelId) ?? fallbackModel(modelId)
    const info = modelInfo(detail, { gatewayMaxOutputTokens: this.#maxOutputTokens, visionOverrides: this.#visionOverrides })
    // A gateway's advertised output cap is a per-request maximum, while the
    // harness reserves whatever the adapter declares for every request. Clamp
    // the budget we actually send against this prompt so input + answer can
    // never exceed the window the gateway enforces. The raw estimate is scaled
    // by this route's calibration factor, learned from the gateway's own usage
    // reports, so a systematic estimator bias cannot eat the answer budget.
    const rawInputTokens = estimateRequestTokens(options)
    const budget = resolveWireBudget({
      requested: options.maxTokens,
      modelMaxTokens: info.maxTokens,
      contextWindow: info.contextWindow,
      estimatedInputTokens: rawInputTokens,
      calibration: this.#calibration.get(modelId),
    })
    if (budget.overflow) {
      // Nothing fits: report the failure shape pi-ai's overflow classifier
      // produces so dsh-llm routes it to context-overflow compaction instead of
      // spending a request the gateway is guaranteed to reject.
      yield { type: 'usage', usage: { inputTokens: budget.effectiveInputTokens, outputTokens: 0 } }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: overflowMessage(budget.effectiveInputTokens, info.contextWindow),
            code: CONTEXT_WINDOW_EXCEEDED,
          },
        },
      }
      return
    }
    // `budget.overflow` returned already, so a budget is always present here;
    // falling back to the model cap would bypass the prompt clamp entirely.
    const wireMaxTokens = budget.maxTokens ?? MIN_ANSWER_TOKENS
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
      this.#visionOverrides,
    )
    const events = this.#provider.streamSimple(model, context as unknown as Context, {
      apiKey: this.#transportApiKey,
      sessionId: ids.session,
      headers,
      signal: options.signal,
      maxRetries: 0,
      temperature: options.temperature,
      maxTokens: wireMaxTokens,
      reasoning: thinkingLevel(options.reasoningEffort),
      onPayload: (payload) => {
        const clamped = clampPayloadMaxTokens(payload, wireMaxTokens)
        const record = (clamped ?? payload) as Record<string, unknown>
        return this.#options.payloadDecorator ? this.#options.payloadDecorator(record) : record
      },
    })
    // Forward the stream while watching for the gateway's own usage report: the
    // full prompt it counted, against our raw estimate, is the calibration
    // sample that keeps future budgets honest. `inputTokens` alone is the wrong
    // sample — dsh-llm reports cached input separately and pi-ai derives it as
    // `prompt_tokens - cacheRead - cacheWrite` — so a cached session would look
    // like a prompt an order of magnitude smaller than it really is.
    let reportedPromptTokens: number | undefined
    let failed = false
    for await (const chunk of toStreamChunks(events as unknown as AsyncIterable<PiEvent>, model.contextWindow)) {
      if (chunk.type === 'usage') {
        const accounted =
          chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0)
        if (accounted > 0) reportedPromptTokens = accounted
      }
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') failed = true
      yield chunk
    }
    if (!failed && reportedPromptTokens !== undefined && rawInputTokens > 0) {
      this.#calibration.set(
        modelId,
        blendCalibration(this.#calibration.get(modelId), reportedPromptTokens / rawInputTokens),
      )
    }
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
