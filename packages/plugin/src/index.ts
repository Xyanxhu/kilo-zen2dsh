import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'

import {
  ModelCatalog,
  ZenModelCatalog,
  defaultCachePath,
  defaultZenCachePath,
  type CatalogSnapshot,
} from './adapter/catalog.ts'
import { KiloAdapter } from './adapter/kilo-adapter.ts'
import { ZenAdapter } from './adapter/zen-adapter.ts'
import { AgentProcess, type ReadyInfo } from './agent-process.js'
import { configPaths, ensureToken, resolveConfig, writeAgentConfig, type Kilo2dshConfig } from './config.js'
import { fetchHealth, fetchModels, registerProvider, removeProviderRoute } from './provider.js'

/**
 * kilo2dsh DSH cordis plugin entry.
 *
 * Two modes (config.mode, default `adapter`):
 *  - adapter: register DSH LlmAdapters streaming directly from the Kilo and
 *    (by default) OpenCode Zen free lanes (marketplace shape: no child
 *    process, no binary).
 *  - sidecar (legacy/dev): prepare data dir + token + agent-config.json,
 *    spawn the Go agent, wait for READY, register the llm-pi-ai provider
 *    route, schedule model refresh.
 *
 * dispose(): stop timers/catalog, terminate the agent tree (sidecar mode).
 * The cordis fiber disposal guarantees this runs on plugin reload/unload and
 * on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  credentials?: { set(ref: string, value: string): Promise<void> }
  settings?: {
    get(ns: string): unknown
    mutate(ns: string, ops: Array<{ op: 'set' | 'unset'; path: Array<string | number>; value?: unknown }>): Promise<void>
  }
  effect?(fn: () => () => void): unknown
}

export const name = 'kilo2dsh'
export const inject = ['llm', 'credentials', 'settings'] as const
export function apply(ctx: PluginContext, config: Kilo2dshConfig = {}): { ready: Promise<ReadyInfo> } {
  if (resolveConfig(config).mode === 'sidecar') return applySidecar(ctx, config)
  return applyAdapter(ctx, config)
}

/**
 * Adapter mode: catalog + LlmAdapter registration. The adapter registration
 * is disposed with the plugin fiber (registerAdapter uses ctx.effect
 * internally); we only own the catalog refresh loop here.
 */
function applyAdapter(ctx: PluginContext, config: Kilo2dshConfig): { ready: Promise<{ port: number; version: string }> } {
  const logger = ctx.logger
  const cfg = resolveConfig(config)
  const ready = Promise.resolve({ port: 0, version: 'adapter' })

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('kilo2dsh: llm service unavailable; adapter mode cannot register')
    return { ready }
  }

  // Health snapshots for adapter mode (the agent-mode healthz equivalent):
  // each upstream gets its own file so concurrent refreshes cannot overwrite
  // one another.
  const dataDir = join(homedir(), '.kilo2dsh')
  const writeStatus = (filename: string, status: CatalogSnapshot, lastError: string): void => {
    const statusPath = join(dataDir, filename)
    void mkdir(dataDir, { recursive: true })
      .then(() =>
        writeFile(
          statusPath,
          JSON.stringify({ ...status, lastError, writtenAt: new Date().toISOString() }, null, 2),
          'utf8',
        ),
      )
      .catch(() => {})
  }

  const upstreamApiKey = cfg.upstreamApiKeyEnv ? process.env[cfg.upstreamApiKeyEnv]?.trim() || undefined : undefined
  const kiloCatalog = new ModelCatalog({
    refreshSeconds: cfg.refreshSeconds,
    cachePath: defaultCachePath(dataDir),
    gatewayBaseUrl: cfg.gatewayBaseUrl,
    apiKey: upstreamApiKey,
    anonymousKey: cfg.anonymousKey,
    requireTools: cfg.requireTools,
    onRefresh: (status, lastError) => {
      writeStatus('adapter-status.json', status, lastError)
      if (lastError) logger.warn(`kilo2dsh: catalog refresh issue: ${lastError}`)
    },
  })
  const kiloAdapter = new KiloAdapter(kiloCatalog, {
    providerId: cfg.providerId,
    gatewayBaseUrl: cfg.gatewayBaseUrl,
    apiKey: upstreamApiKey,
    anonymousKey: cfg.anonymousKey,
  })

  // Register immediately: providers must appear in the selector while their
  // independent catalogs warm up in the background.
  ctx.llm.registerAdapter([cfg.providerId], kiloAdapter)
  logger.info(`kilo2dsh: adapter registered for "${cfg.providerId}" (catalog warms up in background)`)
  void kiloCatalog.start().catch((err) => {
    logger.error(`kilo2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  const catalogs: ModelCatalog[] = [kiloCatalog]
  const providerIds = [cfg.providerId]

  if (cfg.zenEnabled) {
    if (cfg.zenProviderId === cfg.providerId) {
      logger.warn(`kilo2dsh: Zen provider id "${cfg.zenProviderId}" matches Kilo provider; Zen registration skipped`)
    } else {
      const zenApiKey = cfg.zenApiKeyEnv ? process.env[cfg.zenApiKeyEnv]?.trim() || undefined : undefined
      const zenCatalog = new ZenModelCatalog({
        refreshSeconds: cfg.refreshSeconds,
        cachePath: defaultZenCachePath(dataDir),
        zenBaseUrl: cfg.zenBaseUrl,
        userAgent: cfg.zenUserAgent || undefined,
        apiKey: zenApiKey,
        anonymousKey: cfg.zenAnonymousKey,
        requireTools: cfg.requireTools,
        onRefresh: (status, lastError) => {
          writeStatus('zen-adapter-status.json', status, lastError)
          if (lastError) logger.warn(`kilo2dsh: OpenCode Zen catalog refresh issue: ${lastError}`)
        },
      })
      const zenAdapter = new ZenAdapter(zenCatalog, {
        providerId: cfg.zenProviderId,
        zenBaseUrl: cfg.zenBaseUrl,
        userAgent: cfg.zenUserAgent || undefined,
        apiKey: zenApiKey,
        anonymousKey: cfg.zenAnonymousKey,
      })
      ctx.llm.registerAdapter([cfg.zenProviderId], zenAdapter)
      logger.info(`kilo2dsh: OpenCode Zen adapter registered for "${cfg.zenProviderId}" (catalog warms up in background)`)
      void zenCatalog.start().catch((err) => {
        logger.error(`kilo2dsh: OpenCode Zen catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      catalogs.push(zenCatalog)
      providerIds.push(cfg.zenProviderId)
    }
  }

  // A sidecar leftover (llm-pi-ai.providers.<provider> pointing at a dead
  // local port) would shadow an adapter registration and fail dispatch.
  if (ctx.settings) {
    for (const providerId of providerIds) {
      removeProviderRoute({ settings: ctx.settings }, providerId)
        .then((removed) => {
          if (removed) logger.info(`kilo2dsh: removed stale sidecar route for "${providerId}" from llm-pi-ai settings`)
        })
        .catch((err) => {
          logger.warn(`kilo2dsh: stale route cleanup failed for "${providerId}": ${err instanceof Error ? err.message : String(err)}`)
        })
    }
  }

  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      for (const catalog of catalogs) catalog.stop()
    })
  }
  return { ready }
}

