import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  canonicalZenSessionId,
  conversationSeed,
  deriveRequestIDs,
  kiloHeaders,
  kiloUserAgent,
  opencodeHeaders,
  opencodeUserAgent,
  randomID,
  stableID,
} from '../src/adapter/ids.ts'

test('stableID is deterministic and sha256-truncated', () => {
  const first = stableID('ses', 'hello')
  const second = stableID('ses', 'hello')
  assert.equal(first, second)
  assert.ok(first.startsWith('ses_'))
  const hex = first.slice('ses_'.length)
  assert.equal(hex.length, 24, '12 bytes hex')
  const expected = createHash('sha256').update('ses\x00hello').digest().subarray(0, 12).toString('hex')
  assert.equal(hex, expected)
  assert.notEqual(stableID('ses', 'world'), first)
  assert.notEqual(stableID('prj', 'hello'), first, 'prefix is part of the hash input')
})

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('conversationSeed uses the first user turn and skips non-user messages', () => {
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: { text: 'first question' } },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify({ text: 'first question' }))
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '', 'null content is skipped')
})

test('deriveRequestIDs keeps the session stable across turns and randomizes requests', () => {
  const turnOne = [{ role: 'user', content: 'hello' }]
  const turnTwo = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]
  const first = deriveRequestIDs(turnOne)
  const second = deriveRequestIDs(turnTwo)
  assert.equal(first.session, second.session)
  assert.notEqual(first.request, second.request)
  assert.equal(first.project, second.project)
  assert.ok(first.project.startsWith('prj_'))
  assert.equal(first.parentSession, '')
  // fallback: no user content at all still yields usable ids
  const empty = deriveRequestIDs([{ role: 'system', content: 'only system' }])
  assert.ok(empty.session.startsWith('ses_'))
  assert.notEqual(empty.session, deriveRequestIDs([{ role: 'system', content: 'only system' }]).session)
})

test('kiloHeaders carries Kilo correlation headers without CLI spoofing', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const headers = kiloHeaders(ids)
  assert.equal(headers['user-agent'], kiloUserAgent())
  assert.equal(headers['x-kilocode-editorname'], 'DSH/kilo2dsh')
  assert.equal(headers['x-kilocode-taskid'], ids.request)
  assert.equal(headers['x-kilocode-projectid'], ids.project)
  assert.equal(headers['x-opencode-client'], undefined)
  assert.ok(headers['user-agent'].startsWith('kilo2dsh'))
})

test('opencodeHeaders carries Zen compatibility identifiers independently', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }], 'opencode2dsh:default-project')
  const headers = opencodeHeaders(ids)
  assert.equal(headers['user-agent'], opencodeUserAgent())
  assert.equal(headers['x-opencode-client'], 'cli')
  // The free tier validates the canonical ses_ shape and the client's
  // descending time-part encoding (12 hex + 14 Base62, low word ~0xfff).
  assert.match(String(headers['x-opencode-session']), /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/)
  assert.equal(headers['x-opencode-session-id'], headers['x-opencode-session'])
  assert.equal(headers['x-session-affinity'], headers['x-opencode-session'])
  assert.equal(headers['X-Session-Id'], headers['x-opencode-session'])
  // The 2026-10-14 gate rejects the gateway's x-opencode-request header and
  // the prj_* project shape; the project goes out as a bare 40-char hex id.
  assert.equal(headers['x-opencode-request'], undefined)
  assert.match(String(headers['x-opencode-project']), /^[0-9a-f]{40}$/)
  assert.notEqual(headers['x-opencode-project'], ids.project)
  assert.equal(headers['x-kilocode-editorname'], undefined)
  assert.equal(headers['x-parent-session-id'], undefined, 'no parent headers without a parent session')
})

test('opencodeUserAgent mirrors the official client channel wire format', () => {
  const agent = opencodeUserAgent()
  // opencode/latest/2.0.30/cli
  assert.match(agent, /^opencode\/[a-z]+\/\d+\.\d+\.\d+\/cli$/)
  assert.ok(!agent.includes('ai-sdk'), 'the 1.x compound ai-sdk suffix is rejected by the Oct 14 gate')
  assert.ok(!agent.includes('node'), 'never advertise the local Node runtime')
})

test('opencodeHeaders mirrors a parent session in both spellings', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }], 'opencode2dsh:default-project')
  ids.parentSession = 'parent-session-seed'
  const headers = opencodeHeaders(ids)
  const parent = headers['x-opencode-parent-session-id']
  assert.match(String(parent), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(headers['x-parent-session-id'], parent)
  assert.notEqual(parent, headers['x-opencode-session'])
})

test('canonicalZenSessionId is canonical, deterministic, and preserves session affinity', () => {
  const fromSeed = canonicalZenSessionId('some-stable-session-seed')
  // The free tier requires the client's descending time-part encoding since
  // 2026-10-14: a hash-shaped (legacy) time part is rejected with 403.
  assert.match(fromSeed, /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/)
  assert.equal(canonicalZenSessionId('some-stable-session-seed'), fromSeed, 'same seed maps to one session')
  assert.notEqual(canonicalZenSessionId('another-seed'), fromSeed)
  // An already-canonical client session passes through untouched.
  const canonical = canonicalZenSessionId(fromSeed)
  assert.equal(canonical, fromSeed)
  // A canonical-looking but foreign-encoded session (legacy hash time part)
  // is re-encoded deterministically into the descending layout.
  const foreign = 'ses_0123456789abABCDEFGHIJKLMNOP'
  const reencoded = canonicalZenSessionId(foreign)
  assert.notEqual(reencoded, foreign)
  assert.match(reencoded, /^ses_[0-9a-f]{9}f[c-f][0-9a-f][0-9A-Za-z]{14}$/)
  assert.equal(canonicalZenSessionId(foreign), reencoded)
})
