import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { ZenAdapter, ZEN_PROVIDER_ID, zenModelApi } from '../src/adapter/zen-adapter.ts'

test('ZenAdapter keeps the OpenCode provider surface and defaults', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle'],
    decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
  })
  for (const method of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], 'function', `missing method: ${method}`)
  }
  assert.deepEqual(adapter.providerInfo(ZEN_PROVIDER_ID), { id: ZEN_PROVIDER_ID, name: 'OpenCode Zen (free)' })
  assert.equal(adapter.resolveModel(ZEN_PROVIDER_ID, 'big-pickle').provider, ZEN_PROVIDER_ID)
  assert.equal(zenModelApi({ id: 'muse-spark-1.2-contributor-free' }), 'openai-responses')
  assert.equal(zenModelApi({ id: 'big-pickle' }), 'openai-completions')
  assert.equal(zenModelApi({ id: 'future-model', api: 'chat', protocol: 'responses' }), 'openai-responses')
  assert.equal(zenModelApi({ id: 'future-model', opencode: { endpoint: '/responses' } }), 'openai-responses')
})

test('ZenAdapter streams through /zen/v1 with public auth and compatibility headers', async () => {
  let seenPath = ''
  let seenHeaders: Record<string, string | string[] | undefined> = {}
  const server = createServer((req, res) => {
    seenPath = req.url ?? ''
    seenHeaders = req.headers
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      `data: ${JSON.stringify({ id: 'z1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'z1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const adapter = new ZenAdapter(
      {
        list: () => ['big-pickle'],
        decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
        get: () => ({ id: 'big-pickle', supported_parameters: ['tools'], architecture: { output_modalities: ['text'] } }),
      },
      { zenBaseUrl: `http://127.0.0.1:${address.port}/zen` },
    )
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: ZEN_PROVIDER_ID,
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) chunks.push(chunk)
    assert.equal(seenPath, '/zen/v1/chat/completions')
    assert.equal(seenHeaders.authorization, 'Bearer public')
    assert.equal(seenHeaders['x-opencode-client'], 'cli')
    assert.match(String(seenHeaders['user-agent']), /^opencode\//)
    assert.ok(seenHeaders['x-opencode-session'])
    assert.ok(seenHeaders['x-opencode-request'])
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('ZenAdapter accepts an explicit account token for the same free catalog', async () => {
  let authorization: string | undefined
  const server = createServer((req, res) => {
    authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'z2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const local = new ZenAdapter(
      { list: () => ['big-pickle'], decision: () => ({ allowed: true, source: 'catalog_free', known: true }) },
      { gatewayBaseUrl: `http://127.0.0.1:${address.port}/zen/v1`, apiKey: 'zen-token' },
    )
    for await (const _chunk of local.stream({
      provider: ZEN_PROVIDER_ID,
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      // consume the stream
    }
    assert.equal(authorization, 'Bearer zen-token')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('ZenAdapter routes Responses-only free models to /zen/v1/responses', async () => {
  let seenPath = ''
  const server = createServer((req, res) => {
    seenPath = req.url ?? ''
    const item = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    }
    const events = [
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const model = 'muse-spark-1.2-contributor-free'
    const adapter = new ZenAdapter(
      { list: () => [model], decision: () => ({ allowed: true, source: 'catalog_free', known: true }) },
      { zenBaseUrl: `http://127.0.0.1:${address.port}/zen` },
    )
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: ZEN_PROVIDER_ID,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) chunks.push(chunk)
    assert.equal(seenPath, '/zen/v1/responses')
    assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'))
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
