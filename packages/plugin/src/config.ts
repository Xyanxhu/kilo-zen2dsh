import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { platform } from 'node:process'

import { ANONYMOUS_API_KEY, KILO_GATEWAY_BASE_URL } from './adapter/catalog.ts'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 */
export interface Kilo2dshConfig {
  /**
   * Integration mode. `adapter` (default) registers a DSH LlmAdapter that
   * streams directly from Kilo's keyless free lane — no child process. `sidecar`
   * (legacy, not bundled with the published package) spawns the Go agent
   * binary and registers an llm-pi-ai route to it; build the agent from
   * legacy/agent and pass agentPath.
   */
  mode?: 'adapter' | 'sidecar'
  /** Path to the agent binary (sidecar mode). Not bundled: build from legacy/agent. */
  agentPath?: string
  /** Extra CLI args forwarded to the agent (after --config). */
  agentArgs?: string[]
  /** Provider route name registered into llm-pi-ai settings. */
  providerId?: string
  /** Credential reference (env var name) holding the local agent token. */
  apiKeyEnv?: string
  /** Optional Kilo account/API token env var. Leave unset for anonymous free access. */
  upstreamApiKeyEnv?: string
  /** Kilo Gateway base URL, ending in `/api/gateway`. */
  gatewayBaseUrl?: string
  /** Anonymous credential accepted by the configured Kilo gateway. */
  anonymousKey?: string
  /** Hide models that explicitly do not advertise tool calling. */
  requireTools?: boolean
  /** Model list refresh interval in seconds (agent refresh_seconds matches). */
  refreshSeconds?: number
  /** Restart backoff: initial delay ms. */
  restartDelayMs?: number
  /** Restart backoff: max delay ms. */
  restartMaxDelayMs?: number
  /** Consecutive crash count that trips the circuit breaker. */
  maxConsecutiveCrashes?: number
  /** Enable the independent OpenCode Zen free provider alongside Kilo. */
  zenEnabled?: boolean
  /** DSH provider route name for OpenCode Zen. */
  zenProviderId?: string
  /** OpenCode Zen root URL, normally `https://opencode.ai/zen`. */
  zenBaseUrl?: string
  /** Optional Zen compatibility User-Agent; empty derives the current OpenCode format. */
  zenUserAgent?: string
  /** Explicit Zen account-token environment variable; empty keeps public lane. */
  zenApiKeyEnv?: string
  /** Zen's public free-lane placeholder, normally `public`. */
  zenAnonymousKey?: string
}

/** @deprecated Use Kilo2dshConfig. */
export type Opencode2dshConfig = Kilo2dshConfig

export const defaults = {
  providerId: 'kilo2dsh',
  apiKeyEnv: 'KILO2DSH_TOKEN',
  // Empty by default: the Kilo free lane must not accidentally inherit a
  // user's paid token from the environment. Set this explicitly to opt in.
  upstreamApiKeyEnv: '',
  gatewayBaseUrl: KILO_GATEWAY_BASE_URL,
  anonymousKey: ANONYMOUS_API_KEY,
  requireTools: true,
  refreshSeconds: 300,
  restartDelayMs: 1000,
  restartMaxDelayMs: 60000,
  maxConsecutiveCrashes: 5,
  zenEnabled: true,
  zenProviderId: 'opencode2dsh',
  zenBaseUrl: 'https://opencode.ai/zen',
  zenUserAgent: '',
  zenApiKeyEnv: '',
  zenAnonymousKey: 'public',
}

export type ResolvedConfig = Required<
  Pick<
    Kilo2dshConfig,
    | 'providerId'
    | 'apiKeyEnv'
    | 'upstreamApiKeyEnv'
    | 'gatewayBaseUrl'
    | 'anonymousKey'
    | 'requireTools'
    | 'refreshSeconds'
    | 'restartDelayMs'
    | 'restartMaxDelayMs'
    | 'maxConsecutiveCrashes'
    | 'zenEnabled'
    | 'zenProviderId'
    | 'zenBaseUrl'
    | 'zenUserAgent'
    | 'zenApiKeyEnv'
    | 'zenAnonymousKey'
  >
> & Kilo2dshConfig

export function resolveConfig(config: Kilo2dshConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}

/**
 * Everything the plugin persists next to the agent: the generated
 * agent-config.json (design.md section 8.3 template) and the local auth token.
 * The data directory also stores the Kilo model catalog cache and adapter
 * health snapshot.
 */
export interface AgentConfigPaths {
  dataDir: string
  configPath: string
  tokenPath: string
}

export function configPaths(dataDir: string): AgentConfigPaths {
  return {
    dataDir,
    configPath: join(dataDir, 'agent-config.json'),
    tokenPath: join(dataDir, 'agent-token.txt'),
  }
}

/** 32-byte random token, base64url (design.md section 7). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the persisted token or generate and persist a fresh one.
 * Best-effort 0600 on POSIX; Windows profile dirs are user-scoped already.
 */
export async function ensureToken(paths: AgentConfigPaths): Promise<string> {
  if (await fileExists(paths.tokenPath)) {
    const existing = (await readFile(paths.tokenPath, 'utf8')).trim()
    if (existing.length > 0) return existing
  }
  const token = generateToken()
  await mkdir(dirname(paths.tokenPath), { recursive: true })
  await writeFile(paths.tokenPath, token + '\n', { encoding: 'utf8' })
  if (platform !== 'win32') {
    await chmod(paths.tokenPath, 0o600).catch(() => {})
  }
  return token
}

/**
 * Write agent-config.json atomically (tmp + rename) every plugin start, so a
 * version upgrade or option change reaches the next agent spawn. The agent
 * accepts JSON with comments; we emit plain JSON.
 */
export async function writeAgentConfig(
  paths: AgentConfigPaths,
  options: { token: string; refreshSeconds: number; gatewayBaseUrl?: string; anonymousKey?: string },
): Promise<void> {
  // design.md section 8.3 template; listen 127.0.0.1:0 => random port,
  // discovered via the READY line (--print-ready).
  const config = {
    listen: '127.0.0.1:0',
    server_keys: [options.token],
    anonymous: true,
    kilo_keys: [],
    go_keys: [],
    upstream: { kilo: options.gatewayBaseUrl ?? KILO_GATEWAY_BASE_URL },
    anonymous_key: options.anonymousKey ?? ANONYMOUS_API_KEY,
    models: { refresh_seconds: options.refreshSeconds },
    retry: { max_attempts: 2, timeout_seconds: 300 },
    proxies: ['direct'],
    logging: { level: 'info' },
  }
  await mkdir(paths.dataDir, { recursive: true })
  const tmpPath = paths.configPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf8')
  await rm(paths.configPath, { force: true })
  await rename(tmpPath, paths.configPath)
  if (platform !== 'win32') await chmod(paths.configPath, 0o600).catch(() => {})
}