function applySidecar(ctx: PluginContext, config: Kilo2dshConfig): { ready: Promise<ReadyInfo> } {
  const cfg = resolveConfig(config)
  const paths = configPaths(join(homedir(), '.kilo2dsh'))
  const logger = ctx.logger
  if (cfg.zenEnabled) {
    logger.warn('kilo2dsh: zenEnabled applies only to native adapter mode; legacy sidecar remains Kilo-only')
  }

  let agent: AgentProcess | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  let disposed = false
  let readyResolve: (info: ReadyInfo) => void = () => {}
  const ready = new Promise<ReadyInfo>((resolve) => {
    readyResolve = resolve
  })

  const onLog = (line: string) => {
    // Agent structured logs arrive as single JSON lines on stderr/stdout.
    logger.info(`[agent] ${line}`)
  }

  /**
   * Wait until the agent's model catalog is no longer "pending" (it fetches
   * the live S1 list a moment after listen; registering before that bakes the
   * 3-model static fallback into the DSH provider until the next refresh).
   */
  async function waitCatalogReady(port: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const health = await fetchHealth(port, 2000)
        const status = (health as { models?: { status?: string } })?.models?.status
        if (status && status !== 'pending') return
      } catch {
        // healthz hiccups right after listen are normal; keep polling
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    logger.warn('kilo2dsh: catalog still pending after timeout; registering whatever the agent exposes now')
  }

  async function refreshModels(info: ReadyInfo, token: string, { waitReady = false } = {}): Promise<void> {
    try {
      if (waitReady) await waitCatalogReady(info.port)
      const models = await fetchModels(info.port, token)
      if (ctx.credentials && ctx.settings) {
        await registerProvider(
          {
            credentials: ctx.credentials,
            settings: ctx.settings,
            logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
          },
          { providerId: cfg.providerId, apiKeyEnv: cfg.apiKeyEnv, port: info.port },
          token,
          models,
        )
      } else {
        logger.warn('kilo2dsh: credentials/settings services unavailable; provider route not registered')
      }
    } catch (err) {
      logger.warn(`kilo2dsh: model refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function scheduleRefresh(info: ReadyInfo, token: string): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      if (disposed) return
      void refreshModels(info, token).then(() => {
        if (!disposed && agent?.getState() === 'ready') scheduleRefresh(info, token)
      })
    }, cfg.refreshSeconds * 1000)
  }

  async function startOnce(): Promise<ReadyInfo> {
    const token = await ensureToken(paths)
    const upstreamApiKey = cfg.upstreamApiKeyEnv ? process.env[cfg.upstreamApiKeyEnv]?.trim() || undefined : undefined
    await writeAgentConfig(paths, {
      token,
      refreshSeconds: cfg.refreshSeconds,
      gatewayBaseUrl: cfg.gatewayBaseUrl,
      anonymousKey: upstreamApiKey ?? cfg.anonymousKey,
    })
    const binary = cfg.agentPath ?? defaultAgentPath()
    agent = new AgentProcess(binary, ['--config', paths.configPath, '--print-ready', ...(cfg.agentArgs ?? [])], {
      restartDelayMs: cfg.restartDelayMs,
      restartMaxDelayMs: cfg.restartMaxDelayMs,
      maxConsecutiveCrashes: cfg.maxConsecutiveCrashes,
      onLog,
    })
    agent.on('exit-restart', (delay, crashes) => {
      logger.warn(`kilo2dsh: agent exited unexpectedly; restarting in ${delay}ms (attempt ${crashes})`)
    })
    agent.on('circuit-tripped', (crashes) => {
      logger.error(`kilo2dsh: agent crashed ${crashes} times consecutively; giving up`)
    })
    agent.on('state', (state) => {
      if (state === 'ready') logger.info('kilo2dsh: agent ready')
    })
    const info = await agent.start()
    readyResolve(info)
    await refreshModels(info, token, { waitReady: true })
    scheduleRefresh(info, token)
    return info
  }

  void startOnce().catch((err) => {
    logger.error(`kilo2dsh: failed to start agent: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Register disposer on the plugin fiber so reload/unload/shutdown reaps the
  // child process (plan.md Phase 1 acceptance: no orphans).
  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      void teardown()
    })
  }

  async function teardown(): Promise<void> {
    disposed = true
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (agent) {
      await agent.dispose().catch(() => {})
      agent = null
    }
  }

  return { ready }
}

