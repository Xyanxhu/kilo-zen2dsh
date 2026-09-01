import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeKiloModels,
  decodeModelsDev,
  decide,
  fetchKiloModelCatalog,
  fetchKiloModels,
  fetchZenCatalogAtUrl,
  fetchZenModels,
  isFreeModel,
  isZenFreeModel,
  KILO_GATEWAY_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_GATEWAY_BASE_URL,
  OPENCODE_ZEN_ANONYMOUS_API_KEY,
  ModelCatalog,
  ZenModelCatalog,
  staticFreeModels,
  zenStaticFreeModels,
} from '../src/adapter/catalog.ts'

function price(input?: number, output?: number, deprecated = false, free?: boolean) {
  return { input, output, deprecated, ...(free === undefined ? {} : { free }) }
}

test('Kilo free detection prefers explicit flags and handles virtual/suffix routes', () => {
  assert.ok(isFreeModel('kilo-auto/free'))
  assert.ok(isFreeModel('openrouter/free'))
  assert.ok(isFreeModel('provider/model:free'))
  assert.ok(isFreeModel('provider-model-free'))
  assert.ok(isFreeModel({ id: 'paid-looking-free', isFree: true }))
  assert.ok(isFreeModel({ id: 'legacy-free', is_free: true }))
  assert.ok(isFreeModel({ id: 'string-true-free', isFree: 'true' }))
  assert.ok(!isFreeModel({ id: 'paid-free', isFree: false }))
  assert.ok(!isFreeModel({ id: 'string-false-free', isFree: 'false' }))
  assert.ok(!isFreeModel({ id: 'qwen3-max', isFree: false }))
  assert.equal(isFreeModel({ id: 'camel-wins:free', isFree: false, is_free: true }), false)
  assert.equal(isFreeModel('provider/free'), false)
})

test('Zen free detection accepts documented names but rejects paid records', () => {
  assert.ok(isZenFreeModel('big-pickle'))
  assert.ok(isZenFreeModel('mimo-v2.5-free'))
  assert.ok(isZenFreeModel('provider/model:free'))
  assert.ok(isZenFreeModel({ id: 'future-free', isFree: true }))
  assert.ok(!isZenFreeModel({ id: 'future-false-free', isFree: 'false' }))
  assert.ok(!isZenFreeModel({ id: 'looks-free', isFree: false }))
  assert.ok(!isZenFreeModel('claude-sonnet-4'))
  assert.ok(!isZenFreeModel({ id: 'big-pickle', deprecated: true }))
})

test('decodeKiloModels validates records and deduplicates IDs', () => {
  const models = decodeKiloModels({ data: [{ id: 'a' }, { id: 'a', name: 'duplicate' }, null, { name: 'missing-id' }] })
  assert.deepEqual(models.map((model) => model.id), ['a'])
  assert.equal(models[0]?.name, 'a')
  assert.deepEqual(decodeKiloModels({ data: [] }), [])
})

test('compatibility decoder accepts a Kilo response and preserves costs', () => {
  const prices = decodeModelsDev({
    data: [
      { id: 'kilo-auto/free', isFree: true, pricing: { prompt: 0, completion: 0 } },
      { id: 'not-free:free', isFree: false, pricing: { prompt: 0, completion: 0 } },
    ],
  })
  assert.deepEqual(prices.get('kilo-auto/free'), price(0, 0, false, true))
  assert.equal(decide('not-free:free', prices, true).allowed, false)
})

test('decide compatibility helper remains conservative while catalog is pending', () => {
  assert.deepEqual(decide('x-free', new Map(), false), { allowed: true, source: 'name_free_pending', known: false })
  assert.deepEqual(decide('paid', new Map(), false), { allowed: false, source: 'metadata_pending', known: false })
  assert.deepEqual(decide('free', new Map([['free', price(0, 0)]]), true), {
    allowed: true,
    source: 'metadata_free',
    known: true,
  })
  assert.deepEqual(decide('paid', new Map([['paid', price(1, 2)]]), true), {
    allowed: false,
    source: 'metadata_paid',
    known: true,
  })
})

