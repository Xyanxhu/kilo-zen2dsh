import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Kilo's public OpenAI-compatible gateway.  The gateway deliberately keeps
 * the model directory separate from the chat endpoint: `/models` is public,
 * while unauthenticated completion requests are restricted to free models.
 */
export const KILO_API_BASE_URL = 'https://api.kilo.ai'
export const KILO_GATEWAY_BASE_URL = `${KILO_API_BASE_URL}/api/gateway`
export const KILO_MODELS_URL = `${KILO_GATEWAY_BASE_URL}/models`
/** @deprecated Use KILO_GATEWAY_BASE_URL. */
export const ZEN_BASE_URL = KILO_GATEWAY_BASE_URL
/**
 * Kilo's free lane is keyless.  Keep this export for callers that used the
 * old adapter's anonymous-key option, but deliberately make the default an
 * empty string so neither discovery nor completion sends Authorization.
 * A non-empty value is treated as an explicitly configured gateway token.
 */
export const ANONYMOUS_API_KEY = ''
export const KILO_USER_AGENT = 'kilo2dsh'

/**
 * A deliberately small bootstrap list.  It is only used while the public
 * catalog is unavailable; the live Kilo response is authoritative afterwards.
 * Keep this list to Kilo's stable virtual free routes rather than pinning
 * partner models that can disappear between catalog refreshes.
 */
export const staticFreeModels: string[] = [
  'kilo-auto/free',
  'openrouter/free',
]

/** Reserved for IDs seen in the catalog but not yet verified by a chat call. */
export const staticFreeCandidates: string[] = []

export interface KiloPricing {
  prompt?: string | number | null
  completion?: string | number | null
  input?: string | number | null
  output?: string | number | null
  input_cache_read?: string | number | null
  input_cache_write?: string | number | null
}

export interface KiloArchitecture {
  input_modalities?: string[] | null
  output_modalities?: string[] | null
  modality?: string | null
  [key: string]: unknown
}

export interface KiloModel {
  id: string
  name?: string
  description?: string
  context_length?: number | null
  max_completion_tokens?: number | null
  pricing?: KiloPricing | null
  architecture?: KiloArchitecture | null
  top_provider?: { max_completion_tokens?: number | null } | null
  supported_parameters?: string[] | null
  isFree?: boolean
  /** Older gateway deployments used snake_case for the same flag. */
  is_free?: boolean
  deprecated?: boolean
  mayTrainOnYourPrompts?: boolean
  opencode?: {
    ai_sdk_provider?: string
    family?: string
    prompt?: string
    variants?: Record<string, unknown>
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

export interface KiloModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  inputModalities: string[]
  reasoning: boolean
  supportsTools: boolean
}

export interface AnonymousDecision {
  allowed: boolean
  source: string
  /** True when the decision came from a live, explicit catalog record. */
  known: boolean
}

export interface ModelPrice {
  input?: number
  output?: number
  deprecated: boolean
  /** Optional authoritative Kilo free flag (not present in old fixtures). */
  free?: boolean
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isZero(value: unknown): boolean {
  const parsed = asFiniteNumber(value)
  return parsed !== undefined && parsed === 0
}

function modelId(value: string | KiloModel | unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id.trim()
  }
  return ''
}

function hasFreeSuffix(id: string): boolean {
  const lower = id.toLowerCase()
  return lower === 'kilo-auto/free' || lower === 'openrouter/free' || lower.endsWith(':free') || lower.endsWith('-free')
}

/**
 * Decide whether a Kilo model is part of the free lane.
 *
 * Kilo's `isFree` flag is authoritative.  The suffix checks are intentional
 * compatibility fallbacks for older gateway deployments and for OpenRouter's
 * conventional `:free` IDs.  Zero pricing is accepted only for a recognised
 * free ID/router; this avoids accidentally treating incomplete pricing data as
 * anonymous access.
 */
export function isFreeModel(value: string | KiloModel | unknown): boolean {
  const id = modelId(value)
  if (!id) return false

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const model = value as KiloModel
    if (model.deprecated === true) return false
    // Match Kilo/QwenPaw field precedence exactly: camelCase first, then the
    // legacy snake_case spelling. Only absent flags use the name fallback.
    if (typeof model.isFree === 'boolean') return model.isFree
    if (typeof model.is_free === 'boolean') return model.is_free
    const pricing = model.pricing ?? undefined
    const prompt = pricing?.prompt ?? pricing?.input
    const completion = pricing?.completion ?? pricing?.output
    if (hasFreeSuffix(id)) return true
    // Kilo-native routers have a stable free namespace.  For vendor models,
    // require the explicit `:free`/`-free` suffix above.
    return isZero(prompt) && isZero(completion) && (/^kilo-auto\//i.test(id) || /^openrouter\//i.test(id))
  }

  return hasFreeSuffix(id)
}

function isTextOutputModel(model: KiloModel): boolean {
  const output = model.architecture?.output_modalities
  if (!Array.isArray(output) || output.length === 0) return true
  return !output.some((modality) => String(modality).trim().toLowerCase() === 'image')
}

function supportsTools(model: KiloModel): boolean {
  const parameters = model.supported_parameters
  // Kilo treats a missing capability list as optimistic/compatible.
  return !Array.isArray(parameters) || parameters.length === 0 || parameters.some((parameter) => String(parameter).trim().toLowerCase() === 'tools')
}

function normalizeModel(raw: unknown): KiloModel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') return null
  const model: KiloModel = { ...(candidate as KiloModel), id: candidate.id.trim() }
  model.name = typeof candidate.name === 'string' && candidate.name.trim() !== '' ? candidate.name.trim() : model.id
  return model
}