/**
 * Locate the agent binary (sidecar mode, legacy — the published package does
 * not bundle it): explicit config wins; then a sibling `legacy/agent` dev
 * build; then a bare name on PATH.
 */
export function defaultAgentPath(): string {
  const bin = 'kilo2dsh-agent'
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin
  const here = __dirnameSafe()
  for (const sibling of [
    join(here, '..', '..', '..', 'legacy', process.platform === 'win32' ? 'agent.exe' : 'agent'),
    join(here, '..', '..', 'legacy', process.platform === 'win32' ? 'agent.exe' : 'agent'),
    join(here, '..', '..', '..', 'legacy', 'agent', exe),
    join(here, '..', '..', 'legacy', 'agent', exe),
  ]) {
    if (existsSync(sibling)) return sibling
  }
  return exe
}

import { fileURLToPath } from 'node:url'

function __dirnameSafe(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return '.'
  }
}

export { AgentProcess } from './agent-process.js'
export { configPaths, ensureToken, resolveConfig, writeAgentConfig, type Kilo2dshConfig, type Opencode2dshConfig } from './config.js'
export { fetchHealth, fetchModels, registerProvider, providerBaseURL, toPiAiModels, type DshSeams } from './provider.js'
export {
  ANONYMOUS_API_KEY,
  KILO_API_BASE_URL,
  KILO_GATEWAY_BASE_URL,
  KILO_MODELS_URL,
  OPENCODE_ZEN_ANONYMOUS_API_KEY,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_GATEWAY_BASE_URL,
  OPENCODE_ZEN_MODELS_URL,
  ZEN_BASE_URL,
  ModelCatalog,
  ZenModelCatalog,
  fetchKiloModelCatalog,
  fetchKiloModels,
  fetchZenCatalogAtUrl,
  fetchZenModelCatalog,
  fetchZenModels,
  normalizeZenGatewayUrl,
  normalizeZenModelsUrl,
  isFreeModel,
  isZenFreeModel,
  staticFreeModels,
  zenStaticFreeCandidates,
  zenStaticFreeModels,
  defaultCachePath,
  defaultZenCachePath,
  type KiloModel,
  type KiloModelInfo,
  type CatalogOptions,
  type CatalogFetcher,
  type CatalogSnapshot,
  type FetchKiloModelsOptions,
  type FetchZenModelsOptions,
} from './adapter/catalog.ts'
export { KiloAdapter, createKiloAdapter, PROVIDER_ID, type KiloAdapterOptions, type CatalogLike } from './adapter/kilo-adapter.ts'
export {
  ZenAdapter,
  OpenCodeZenAdapter,
  createZenAdapter,
  ZEN_PROVIDER_ID,
  ZEN_RESPONSES_MODEL_IDS,
  zenModelApi,
  type ZenAdapterOptions,
} from './adapter/zen-adapter.ts'
