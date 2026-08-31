import { createHash, randomBytes } from 'node:crypto'

import { KILO_USER_AGENT } from './catalog.ts'

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
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: stableID('ses', signal),
    request: randomID('req', 16),
    project: stableID('prj', 'kilo2dsh:default-project'),
    parentSession: '',
  }
}

/** User-Agent identifies this integration; it does not impersonate Kilo CLI. */
export function kiloUserAgent(): string {
  const version = process.env.KILO2DSH_VERSION?.trim()
  return version ? `${KILO_USER_AGENT}/${version}` : KILO_USER_AGENT
}

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

/** Compatibility spelling retained for downstream users of opencode2dsh. */
export const opencodeUserAgent = kiloUserAgent
export const disguiseHeaders = kiloHeaders
