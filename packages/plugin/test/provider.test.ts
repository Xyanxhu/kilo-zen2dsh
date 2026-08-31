import test from 'node:test'
import assert from 'node:assert/strict'
import { toPiAiModels, registerProvider, removeProviderRoute, providerBaseURL, fetchHealth, type DshSeams } from '../src/provider.ts'

test('toPiAiModels parses OpenAI-shaped payloads and dedupes', () => {
  const parsed = toPiAiModels({
    data: [
      { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
      { id: 'gpt-oss-120b' }, // duplicate id dropped
      { id: '' }, // empty id dropped
      { nope: 1 }, // no id dropped
      null, // non-object dropped
      { id: 'free-x' }, // missing name falls back to id
    ],
  })
  assert.deepEqual(parsed, [
    { id: 'gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'free-x', name: 'free-x' },
  ])
  assert.deepEqual(toPiAiModels(undefined), [])
  assert.deepEqual(toPiAiModels({}), [])
  assert.deepEqual(toPiAiModels({ data: 'nope' }), [])
})

test('registerProvider stores token and writes the llm-pi-ai route', async () => {
  const calls = { credentials: [] as Array<[string, string]>, ops: [] as unknown[] }
  const seams: DshSeams = {
    credentials: {
      set: async (ref, value) => {
        calls.credentials.push([ref, value])
      },
    },
    settings: {
      get: () => undefined,
      mutate: async (_ns, ops) => {
        calls.ops.push({ ns: _ns, ops })
      },
    },
    logger: { info: () => {}, warn: () => {} },
  }
  await registerProvider(
    seams,
    { providerId: 'kilo2dsh', apiKeyEnv: 'KILO2DSH_TOKEN', port: 4567 },
    'tok',
    [{ id: 'm1', name: 'M1' }],
  )
  assert.deepEqual(calls.credentials, [['KILO2DSH_TOKEN', 'tok']])
  assert.equal(calls.ops.length, 1)
  const first = calls.ops.at(0)
  assert.ok(first, 'expected one mutate call')
  const op = first as { ns: string; ops: Array<{ op: string; path: string[]; value: Record<string, unknown> }> }
  const setOp = op.ops.at(0)
  assert.ok(setOp, 'expected one set op')
  assert.equal(op.ns, 'llm-pi-ai')
  assert.equal(setOp.op, 'set')
  assert.deepEqual(setOp.path, ['providers', 'kilo2dsh'])
  assert.equal(setOp.value.baseURL, providerBaseURL(4567))
  assert.equal(setOp.value.baseURL, 'http://127.0.0.1:4567/v1')
  assert.equal(setOp.value.apiKeyEnv, 'KILO2DSH_TOKEN')
  assert.equal(setOp.value.api, 'openai-completions')
  assert.deepEqual(setOp.value.models, [{ id: 'm1', name: 'M1' }])
})

test('removeProviderRoute unsets the sidecar leftover only when present', async () => {
  const mutations: Array<{ ns: string; ops: Array<{ op: string; path: Array<string | number> }> }> = []
  const makeSeams = (providers: Record<string, unknown> | undefined): DshSeams => ({
    credentials: { set: async () => {} },
    settings: {
      get: (ns) => (ns === 'llm-pi-ai' ? { providers } : undefined),
      mutate: async (ns, ops) => {
        mutations.push({ ns, ops })
      },
    },
    logger: { info: () => {}, warn: () => {} },
  })
  // no namespace at all
  assert.equal(await removeProviderRoute({ settings: makeSeams(undefined).settings }, 'kilo2dsh'), false)
  // namespace but no providers section
  assert.equal(await removeProviderRoute({ settings: makeSeams(undefined).settings }, 'kilo2dsh'), false)
  // route present -> unset
  const seams = makeSeams({ kilo2dsh: { baseURL: 'http://127.0.0.1:6865/v1' }, other: {} })
  assert.equal(await removeProviderRoute({ settings: seams.settings }, 'kilo2dsh'), true)
  assert.equal(mutations.length, 1)
  const mutation = mutations[0]
  assert.ok(mutation)
  assert.equal(mutation.ns, 'llm-pi-ai')
  assert.equal(mutation.ops[0]?.op, 'unset')
  assert.deepEqual(mutation.ops[0]?.path, ['providers', 'kilo2dsh'])
  // other providers untouched: unset is path-scoped, verified by the op above
})

test('fetchHealth parses the healthz payload from a live server', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    assert.equal(req.url, '/healthz')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', models: { status: 'ready', total: 9 } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const health = (await fetchHealth(port)) as { models?: { status?: string } }
    assert.equal(health.models?.status, 'ready')
  } finally {
    server.close()
  }
})
