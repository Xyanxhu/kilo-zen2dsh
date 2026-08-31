import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { PROVIDER_ID, KiloAdapter } from '../src/adapter/kilo-adapter.ts'

/**
 * The exact method surface dsh-llm touches on a registered adapter. A missing
 * member throws inside registerAdapter and silently drops the provider from
 * the model selector (regression: providerRetryPolicy, index.js:1208).
 */
test('KiloAdapter implements the full dsh-llm adapter surface', () => {
  const adapter = new KiloAdapter(new ModelCatalog())
  for (const method of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], 'function', `missing method: ${method}`)
  }
})

test('providerInfo preserves the route id and names the provider', () => {
  const adapter = new KiloAdapter(new ModelCatalog())
  assert.deepEqual(adapter.providerInfo('kilo2dsh'), { id: 'kilo2dsh', name: 'Kilo Gateway (free)' })
})

test('custom provider ids are honored by adapter registration', () => {
  const adapter = new KiloAdapter(new ModelCatalog(), { providerId: 'my-kilo' })
  assert.deepEqual(adapter.providerInfo('my-kilo'), { id: 'my-kilo', name: 'Kilo Gateway (free)' })
  assert.equal(adapter.resolveModel('my-kilo', 'kilo-auto/free').provider, 'my-kilo')
})

test('providerRetryPolicy defers to the host default', () => {
  const adapter = new KiloAdapter(new ModelCatalog())
  assert.equal(adapter.providerRetryPolicy('kilo2dsh'), undefined)
})

test('resolveModel declares text-only input and finite limits', () => {
  const adapter = new KiloAdapter(new ModelCatalog())
  const resolved = adapter.resolveModel('kilo2dsh', 'kilo-auto/free')
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.equal(resolved.context.contextWindow > 0, true)
  assert.equal(resolved.defaultMaxTokens > 0, true)
  assert.equal(resolved.provider, 'kilo2dsh')
  assert.equal(resolved.id, 'kilo-auto/free')
})

test('prepareCall returns the resolved model and a stream dispatcher', async () => {
  const adapter = new KiloAdapter(new ModelCatalog())
  const call = await adapter.prepareCall('kilo2dsh', 'kilo-auto/free')
  assert.equal(call.model.id, 'kilo-auto/free')
  assert.equal(typeof call.stream, 'function')
})

test('listModels mirrors the catalog without duplicates', () => {
  const adapter = new KiloAdapter({
    list: () => ['kilo-auto/free', 'kilo-auto/free', 'stepfun/step-3.7-flash:free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
  })
  const models = adapter.listModels('kilo2dsh')
  assert.deepEqual(models.map((m) => m.id), ['kilo-auto/free', 'stepfun/step-3.7-flash:free'])
})

test('keyless free stream uses the Kilo endpoint and omits Authorization', async () => {
  let seenPath = ''
  let seenHeaders: Record<string, string | string[] | undefined> = {}
  const server = createServer((req, res) => {
    seenPath = req.url ?? ''
    seenHeaders = req.headers
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const catalog = {
      list: () => ['kilo-auto/free'],
      decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
      get: () => ({ id: 'kilo-auto/free', isFree: true, supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } }),
    }
    const adapter = new KiloAdapter(catalog, { gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway` })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'kilo-auto/free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) chunks.push(chunk)
    assert.equal(seenPath, '/api/gateway/chat/completions')
    assert.equal(seenHeaders.authorization, undefined)
    assert.equal(seenHeaders['x-kilocode-editorname'], 'DSH/kilo2dsh')
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('explicit Kilo token is sent only when configured', async () => {
  let authorization: string | undefined
  const server = createServer((req, res) => {
    authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const catalog = {
      list: () => ['kilo-auto/free'],
      decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
      get: () => ({ id: 'kilo-auto/free', isFree: true, supported_parameters: ['tools'] }),
    }
    const adapter = new KiloAdapter(catalog, {
      gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway`,
      apiKey: 'kilo-token',
    })
    for await (const _chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'kilo-auto/free',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      // consume the stream
    }
    assert.equal(authorization, 'Bearer kilo-token')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
