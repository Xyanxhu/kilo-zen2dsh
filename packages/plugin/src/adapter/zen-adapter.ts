import {
  OPENCODE_ZEN_ANONYMOUS_API_KEY,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_GATEWAY_BASE_URL,
  normalizeZenGatewayUrl,
} from './catalog.ts'
import {
  KiloAdapter,
  type CatalogLike,
  type KiloAdapterOptions,
} from './kilo-adapter.ts'
import { opencodeHeaders, opencodeUserAgent, type RequestIDs } from './ids.ts'
import type { Api } from '@earendil-works/pi-ai'
import type { KiloModel } from './catalog.ts'

/** Provider id retained by the original OpenCode/Zen DSH integration. */
export const ZEN_PROVIDER_ID = 'opencode2dsh'
/** @deprecated Use ZEN_PROVIDER_ID. Kept for direct file-level imports. */
export const PROVIDER_ID = ZEN_PROVIDER_ID

/** Zen currently serves this free model through the Responses API. */
export const ZEN_RESPONSES_MODEL_IDS = ['muse-spark-1.2-contributor-free'] as const

/**
 * Select the wire API for a Zen model. The public catalog is intentionally
 * sparse, so keep the known Responses model explicit and allow future catalog
 * records to advertise an API/protocol field without making every model
 * Responses traffic by default.
 */
export function zenModelApi(model: KiloModel): Api {
  // Different Zen-compatible catalog deployments have used each of these
  // fields (and, for a few records, nested `opencode` metadata). Treat any
  // explicit Responses marker as authoritative instead of letting a generic
  // `api: chat` field mask a more specific protocol declaration.
  const advertised = [
    model.api,
    model.protocol,
    model.endpoint,
    model.opencode?.api,
    model.opencode?.protocol,
    model.opencode?.endpoint,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(' ')
    .toLowerCase()
  if (advertised.includes('response')) return 'openai-responses'
  const id = model.id.trim().toLowerCase()
  if (
    ZEN_RESPONSES_MODEL_IDS.some((candidate) => candidate === id) ||
    /(?:^|[-_:])responses(?:[-_:]|$)/.test(id) ||
    (/^muse-spark(?:[-.\w])*free$/.test(id) && id.includes('contributor'))
  ) {
    return 'openai-responses'
  }
  return 'openai-completions'
}

export interface ZenAdapterOptions extends KiloAdapterOptions {
  /** Zen root (`https://opencode.ai/zen`) or an already-qualified `/v1` URL. */
  zenBaseUrl?: string
}

/**
 * Native DSH adapter for OpenCode Zen's free lane. Zen is intentionally kept
 * separate from Kilo: it uses `/zen/v1`, the public placeholder credential,
 * and OpenCode compatibility headers required by the anonymous lane.
 */
export class ZenAdapter extends KiloAdapter {
  constructor(catalog: CatalogLike, options: ZenAdapterOptions = {}) {
    const gatewayBaseUrl = normalizeZenGatewayUrl(options.gatewayBaseUrl?.trim() || options.zenBaseUrl?.trim() || OPENCODE_ZEN_BASE_URL)
    const userAgent = options.userAgent?.trim() || opencodeUserAgent()
    super(catalog, {
      ...options,
      providerId: options.providerId?.trim() || ZEN_PROVIDER_ID,
      gatewayBaseUrl,
      anonymousKey: options.anonymousKey ?? OPENCODE_ZEN_ANONYMOUS_API_KEY,
      userAgent,
      displayName: options.displayName ?? 'OpenCode Zen (free)',
      authName: options.authName ?? 'OpenCode Zen API key (optional)',
      projectNamespace: options.projectNamespace ?? 'opencode2dsh:default-project',
      apiResolver: options.apiResolver ?? zenModelApi,
      headerBuilder:
        options.headerBuilder ??
        ((ids: RequestIDs, adapterOptions: KiloAdapterOptions, mode?: unknown) => {
          const headers = opencodeHeaders(ids, { userAgent: adapterOptions.userAgent ?? userAgent })
          if (typeof mode === 'string' && mode.length > 0) headers['x-opencode-mode'] = mode
          return headers
        }),
    })
  }
}

export function createZenAdapter(catalog: CatalogLike, options?: ZenAdapterOptions): ZenAdapter {
  return new ZenAdapter(catalog, options)
}

/** Explicit alias for callers that want to distinguish the two adapters. */
export const OpenCodeZenAdapter = ZenAdapter

export type { KiloAdapterOptions, CatalogLike }
export type { KiloModelInfo as ZenModelInfo } from './catalog.ts'
export { OPENCODE_ZEN_ANONYMOUS_API_KEY, OPENCODE_ZEN_BASE_URL, OPENCODE_ZEN_GATEWAY_BASE_URL }