/** Decode Kilo's `{ data: [...] }` model response, deduplicating IDs. */
export function decodeKiloModels(data: unknown): KiloModel[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const rows = (data as { data?: unknown }).data
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const models: KiloModel[] = []
  for (const row of rows) {
    const model = normalizeModel(row)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/** OpenAI-shaped ID helper retained for sidecar/provider integrations. */
export function decodeKiloModelIds(data: unknown): string[] {
  return decodeKiloModels(data).map((model) => model.id)
}

/** Backwards-compatible alias used by early adapters. */
export const decodeModels = decodeKiloModels

/**
 * Compatibility decoder for the reference project's models.dev fixture shape.
 * Kilo no longer needs a second metadata service, but keeping this helper
 * makes migrations and downstream tests source-compatible.
 */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const kiloModels = decodeKiloModels(data)
  if (kiloModels.length > 0) {
    const result = new Map<string, ModelPrice>()
    for (const model of kiloModels) {
      const pricing = model.pricing ?? {}
      result.set(model.id, {
        input: asFiniteNumber(pricing.prompt ?? pricing.input),
        output: asFiniteNumber(pricing.completion ?? pricing.output),
        deprecated: model.deprecated === true,
        free: isFreeModel(model),
      })
    }
    return result
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return new Map()
  const providers = data as Record<string, unknown>
  const keys = Object.keys(providers).sort((left, right) => {
    const rank = (key: string): number => {
      const lower = key.toLowerCase()
      if (lower === 'kilo' || lower === 'kilo-gateway') return 0
      if (lower.includes('kilo')) return 1
      if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 2
      if (lower.includes('opencode')) return 3
      return 4
    }
    return rank(left) - rank(right) || left.localeCompare(right)
  })
  for (const key of keys) {
    const provider = providers[key]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue
    const models = (provider as { models?: unknown }).models
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue
    const result = new Map<string, ModelPrice>()
    for (const [modelKey, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const record = raw as Record<string, unknown>
      const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : modelKey
      const cost = (record.cost ?? record.pricing ?? {}) as Record<string, unknown>
      result.set(id, {
        input: asFiniteNumber(cost.input ?? cost.prompt),
        output: asFiniteNumber(cost.output ?? cost.completion),
        deprecated: metadataDeprecated(record),
      })
    }
    if (result.size > 0) return result
  }
  return new Map()
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase()
  return status === 'deprecated' || status === 'retired' || status === 'disabled' || model.deprecated_at != null || model.retirement_date != null
}

export function modelInfo(model: KiloModel): KiloModelInfo {
  const rawContextWindow = asFiniteNumber(model.context_length)
  const contextWindow = rawContextWindow !== undefined && rawContextWindow > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(rawContextWindow))) : DEFAULT_CONTEXT_WINDOW
  const advertisedMax = model.top_provider?.max_completion_tokens ?? model.max_completion_tokens
  const rawMaxTokens = asFiniteNumber(advertisedMax)
  const maxTokens = rawMaxTokens !== undefined && rawMaxTokens > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(rawMaxTokens))) : Math.min(DEFAULT_MAX_TOKENS, contextWindow)
  const inputModalities = Array.isArray(model.architecture?.input_modalities)
    ? model.architecture!.input_modalities!.map(String).filter(Boolean)
    : ['text']
  if (!inputModalities.includes('text')) inputModalities.unshift('text')
  return {
    id: model.id,
    name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
    contextWindow,
    maxTokens,
    inputModalities,
    reasoning: Array.isArray(model.supported_parameters) && model.supported_parameters.includes('reasoning'),
    supportsTools: supportsTools(model),
  }
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
}

