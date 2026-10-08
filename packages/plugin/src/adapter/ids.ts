import { createHash, randomBytes } from 'node:crypto'

import { KILO_USER_AGENT } from './catalog.ts'
import { opencodeUserAgent } from './opencode-identity.ts'

/** Correlation identifiers used by Kilo's task/project headers. */
export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

/** sha256("prefix\0value") truncated to 12 bytes: stable and non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/** Derive stable per-conversation and per-request IDs without storing content. */
export function deriveRequestIDs(
  messages: Array<{ role: string; content: unknown }>,
  projectNamespace = 'kilo2dsh:default-project',
): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: stableID('ses', signal),
    request: randomID('req', 16),
    project: stableID('prj', projectNamespace),
    parentSession: '',
  }
}

/** User-Agent identifies this integration; it does not impersonate Kilo CLI. */
export function kiloUserAgent(): string {
  const version = process.env.KILO2DSH_VERSION?.trim()
  return version ? `${KILO_USER_AGENT}/${version}` : KILO_USER_AGENT
}

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Canonical OpenCode session id: `ses_` + 12 lowercase hex + 14 Base62.
 * Zen's free tier validates this shape on `x-opencode-session` (anything else
 * is rejected with 403 FreeTierError). The id stays stable per conversation:
 * it is derived deterministically from the adapter's stable session seed
 * rather than rolled fresh per request, preserving session affinity.
 */
export function canonicalZenSessionId(seed: string): string {
  const value = seed.trim()
  if (/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value)) return value
  const digest = createHash('sha256').update(value).digest()
  let tail = ''
  for (const byte of digest.subarray(6, 20)) tail += BASE62_ALPHABET[byte % 62]
  return `ses_${digest.subarray(0, 6).toString('hex')}${tail}`
}

export { opencodeUserAgent } from './opencode-identity.ts'

export interface KiloHeaderOptions {
  userAgent?: string
  editorName?: string
  mode?: string
  organizationId?: string
  feature?: string
}

/** Build the documented KiloCode request headers. */
export function kiloHeaders(ids: RequestIDs, options: KiloHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? kiloUserAgent(),
    'content-type': 'application/json',
    'x-kilocode-editorname': options.editorName ?? 'DSH/kilo2dsh',
    'x-kilocode-taskid': ids.request,
    'x-kilocode-projectid': ids.project,
  }
  if (ids.parentSession) headers['x-kilocode-parent-taskid'] = ids.parentSession
  if (options.mode) headers['x-kilocode-mode'] = options.mode
  if (options.organizationId) headers['x-kilocode-organizationid'] = options.organizationId
  if (options.feature) headers['x-kilocode-feature'] = options.feature
  return headers
}

export interface OpenCodeHeaderOptions {
  userAgent?: string
  client?: string
}

/** Headers expected by the OpenCode Zen compatibility/free lane. */
export function opencodeHeaders(ids: RequestIDs, options: OpenCodeHeaderOptions = {}): Record<string, string> {
  // The free tier validates the canonical ses_ shape; non-canonical values
  // (older adapters, arbitrary session ids) would be rejected with 403.
  const session = canonicalZenSessionId(ids.session)
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? opencodeUserAgent(),
    'x-opencode-client': options.client ?? 'cli',
    'x-opencode-session': session,
    // CLI 1.18.34+ sends the namespaced session identity alongside the
    // legacy correlation pair; Zen forwards it to the new inference service.
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'X-Session-Id': session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
  if (ids.parentSession) {
    const parent = canonicalZenSessionId(ids.parentSession)
    headers['x-opencode-parent-session-id'] = parent
    headers['x-parent-session-id'] = parent
  }
  return headers
}

/** Compatibility spelling retained for downstream users of opencode2dsh. */
export const disguiseHeaders = opencodeHeaders