function fakeFetch(routes: Record<string, unknown>, capture: { url?: string; init?: RequestInit } = {}) {
  return (async (url: string | URL, init?: RequestInit) => {
    capture.url = String(url)
    capture.init = init
    const key = String(url).replace(/\?.*$/, '')
    if (!(key in routes) && !('*' in routes)) return new Response('{}', { status: 404 })
    const body = routes[key] ?? routes['*']
    if (body instanceof Error) throw body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const kiloBody = {
  data: [
    { id: 'kilo-auto/free', name: 'Auto Free', isFree: true, supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
    { id: 'stepfun/step-3.7-flash:free', isFree: true, supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
    { id: 'paid-model', isFree: false, pricing: { prompt: 1, completion: 2 }, supported_parameters: ['tools'] },
  ],
}

test('fetchKiloModels uses /models and sends no Authorization by default', async () => {
  const capture: { url?: string; init?: RequestInit } = {}
  const ids = await fetchKiloModels(KILO_GATEWAY_BASE_URL, fakeFetch({ [`${KILO_GATEWAY_BASE_URL}/models`]: kiloBody }, capture))
  assert.deepEqual(ids, ['kilo-auto/free', 'stepfun/step-3.7-flash:free', 'paid-model'])
  assert.equal(capture.url, `${KILO_GATEWAY_BASE_URL}/models`)
  const headers = new Headers(capture.init?.headers)
  assert.equal(headers.get('authorization'), null)
  assert.equal(headers.get('user-agent'), 'kilo2dsh')
})

test('fetchKiloModelCatalog sends Authorization only for an explicit token', async () => {
  const capture: { url?: string; init?: RequestInit } = {}
  await fetchKiloModelCatalog(`${KILO_GATEWAY_BASE_URL}/models`, fakeFetch({ [`${KILO_GATEWAY_BASE_URL}/models`]: kiloBody }, capture), { apiKey: 'account-token' })
  assert.equal(new Headers(capture.init?.headers).get('authorization'), 'Bearer account-token')
})

test('fetchZenModels normalizes the /v1 endpoint and sends the public lane headers', async () => {
  const capture: { url?: string; init?: RequestInit } = {}
  const body = { data: [{ id: 'big-pickle' }, { id: 'paid-model' }] }
  const ids = await fetchZenModels(
    OPENCODE_ZEN_BASE_URL,
    fakeFetch({ [`${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`]: body }, capture),
  )
  assert.deepEqual(ids, ['big-pickle', 'paid-model'])
  assert.equal(capture.url, `${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`)
  const headers = new Headers(capture.init?.headers)
  assert.equal(headers.get('authorization'), `Bearer ${OPENCODE_ZEN_ANONYMOUS_API_KEY}`)
  assert.equal(headers.get('x-opencode-client'), 'cli')
  assert.match(headers.get('user-agent') ?? '', /^opencode\//)
})

test('fetchZenCatalogAtUrl preserves an explicitly empty anonymous key', async () => {
  const capture: { init?: RequestInit } = {}
  await fetchZenCatalogAtUrl(
    `${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`,
    fakeFetch({ [`${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`]: { data: [{ id: 'big-pickle' }] } }, capture),
    { anonymousKey: '' },
  )
  assert.equal(new Headers(capture.init?.headers).get('authorization'), null)
})

test('start() retries Kilo catalog discovery while the live list is unavailable', async () => {
  let calls = 0
  const flaky = (async () => {
    calls += 1
    if (calls <= 2) throw new Error('network not ready yet')
    return new Response(JSON.stringify(kiloBody), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl: flaky, startupRetryMs: 5, refreshSeconds: 3600 })
  try {
    await catalog.start()
    assert.equal(calls, 3)
    assert.equal(catalog.snapshot().status, 'ready')
    assert.equal(catalog.snapshot().total, 3)
  } finally {
    catalog.stop()
  }
})

test('ModelCatalog exposes only explicit free text/tool-capable Kilo models', async () => {
  const body = {
    data: [
      { id: 'free-tool', isFree: true, supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
      { id: 'suffix-free:free', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
      { id: 'snake-free', is_free: true, supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } },
      { id: 'paid', isFree: false, supported_parameters: ['tools'] },
      { id: 'free-without-tools', isFree: true, supported_parameters: ['reasoning'] },
      { id: 'free-image', isFree: true, supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } },
    ],
  }
  const catalog = new ModelCatalog({ fetchImpl: fakeFetch({ [`${KILO_GATEWAY_BASE_URL}/models`]: body }) })
  await catalog.refreshOnce()
  try {
    assert.deepEqual(catalog.list(), ['free-tool', 'snake-free', 'suffix-free:free'])
    assert.equal(catalog.decision('paid').allowed, false)
    assert.equal(catalog.decision('free-without-tools').source, 'catalog_tools_unsupported')
    assert.equal(catalog.decision('free-image').source, 'catalog_output_unsupported')
    assert.equal(catalog.snapshot().total, 6)
    assert.equal(catalog.snapshot().exposed, 3)
  } finally {
    catalog.stop()
  }
})

test('ModelCatalog falls back to static Kilo IDs while discovery is pending', async () => {
  const fail = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl: fail })
  await catalog.refreshOnce()
  assert.deepEqual(catalog.list(), staticFreeModels)
  assert.equal(catalog.decision(staticFreeModels[0]!).allowed, true)
  assert.equal(catalog.decision('unknown-model').allowed, false)
  assert.equal(catalog.snapshot().status, 'error')
  catalog.stop()
})

test('ModelCatalog restores a fresh Kilo cache when discovery is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kilo2dsh-cache-'))
  try {
    const cachePath = join(dir, 'kilo-models.json')
    const live = new ModelCatalog({ cachePath, fetchImpl: fakeFetch({ [`${KILO_GATEWAY_BASE_URL}/models`]: kiloBody }), now: () => 1_000 })
    await live.refreshOnce()
    live.stop()

    const unavailable = (async () => {
      throw new Error('offline')
    }) as typeof fetch
    const cached = new ModelCatalog({ cachePath, fetchImpl: unavailable, now: () => 1_000 + 60_000 })
    await cached.refreshOnce()
    assert.equal(cached.get('kilo-auto/free')?.isFree, true)
    assert.equal(cached.snapshot().status, 'ready')
    assert.match(cached.lastError, /offline/)
    cached.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ZenModelCatalog filters the live OpenCode directory independently of Kilo', async () => {
  const body = {
    data: [
      { id: 'big-pickle' },
      { id: 'mimo-v2.5-free' },
      { id: 'deepseek-v4-flash-free' },
      { id: 'paid-model' },
      { id: 'future-free', isFree: false },
    ],
  }
  const capture: { url?: string; init?: RequestInit } = {}
  const catalog = new ZenModelCatalog({
    fetchImpl: fakeFetch({ [`${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`]: body }, capture),
    refreshSeconds: 3600,
  })
  await catalog.refreshOnce()
  try {
    assert.equal(catalog.modelsUrl, `${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`)
    assert.deepEqual(catalog.list(), ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free'])
    assert.equal(catalog.decision('paid-model').allowed, false)
    assert.equal(catalog.decision('future-free').allowed, false)
    assert.equal(new Headers(capture.init?.headers).get('x-opencode-client'), 'cli')
    assert.equal(new Headers(capture.init?.headers).get('authorization'), 'Bearer public')
  } finally {
    catalog.stop()
  }
})

test('ZenModelCatalog falls back to its own static free list while offline', async () => {
  const fail = (async () => {
    throw new Error('Zen unavailable')
  }) as typeof fetch
  const catalog = new ZenModelCatalog({ fetchImpl: fail, startupRetryMs: 0 })
  await catalog.refreshOnce()
  assert.deepEqual(catalog.list(), zenStaticFreeModels)
  assert.equal(catalog.decision('big-pickle').allowed, true)
  assert.equal(catalog.decision('deepseek-v4-flash-free').allowed, true)
  assert.equal(catalog.snapshot().status, 'error')
  catalog.stop()
})