export interface CatalogOptions {
  refreshSeconds?: number
  cachePath?: string
  /** Base URL ending in `/api/gateway`, overridable for tests/self-hosting. */
  gatewayBaseUrl?: string
  /** @deprecated Use gatewayBaseUrl. Accepted for source compatibility. */
  zenBaseUrl?: string
  /** Fully qualified models URL; takes precedence over gatewayBaseUrl. */
  modelsUrl?: string
  /** @deprecated Kilo publishes pricing in /models; this is ignored. */
  metadataUrl?: string
  /** Optional Kilo token.  Omit it to use the public anonymous lane. */
  apiKey?: string
  /** Custom anonymous token for compatible gateway deployments. */
  anonymousKey?: string
  /** Require an explicit `tools` capability for exposed agent models. */
  requireTools?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
  onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  startupRetryMs?: number
  staleAfterMs?: number
}

const FETCH_TIMEOUT_MS = 30_000
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface ModelCache {
  updatedAt: number
  models: KiloModel[]
}

/**
 * Live Kilo model directory.  Unlike the OpenCode implementation it does not
 * need a second models.dev request: Kilo publishes `isFree` and pricing in
 * the same response as the live catalog.
 */
export class ModelCatalog {
  #models = new Map<string, KiloModel>()
  #updatedAt = 0
  #lastError = ''
  #refreshSeconds: number
  #cachePath?: string
  #modelsUrl: string
  #apiKey?: string
  #anonymousKey: string
  #requireTools: boolean
  #fetch: typeof fetch
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  #startupRetryMs: number
  #staleAfterMs: number

  constructor(options: CatalogOptions = {}) {
    this.#refreshSeconds = Math.max(1, options.refreshSeconds ?? 300)
    this.#cachePath = options.cachePath
    const gatewayBase = options.gatewayBaseUrl ?? options.zenBaseUrl ?? KILO_GATEWAY_BASE_URL
    this.#modelsUrl = options.modelsUrl ?? `${gatewayBase.replace(/\/+$/, '')}/models`
    this.#apiKey = options.apiKey?.trim() || undefined
    this.#anonymousKey = options.anonymousKey ?? ANONYMOUS_API_KEY
    this.#requireTools = options.requireTools ?? true
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#onRefresh = options.onRefresh
    this.#startupRetryMs = Math.max(0, options.startupRetryMs ?? 15_000)
    this.#staleAfterMs = Math.max(1, options.staleAfterMs ?? 10 * 60 * 1000)
  }

