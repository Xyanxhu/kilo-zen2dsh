/**
 * OpenCode's public capability catalog (https://models.opencode.ai/api.json).
 * It is the machine-readable provider list the CLI itself consumes: for the
 * Zen provider it carries the context/output limits, modality and capability
 * flags that Zen's minimal OpenAI-shaped `/v1/models` directory does not
 * publish. Without it every Zen model falls back to the 256K/32K defaults.
 *
 * This module is deliberately self-contained (no imports from catalog.ts) so
 * the catalog can import the enricher without an import cycle.
 */

/** URL of OpenCode's public capability catalog. */
export const OPENCODE_CAPABILITIES_URL = 'https://models.opencode.ai/api.json'

/** Capabilities of one Zen model, normalized from the catalog record. */
export interface OpenCodeModelCapability {
  name?: string
  description?: string
  context?: number
  input?: number
  output?: number
  reasoning: boolean
  toolCall: boolean
  inputModalities: string[]
  outputModalities: string[]
}

/**
 * Minimal model shape the enricher touches. Structurally compatible with
 * catalog.ts's KiloModel, so either type can be passed through unchanged.
 */
export interface CapabilityTargetModel {
  id: string
  name?: string
  description?: string
  context_length?: number | string | null
  contextWindow?: number | string | null
  context_window?: number | string | null
  max_context_tokens?: number | string | null
  max_output_tokens?: number | string | null
  maxTokens?: number | string | null
  max_tokens?: number | string | null
  max_completion_tokens?: number | string | null
  architecture?: { input_modalities?: string[] | null; [key: string]: unknown } | null
  supported_parameters?: string[] | null
  [key: string]: unknown
}

export interface FetchOpenCodeCapabilitiesOptions {
  userAgent?: string
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_CAPABILITY_TIMEOUT_MS = 20_000

function normalizeApiUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, '')
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

function positiveInt(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter((entry) => entry !== '')
}

/**
 * Parse the capability catalog and return the models of the provider whose
 * `api` matches the Zen gateway URL (https://opencode.ai/zen/v1 by default).
 * The Go provider (…/zen/go/v1) and unrelated providers are ignored, so the
 * result only ever describes the lane the Zen adapter actually serves.
 * Malformed entries are skipped; the ids prefer the record's own `id` over
 * the map key, mirroring the catalog's model-id conventions.
 */
export function parseOpenCodeCapabilities(
  data: unknown,
  zenApiUrl = 'https://opencode.ai/zen/v1',
): Map<string, OpenCodeModelCapability> {
  const result = new Map<string, OpenCodeModelCapability>()
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result
  const target = normalizeApiUrl(zenApiUrl)
  if (target === '') return result
  for (const provider of Object.values(data as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue
    const providerRecord = provider as Record<string, unknown>
    if (normalizeApiUrl(providerRecord.api) !== target) continue
    const models = providerRecord.models
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue
    for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const record = raw as Record<string, unknown>
      const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : key.trim()
      if (id === '') continue
      const limit = (record.limit && typeof record.limit === 'object' && !Array.isArray(record.limit)
        ? record.limit
        : {}) as Record<string, unknown>
      const modalities = (record.modalities && typeof record.modalities === 'object' && !Array.isArray(record.modalities)
        ? record.modalities
        : {}) as Record<string, unknown>
      const capability: OpenCodeModelCapability = {
        reasoning: record.reasoning === true,
        toolCall: record.tool_call === true,
        inputModalities: stringList(modalities.input),
        outputModalities: stringList(modalities.output),
      }
      const context = positiveInt(limit.context)
      const input = positiveInt(limit.input)
      if (context !== undefined || input !== undefined) {
        capability.context = context !== undefined && input !== undefined ? Math.min(context, input) : (context ?? input)
      }
      const output = positiveInt(limit.output)
      if (output !== undefined) capability.output = output
      const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : undefined
      if (name !== undefined) capability.name = name
      const description =
        typeof record.description === 'string' && record.description.trim() !== '' ? record.description.trim() : undefined
      if (description !== undefined) capability.description = description
      result.set(id, capability)
    }
  }
  return result
}

function hasContextLimit(model: CapabilityTargetModel): boolean {
  return (
    model.context_length != null ||
    model.contextWindow != null ||
    model.context_window != null ||
    model.max_context_tokens != null
  )
}

function hasOutputLimit(model: CapabilityTargetModel): boolean {
  return (
    model.max_output_tokens != null ||
    model.maxTokens != null ||
    model.max_tokens != null ||
    model.max_completion_tokens != null
  )
}

/**
 * Fill the capability metadata into catalog records that carry none of it.
 * Enrichment is strictly additive: a value the directory itself published is
 * never overwritten, and models without a matching capability entry (or an
 * empty map) pass through unchanged.
 *
 * `supported_parameters` is only assigned when the capability advertises
 * tools, because catalog.ts treats a missing list as tool-optimistic while a
 * list without `tools` hides the model entirely; a tool-less record must not
 * silently disappear from the picker.
 */
export function enrichZenModels<T extends CapabilityTargetModel>(
  models: readonly T[],
  capabilities: ReadonlyMap<string, OpenCodeModelCapability>,
): T[] {
  if (capabilities.size === 0 || models.length === 0) return [...models]
  return models.map((model) => {
    const capability = capabilities.get(model.id)
    if (!capability) return model
    const enriched: T = { ...model }
    if (!hasContextLimit(enriched) && capability.context !== undefined) enriched.context_length = capability.context
    if (!hasOutputLimit(enriched) && capability.output !== undefined) {
      enriched.max_output_tokens = capability.output
    }
    if (!Array.isArray(enriched.architecture?.input_modalities) && capability.inputModalities.length > 0) {
      enriched.architecture = { ...(enriched.architecture ?? {}), input_modalities: [...capability.inputModalities] }
    }
    if (!Array.isArray(enriched.supported_parameters)) {
      const parameters: string[] = []
      if (capability.toolCall) parameters.push('tools')
      if (capability.reasoning) parameters.push('reasoning')
      if (parameters.includes('tools')) enriched.supported_parameters = parameters
    }
    if ((enriched.name === undefined || enriched.name === enriched.id) && capability.name !== undefined) {
      enriched.name = capability.name
    }
    if ((enriched.description === undefined || enriched.description === '') && capability.description !== undefined) {
      enriched.description = capability.description
    }
    return enriched
  })
}

/**
 * Fetch and parse the capability catalog. Throws on transport or HTTP
 * errors; callers that treat the metadata as optional (the Zen catalog does)
 * are expected to catch. The document is a few megabytes, so the caller
 * should memoize it rather than refetch per refresh.
 */
export async function fetchOpenCodeCapabilities(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: FetchOpenCodeCapabilitiesOptions = {},
): Promise<Map<string, OpenCodeModelCapability>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_CAPABILITY_TIMEOUT_MS)
  const signal = options.signal
  const abort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.userAgent?.trim() ? { 'user-agent': options.userAgent.trim() } : {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`OpenCode capability catalog returned HTTP ${response.status}`)
    return parseOpenCodeCapabilities(await response.json())
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
