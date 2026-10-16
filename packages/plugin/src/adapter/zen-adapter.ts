import {
  OPENCODE_ZEN_ANONYMOUS_API_KEY,
  OPENCODE_ZEN_ANONYMOUS_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_GATEWAY_BASE_URL,
  ZEN_VISION_MODEL_IDS,
  normalizeZenGatewayUrl,
} from './catalog.ts'
import {
  KiloAdapter,
  type CatalogLike,
  type KiloAdapterOptions,
} from './kilo-adapter.ts'
import { opencodeHeaders, opencodeUserAgent, type RequestIDs } from './ids.ts'
import { OPENCODE_TOOL_DEFINITIONS } from './opencode-tools.ts'
import type { Api } from '@earendil-works/pi-ai'
import type { KiloModel } from './catalog.ts'

/** Provider id retained by the original OpenCode/Zen DSH integration. */
export const ZEN_PROVIDER_ID = 'opencode2dsh'
/** @deprecated Use ZEN_PROVIDER_ID. Kept for direct file-level imports. */
export const PROVIDER_ID = ZEN_PROVIDER_ID

/** Zen currently serves this free model through the Responses API. */
export const ZEN_RESPONSES_MODEL_IDS = ['muse-spark-1.2-contributor-free'] as const

/**
 * The five core agent tool names Zen's free tier requires in the request's
 * tools array. "shell" is the name OpenCode 2.x ships; the pre-2.x "bash"
 * spelling is deliberately not injected.
 */
const ZEN_AGENT_CORE_TOOLS = ['shell', 'edit', 'glob', 'grep', 'read'] as const

/**
 * One core tool in OpenAI chat-completions format carrying the genuine
 * OpenCode definition. Since 2026-10-14 the free-tier gate validates the
 * description and parameter schema of every tool whose name it recognises —
 * a synthesised stub is rejected with 403 FreeTierError even with the right
 * name — so the definitions captured from the official client are embedded.
 */
function agentShellTool(name: string): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  const definition = OPENCODE_TOOL_DEFINITIONS[name]
  return {
    type: 'function',
    function: {
      name,
      description: definition?.description ?? `Agent tool ${name}`,
      parameters: definition?.parameters ?? { type: 'object', properties: {} },
    },
  }
}

/**
 * Zen's anonymous free lane (Bearer public) only accepts requests shaped
 * like an OpenCode agent turn: streaming, with the five core agent tools
 * present. pi-ai already streams every request; this decorator fills in the
 * missing core tools on plain chat turns so they satisfy the same shape.
 *
 * Downstream (DSH) tools are deliberately left untouched, even when they
 * reuse a recognised name: rewriting their definitions would change the
 * schema the model sees and break this harness's own function-call parsing.
 * Only the names this decorator injects carry the genuine definitions.
 */
export function decorateZenPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // OpenAI chat-completions spelling: tools: [{ type: 'function', function: { name } }]
  const tools = payload.tools
  if (Array.isArray(tools)) {
    const present = new Set<string>()
    for (const tool of tools) {
      const name = (tool as { function?: { name?: unknown }; name?: unknown })?.function?.name ?? (tool as { name?: unknown })?.name
      if (typeof name === 'string' && name) present.add(name)
    }
    const missing = ZEN_AGENT_CORE_TOOLS.filter((name) => !present.has(name))
    if (missing.length === 0) return payload
    return { ...payload, tools: [...tools, ...missing.map(agentShellTool)] }
  }
  return { ...payload, tools: ZEN_AGENT_CORE_TOOLS.map(agentShellTool) }
}

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
    // Keyless and keyed traffic live on different hosts since 2026-10-14;
    // an explicit base always wins, otherwise the default follows the lane.
    const defaultBase = options.apiKey?.trim() ? OPENCODE_ZEN_BASE_URL : OPENCODE_ZEN_ANONYMOUS_BASE_URL
    const gatewayBaseUrl = normalizeZenGatewayUrl(options.gatewayBaseUrl?.trim() || options.zenBaseUrl?.trim() || defaultBase)
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
      // The 524,288-token ceiling is specific to the Kilo gateway's current
      // MiniMax compatibility lane; Zen owns its own model limits.
      maxOutputTokens: options.maxOutputTokens ?? null,
      // Zen's directory publishes no capability metadata, so vision-capable
      // free models need the verified-id table to keep dsh-llm from
      // projecting them text-only (and dropping image input).
      visionOverrides: options.visionOverrides ?? ZEN_VISION_MODEL_IDS,
      apiResolver: options.apiResolver ?? zenModelApi,
      payloadDecorator: options.payloadDecorator ?? decorateZenPayload,
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
