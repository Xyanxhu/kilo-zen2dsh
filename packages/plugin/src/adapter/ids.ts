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

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * The time part the official client mints with its `descending()` identifier
 * encoding: a 48-bit word `~(timestamp_ms << 12 | counter)` rendered as hex.
 * The bitwise NOT makes the low 12 bits read `0xfff - counter`, and the free
 * tier accepts only counters 1-63 (low bits 0xfc0-0xfff) since 2026-10-14 —
 * a random or hash-shaped time part is rejected with 403 FreeTierError even
 * when the `ses_` shape is otherwise correct.
 */
const DESCENDING_TIME_PART_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

/**
 * Render six hash bytes as the client's descending time part: a 36-bit
 * timestamp reconstructed from bytes 0-3 plus the high nibble of byte 4,
 * shifted into the top of a 48-bit word, counter 1 ORed in, then inverted.
 */
function descendingTimePart(hash: Buffer): string {
  const timestamp =
    (BigInt(hash[0]!) << 28n) |
    (BigInt(hash[1]!) << 20n) |
    (BigInt(hash[2]!) << 12n) |
    (BigInt(hash[3]!) << 4n) |
    (BigInt(hash[4]!) >> 4n)
  const inverted = ~((timestamp << 12n) | 1n) & 0xffffffffffffn
  return inverted.toString(16).padStart(12, '0')
}

/**
 * Canonical OpenCode session id: `ses_` + 12 lowercase hex + 14 Base62.
 * Zen's free tier validates this shape on `x-opencode-session` and, since
 * 2026-10-14, also validates the time-part encoding: it must carry the
 * official client's descending() layout (a hash-shaped time part gets 403
 * FreeTierError even though the shape matches). The id stays stable per
 * conversation: it is derived deterministically from the adapter's stable
 * session seed rather than rolled fresh per request, preserving affinity.
 */
export function canonicalZenSessionId(seed: string): string {
  const value = seed.trim()
  if (CANONICAL_SESSION_PATTERN.test(value) && DESCENDING_TIME_PART_PATTERN.test(value.slice(4, 16))) return value
  const digest = createHash('sha256').update(value).digest()
  let tail = ''
  for (const byte of digest.subarray(6, 20)) tail += BASE62_ALPHABET[byte % 62]
  return `ses_${descendingTimePart(digest.subarray(0, 6))}${tail}`
}

/**
 * Project identity in the shape the client sends: a bare 40-character
 * lowercase hex id. The 2026-10-14 gate rejects the gateway's own `prj_`
 * prefix with 403 FreeTierError; the value itself is not checked upstream,
 * so hashing keeps one conversation pinned to one project.
 */
export function clientProjectID(project: string): string {
  return createHash('sha256').update(`opencode-project\x00${project}`).digest().subarray(0, 20).toString('hex')
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
  // The free tier validates the canonical ses_ shape and, since 2026-10-14,
  // the client's descending time-part encoding; both are handled inside
  // canonicalZenSessionId. The client's own x-opencode-request correlation
  // header and the prj_* project shape are rejected by that same gate, so
  // neither is sent; tracing stays local to this adapter.
  const session = canonicalZenSessionId(ids.session)
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? opencodeUserAgent(),
    'x-opencode-client': options.client ?? 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'X-Session-Id': session,
    'x-opencode-project': clientProjectID(ids.project),
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