  async start(): Promise<void> {
    await this.refreshOnce()
    let attempts = 0
    while (this.#models.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1
      if (this.#startupRetryMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => void this.refreshOnce(), this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async refreshOnce(): Promise<void> {
    await this.refreshGateway()
    try {
      this.#onRefresh?.(this.snapshot(), this.#lastError)
    } catch {
      // Observers must never break a refresh loop.
    }
  }

  async refreshGateway(): Promise<void> {
    try {
      const models = await fetchKiloModelCatalog(this.#modelsUrl, this.#fetch, {
        apiKey: this.#apiKey,
        anonymousKey: this.#anonymousKey,
      })
      if (models.length === 0) throw new Error('Kilo models endpoint returned an empty list')
      this.#models = new Map(models.map((model) => [model.id, model]))
      this.#updatedAt = this.#now()
      this.#lastError = ''
      if (this.#cachePath) await saveModelCache(this.#cachePath, models, this.#updatedAt)
    } catch (err) {
      // A cached catalog is useful during a transient Kilo outage, but never
      // replaces a newer live snapshot.
      if (this.#cachePath && this.#models.size === 0) {
        const cached = await loadModelCache(this.#cachePath, this.#now()).catch(() => null)
        if (cached && cached.models.length > 0) {
          this.#models = new Map(cached.models.map((model) => [model.id, model]))
          this.#updatedAt = cached.updatedAt
          this.#lastError = err instanceof Error ? err.message : String(err)
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  /** Compatibility method for callers that used the old Zen naming. */
  async refreshZen(): Promise<void> {
    return this.refreshGateway()
  }

  decision(model: string): AnonymousDecision {
    const id = model.trim()
    const live = this.#models.get(id)
    if (live) {
      if (!isFreeModel(live)) return { allowed: false, source: 'catalog_paid', known: true }
      if (!isTextOutputModel(live)) return { allowed: false, source: 'catalog_output_unsupported', known: true }
      if (this.#requireTools && !supportsTools(live)) return { allowed: false, source: 'catalog_tools_unsupported', known: true }
      return { allowed: true, source: 'catalog_free', known: true }
    }
    if (this.#models.size === 0) {
      if (staticFreeModels.includes(id) || staticFreeCandidates.includes(id)) {
        return { allowed: true, source: 'static_verified', known: false }
      }
      if (isFreeModel(id)) return { allowed: true, source: 'name_free_pending', known: false }
      return { allowed: false, source: 'catalog_pending', known: false }
    }
    return { allowed: false, source: 'catalog_missing', known: false }
  }

  /** IDs exposed to DSH: live free text models, or static bootstrap IDs. */
  list(): string[] {
    if (this.#models.size === 0) return [...staticFreeModels]
    const out: string[] = []
    for (const model of this.#models.values()) {
      if (this.decision(model.id).allowed) out.push(model.id)
    }
    return out.sort()
  }

  listDetails(): KiloModelInfo[] {
    const details: KiloModelInfo[] = []
    for (const id of this.list()) {
      const model = this.#models.get(id)
      details.push(model ? modelInfo(model) : modelInfo({ id, name: id }))
    }
    return details
  }

  get(model: string): KiloModel | undefined {
    return this.#models.get(model.trim())
  }

  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
    const stale = this.#updatedAt !== 0 && age > this.#staleAfterMs
    return {
      status: this.#updatedAt === 0 ? (this.#lastError ? 'error' : 'pending') : stale ? 'stale' : 'ready',
      total: this.#models.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
    }
  }

  get lastError(): string {
    return this.#lastError
  }

  get modelsUrl(): string {
    return this.#modelsUrl
  }
}

export interface FetchKiloModelsOptions {
  apiKey?: string
  anonymousKey?: string
  userAgent?: string
  signal?: AbortSignal
}

/** Fetch and decode the full Kilo model catalog. */
export async function fetchKiloModelCatalog(
  modelsUrl: string,
  fetchImpl: typeof fetch = fetch,
  options: FetchKiloModelsOptions = {},
): Promise<KiloModel[]> {
  const token = options.apiKey?.trim() || options.anonymousKey?.trim()
  const response = await fetchWithTimeout(
    fetchImpl,
    modelsUrl,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': options.userAgent ?? KILO_USER_AGENT,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: options.signal,
    },
  )
  if (!response.ok) throw new Error(`Kilo models endpoint returned HTTP ${response.status}`)
  const models = decodeKiloModels(await response.json())
  if (models.length === 0) throw new Error('Kilo models endpoint returned an empty list')
  return models
}

/**
 * ID-only convenience helper.  It mirrors the old adapter's fetch function
 * while using Kilo's documented `/models` endpoint and anonymous semantics.
 */
export async function fetchKiloModels(
  gatewayOrModelsUrl: string,
  fetchImpl: typeof fetch = fetch,
  optionsOrUserAgent: FetchKiloModelsOptions | string = {},
): Promise<string[]> {
  const modelsUrl = /\/models(?:\/)?$/.test(gatewayOrModelsUrl)
    ? gatewayOrModelsUrl
    : `${gatewayOrModelsUrl.replace(/\/+$/, '')}/models`
  const options = typeof optionsOrUserAgent === 'string' ? { userAgent: optionsOrUserAgent } : optionsOrUserAgent
  return (await fetchKiloModelCatalog(modelsUrl, fetchImpl, options)).map((model) => model.id)
}

/** Old spelling retained so third-party callers can migrate gradually. */
export const fetchZenModels = fetchKiloModels

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = init.signal
  const abort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function saveModelCache(path: string, models: KiloModel[], updatedAt: number): Promise<void> {
  const cache: ModelCache = { updatedAt, models }
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(cache), 'utf8')
  await rm(path, { force: true })
  await rename(tmp, path)
}

async function loadModelCache(path: string, now: number): Promise<ModelCache> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as ModelCache
  if (!Number.isFinite(raw.updatedAt) || now - raw.updatedAt > CACHE_TTL_MS) throw new Error('Kilo model cache too old')
  const models = decodeKiloModels({ data: raw.models })
  if (models.length === 0) throw new Error('Kilo model cache is empty')
  return { updatedAt: raw.updatedAt, models }
}

/** Default cache location next to the plugin data directory. */
export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'kilo-models.json')
}

// ---------------------------------------------------------------------------
// Compatibility helpers for code that used the old models.dev decision API.
// They are intentionally conservative and are useful to downstream tests and
// sidecar users while all runtime decisions above use Kilo's live records.
// ---------------------------------------------------------------------------

export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
  if (!ready || prices.size === 0) {
    return isFreeModel(model)
      ? { allowed: true, source: 'name_free_pending', known: false }
      : { allowed: false, source: 'metadata_pending', known: false }
  }
  const price = prices.get(model)
  if (!price) return isFreeModel(model) ? { allowed: true, source: 'name_free', known: false } : { allowed: false, source: 'metadata_model_missing', known: false }
  if (price.free !== undefined) {
    return price.free && !price.deprecated
      ? { allowed: true, source: 'metadata_free', known: true }
      : { allowed: false, source: price.deprecated ? 'metadata_deprecated' : 'metadata_paid', known: true }
  }
  if (!price.deprecated && price.input === 0 && price.output === 0) return { allowed: true, source: 'metadata_free', known: true }
  return { allowed: false, source: price.deprecated ? 'metadata_deprecated' : 'metadata_paid', known: true }
}
