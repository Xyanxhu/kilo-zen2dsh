import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { KILO_GATEWAY_MAX_OUTPUT_TOKENS } from '../src/adapter/catalog.ts'
import { outputCeilingForWindow } from '../src/adapter/budget.ts'
import { clampMaxTokens, PROVIDER_ID, KiloAdapter } from '../src/adapter/kilo-adapter.ts'

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

test('clampMaxTokens protects explicit DSH defaults from oversized values', () => {
  assert.equal(clampMaxTokens(undefined, 524_288), undefined)
  assert.equal(clampMaxTokens(128_000, 524_288), 128_000)
  assert.equal(clampMaxTokens(943_718, 524_288), 524_288)
  assert.equal(clampMaxTokens('943718', 524_288), 524_288)
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

test('listModels and resolveModel carry the catalog description and real modalities', () => {
  const adapter = new KiloAdapter({
    list: () => ['vl-free', 'plain-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    get: (id) =>
      id === 'vl-free'
        ? {
            id,
            name: 'VL Free',
            description: 'Multimodal free model',
            isFree: true,
            architecture: { input_modalities: ['text', 'image', 'video'] },
            supported_parameters: ['tools'],
          }
        : { id, name: 'Plain Free', isFree: true, supported_parameters: ['tools'] },
  })
  const listed = adapter.listModels('kilo2dsh')
  const vl = listed.find((model) => model.id === 'vl-free')
  assert.equal(vl?.description, 'Multimodal free model')
  assert.deepEqual(vl?.inputModalities, ['text', 'image'])
  const plain = listed.find((model) => model.id === 'plain-free')
  assert.equal(plain?.description, undefined)
  assert.deepEqual(plain?.inputModalities, ['text'])

  const resolved = adapter.resolveModel('kilo2dsh', 'vl-free')
  assert.equal(resolved.description, 'Multimodal free model')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  assert.equal(adapter.resolveModel('kilo2dsh', 'plain-free').description, undefined)
  // Neither record advertises a reasoning control, so no levels are offered and
  // dsh-llm rejects any explicit effort selection for them.
  assert.equal(resolved.reasoning, undefined)
  assert.equal(adapter.resolveModel('kilo2dsh', 'plain-free').reasoning, undefined)
})

test('resolveModel declares thinking levels for reasoning-capable models', () => {
  // Regression: the adapter published no reasoning metadata, so the harness had
  // no levels to offer and no selector appeared for kilo2dsh models at all.
  const adapter = new KiloAdapter({
    list: () => ['reasoning-free', 'plain-free', 'reported-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    get: (id) => {
      if (id === 'reasoning-free') {
        return { id, name: 'Reasoning Free', isFree: true, supported_parameters: ['max_tokens', 'tools', 'reasoning', 'include_reasoning'] }
      }
      if (id === 'reported-free') {
        return { id, name: 'Reported Free', isFree: true, supported_parameters: ['reasoning_effort'] }
      }
      return { id, name: 'Plain Free', isFree: true, supported_parameters: ['tools'] }
    },
  })

  for (const id of ['reasoning-free', 'reported-free']) {
    const reasoning = adapter.resolveModel('kilo2dsh', id).reasoning
    assert.ok(reasoning, `${id} should offer reasoning levels`)
    assert.deepEqual(
      reasoning.efforts.map((effort) => effort.id),
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    )
    // Every level carries a user-facing label.
    for (const effort of reasoning.efforts) assert.ok(effort.name.length > 0)
    // No pinned default: the provider's own default measured the strongest tier
    // (499 reasoning tokens, equal to xhigh/max), so the adapter leaves it alone
    // and the selector shows "provider default" until a level is chosen.
    assert.equal(reasoning.defaultEffort, undefined)
  }
  assert.equal(adapter.resolveModel('kilo2dsh', 'plain-free').reasoning, undefined)
  // An unknown model falls back to a metadata-less record and offers no levels.
  assert.equal(adapter.resolveModel('kilo2dsh', 'not-in-catalog').reasoning, undefined)
})

test('reasoning levels reach the wire and an omitted effort no longer disables thinking', async () => {
  // Regression: with no effort selected pi-ai's openrouter format emitted
  // `{"reasoning":{"effort":"none"}}`, so every kilo2dsh request turned thinking
  // off. An omitted effort must send nothing and leave the provider default.
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        [
          `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}`,
          '',
          `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const model = 'reasoning-free'
    const adapter = new KiloAdapter(
      {
        list: () => [model],
        decision: () => ({ allowed: true, source: 'test', known: true }),
        get: () => ({ id: model, isFree: true, context_length: 262_144, supported_parameters: ['tools', 'reasoning', 'include_reasoning'] }),
      },
      { gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway` },
    )
    const send = async (reasoningEffort?: string) => {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER_ID,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 4_096,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })) {
        // consume the stream
      }
      return bodies.at(-1) ?? {}
    }

    // No selection: no reasoning field, so the gateway keeps its own default.
    assert.equal('reasoning' in (await send()), false)
    // Declared levels pass through as the OpenRouter-style effort object.
    assert.deepEqual((await send('medium')).reasoning, { effort: 'medium' })
    assert.deepEqual((await send('high')).reasoning, { effort: 'high' })
    assert.deepEqual((await send('minimal')).reasoning, { effort: 'minimal' })
    // The high tiers are declared and mapped, so pi-ai forwards them instead of
    // clamping them down to `high` (measured: xhigh/max are the strongest tiers
    // the gateway offers for these models).
    assert.deepEqual((await send('xhigh')).reasoning, { effort: 'xhigh' })
    assert.deepEqual((await send('max')).reasoning, { effort: 'max' })
    // An id outside pi-ai's vocabulary is dropped by the adapter's own gate, so
    // the request falls back to the provider default instead of sending junk.
    assert.equal('reasoning' in (await send('ultra')), false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
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

test('oversized catalog/request output limits are capped before the Kilo wire call', async () => {
  let requestBody = ''
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ id: 'c-cap', choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\ndata: ${JSON.stringify({ id: 'c-cap', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const model = 'minimax/minimax-m3:free'
    const catalog = {
      list: () => [model],
      decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
      get: () => ({
        id: model,
        isFree: true,
        context_length: 1_048_576,
        top_provider: { context_length: 1_048_576, max_completion_tokens: 943_718 },
        supported_parameters: ['max_tokens', 'tools'],
      }),
    }
    const adapter = new KiloAdapter(catalog, { gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway` })
    const resolved = adapter.resolveModel(PROVIDER_ID, model)
    assert.equal(resolved.defaultMaxTokens, outputCeilingForWindow(1_048_576))
    assert.ok(resolved.defaultMaxTokens < KILO_GATEWAY_MAX_OUTPUT_TOKENS)
    for await (const _chunk of adapter.stream({
      provider: PROVIDER_ID,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      // Simulate the DSH runtime materializing an over-sized default.
      maxTokens: 943_718,
    })) {
      // consume the stream
    }
    const body = JSON.parse(requestBody) as { max_tokens?: number; max_completion_tokens?: number }
    assert.equal(body.max_tokens, outputCeilingForWindow(1_048_576))
    assert.equal(body.max_completion_tokens, undefined)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

/**
 * Regression: the reported failure. `qwen/qwen3.8-27b:free` advertises
 * max_completion_tokens = 235929 on a 262144 window, so DSH asked for an answer
 * as large as the remaining window and the gateway answered
 * "requested about 262507 tokens ... maximum context length is 262144" (400).
 * The wire budget must leave the prompt its room.
 */
test('a directory cap that fills the window cannot overflow the request', async () => {
  let requestBody = ''
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ id: 'q1', choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\ndata: ${JSON.stringify({ id: 'q1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const model = 'qwen/qwen3.8-27b:free'
    const catalog = {
      list: () => [model],
      decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
      get: () => ({
        id: model,
        isFree: true,
        context_length: 262_144,
        top_provider: { context_length: 262_144, max_completion_tokens: 235_929 },
        supported_parameters: ['max_tokens', 'tools'],
      }),
    }
    const adapter = new KiloAdapter(catalog, { gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway` })
    const resolved = adapter.resolveModel(PROVIDER_ID, model)
    assert.equal(resolved.defaultMaxTokens, 65_536)
    assert.equal(resolved.context.contextWindow, 262_144)

    // A ~45K-token prompt, like the reported session (34816 text + 7524 tool).
    const contextWindow = resolved.context.contextWindow
    const prompt = 'x'.repeat(135_000)
    for await (const _chunk of adapter.stream({
      provider: PROVIDER_ID,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: resolved.defaultMaxTokens,
    })) {
      // consume the stream
    }
    const body = JSON.parse(requestBody) as { max_tokens?: number }
    // The declared cap already leaves room, so a mid-sized prompt keeps it.
    assert.equal(body.max_tokens, 65_536)

    // A prompt that eats the window shrinks the answer instead of overflowing.
    requestBody = ''
    const huge = 'x'.repeat(900_000)
    for await (const _chunk of adapter.stream({
      provider: PROVIDER_ID,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: huge }] }],
      maxTokens: resolved.defaultMaxTokens,
    })) {
      // consume the stream
    }
    const tight = JSON.parse(requestBody) as { max_tokens?: number }
    assert.ok(tight.max_tokens !== undefined)
    assert.ok(tight.max_tokens! < 65_536, `wire budget should shrink below the declared cap, got ${tight.max_tokens}`)
    // Prompt estimate + answer budget must stay inside the window.
    assert.ok(tight.max_tokens! + Math.ceil(huge.length / 4.3) < contextWindow)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('a prompt that leaves no room reports context overflow without a request', async () => {
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const model = 'small-window:free'
    const catalog = {
      list: () => [model],
      decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
      get: () => ({ id: model, isFree: true, context_length: 8_192, max_completion_tokens: 8_192 }),
    }
    const adapter = new KiloAdapter(catalog, { gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway` })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }],
      maxTokens: adapter.resolveModel(PROVIDER_ID, model).defaultMaxTokens,
    })) {
      chunks.push(chunk)
    }
    const finish = chunks.at(-1)
    assert.equal(finish?.type, 'finish')
    assert.equal(finish?.type === 'finish' ? finish.reason.kind : undefined, 'error')
    const failure = finish?.type === 'finish' && finish.reason.kind === 'error' ? finish.reason.failure : undefined
    // dsh-llm routes this code into context-overflow compaction.
    assert.equal(failure?.code, 'CONTEXT_WINDOW_EXCEEDED')
    assert.match(failure?.message ?? '', /maximum context length of 8192 tokens/)
    assert.equal(requests, 0)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('gateway usage reports calibrate the prompt estimate for later requests', async () => {
  // Regression: on a prose-heavy 248K-token session the raw estimate read
  // 286K (+15%), which left a negative budget and produced a false context
  // overflow. The gateway's own prompt_tokens must fold back into the estimate.
  // Dense JSON is the case that matters here: pi-ai already clamps prose with
  // its own ~4-chars-per-token rule, but it reads JSON/code optimistically, so
  // the adapter's own budget is what binds.
  const bodies: Array<{ max_tokens?: number }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      bodies.push(JSON.parse(raw) as { max_tokens?: number })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        [
          `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}`,
          '',
          // The endpoint reports a prompt far smaller than the raw estimate.
          `data: ${JSON.stringify({ id: 'c1', choices: [], usage: { prompt_tokens: 130_000, completion_tokens: 1 } })}`,
          '',
          `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const model = 'tight-window:free'
    const catalog = {
      list: () => [model],
      decision: () => ({ allowed: true, source: 'catalog_free', known: true }),
      get: () => ({ id: model, isFree: true, context_length: 262_144, top_provider: { context_length: 262_144, max_completion_tokens: 65_536 } }),
    }
    const adapter = new KiloAdapter(catalog, { gatewayBaseUrl: `http://127.0.0.1:${address.port}/api/gateway` })
    const prompt = '{"a":1}'.repeat(71_429)
    const send = async () => {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER_ID,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: adapter.resolveModel(PROVIDER_ID, model).defaultMaxTokens,
      })) {
        // consume the stream
      }
    }

    await send()
    // Uncalibrated: the dense prompt eats most of the window.
    const first = bodies[0]?.max_tokens
    assert.ok(first !== undefined)
    assert.ok(first < 50_000, `expected a clamped first budget, got ${first}`)

    await send()
    // The reported 130K prompt restores the declared cap on the next request.
    assert.equal(bodies[1]?.max_tokens, 65_536)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
