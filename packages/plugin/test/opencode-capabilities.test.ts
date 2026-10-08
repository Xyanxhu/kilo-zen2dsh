import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enrichZenModels,
  fetchOpenCodeCapabilities,
  OPENCODE_CAPABILITIES_URL,
  parseOpenCodeCapabilities,
  type CapabilityTargetModel,
} from '../src/adapter/opencode-capabilities.ts'
import { modelInfo, OPENCODE_ZEN_GATEWAY_BASE_URL, ZenModelCatalog } from '../src/adapter/catalog.ts'

const capabilityBody = {
  'some-vendor': {
    id: 'some-vendor',
    api: 'https://vendor.example/v1',
    models: { 'vendor-model': { id: 'vendor-model', reasoning: true } },
  },
  opencode: {
    id: 'opencode',
    api: 'https://opencode.ai/zen/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'step-5-preview-free': {
        id: 'step-5-preview-free',
        name: 'Step 5 Preview Free',
        description: 'Free preview reasoning model with a 1M window',
        reasoning: true,
        tool_call: true,
        attachment: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 1_000_000, input: 1_000_000, output: 65_536 },
      },
      'mimo-v2.6-flash-free': {
        id: 'mimo-v2.6-flash-free',
        name: 'MiMo V2.6 Flash Free',
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 262_144, output: 32_768 },
      },
      'no-tools-flag': {
        id: 'no-tools-flag',
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128_000 },
      },
      'bad-limit': {
        id: 'bad-limit',
        tool_call: true,
        limit: { context: 'not-a-number', output: -5 },
        modalities: 'nope',
      },
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    api: 'https://opencode.ai/zen/go/v1',
    models: { 'go-only-free': { id: 'go-only-free', tool_call: true, limit: { context: 4096 } } },
  },
}

test('parseOpenCodeCapabilities keeps only the Zen provider and normalizes records', () => {
  const capabilities = parseOpenCodeCapabilities(capabilityBody)
  assert.deepEqual(
    [...capabilities.keys()].sort(),
    ['bad-limit', 'mimo-v2.6-flash-free', 'no-tools-flag', 'step-5-preview-free'],
  )
  const step = capabilities.get('step-5-preview-free')
  assert.ok(step)
  // The context/input pair collapses to the smaller value.
  assert.equal(step.context, 1_000_000)
  assert.equal(step.output, 65_536)
  assert.equal(step.reasoning, true)
  assert.equal(step.toolCall, true)
  assert.deepEqual(step.inputModalities, ['text', 'image', 'video'])
  assert.equal(step.description, 'Free preview reasoning model with a 1M window')
  // Invalid limits are dropped rather than clamped.
  const bad = capabilities.get('bad-limit')
  assert.ok(bad)
  assert.equal(bad.context, undefined)
  assert.equal(bad.output, undefined)
  assert.deepEqual(bad.inputModalities, [])
})

test('parseOpenCodeCapabilities tolerates malformed documents', () => {
  assert.equal(parseOpenCodeCapabilities(null).size, 0)
  assert.equal(parseOpenCodeCapabilities([1, 2, 3]).size, 0)
  assert.equal(parseOpenCodeCapabilities({ opencode: { api: 'https://opencode.ai/zen/v1', models: 'oops' } }).size, 0)
  assert.equal(
    parseOpenCodeCapabilities({ opencode: { api: 'https://opencode.ai/zen/v1', models: { broken: null } } }).size,
    0,
  )
})

test('enrichZenModels fills the gaps Zen models directory leaves open', () => {
  const capabilities = parseOpenCodeCapabilities(capabilityBody)
  const models: CapabilityTargetModel[] = [{ id: 'step-5-preview-free' }, { id: 'mimo-v2.6-flash-free' }]
  const enriched = enrichZenModels(models, capabilities)
  const step = enriched[0]!
  assert.equal(step.context_length, 1_000_000)
  assert.equal(step.max_output_tokens, 65_536)
  assert.deepEqual(step.architecture?.input_modalities, ['text', 'image', 'video'])
  assert.deepEqual(step.supported_parameters, ['tools', 'reasoning'])
  assert.equal(step.name, 'Step 5 Preview Free')
  assert.equal(step.description, 'Free preview reasoning model with a 1M window')
  const mimo = enriched[1]!
  assert.deepEqual(mimo.supported_parameters, ['tools'])
  // No reasoning flag means no reasoning parameter, not a false claim.
  assert.ok(!mimo.supported_parameters?.includes('reasoning'))
})

test('enrichZenModels never overrides what the directory already declares', () => {
  const capabilities = parseOpenCodeCapabilities(capabilityBody)
  const models: CapabilityTargetModel[] = [
    {
      id: 'step-5-preview-free',
      context_length: 131_072,
      max_tokens: 8_192,
      name: 'Directory Name',
      description: 'Directory description',
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text'] },
    },
  ]
  const [first] = enrichZenModels(models, capabilities)
  const enriched = first!
  assert.equal(enriched.context_length, 131_072)
  assert.equal(enriched.max_tokens, 8_192)
  assert.equal(enriched.name, 'Directory Name')
  assert.equal(enriched.description, 'Directory description')
  assert.deepEqual(enriched.supported_parameters, ['tools'])
  assert.deepEqual(enriched.architecture?.input_modalities, ['text'])
  assert.equal(enriched.max_output_tokens, undefined, 'no second output spelling is added')
})

test('enrichZenModels leaves unknown models and empty capability maps untouched', () => {
  const capabilities = parseOpenCodeCapabilities(capabilityBody)
  const unknown = [{ id: 'big-pickle' }, { id: 'go-only-free' }]
  assert.deepEqual(enrichZenModels(unknown, capabilities), unknown)
  assert.deepEqual(enrichZenModels(unknown, new Map()), unknown)
})

test('enrichZenModels does not hide a model that lacks the tools flag', () => {
  const capabilities = parseOpenCodeCapabilities(capabilityBody)
  const models: CapabilityTargetModel[] = [{ id: 'no-tools-flag' }]
  const [first] = enrichZenModels(models, capabilities)
  // A parameters list without `tools` would make supportsTools() false and
  // drop the model from the picker, so the list stays unset.
  assert.equal(first?.supported_parameters, undefined)
})

test('fetchOpenCodeCapabilities sends the identity headers and surfaces HTTP errors', async () => {
  const capture: { url?: string; init?: RequestInit } = {}
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    capture.url = String(url)
    capture.init = init
    return new Response(JSON.stringify(capabilityBody), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const capabilities = await fetchOpenCodeCapabilities(OPENCODE_CAPABILITIES_URL, fetchImpl, {
    userAgent: 'opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
  })
  assert.equal(capture.url, OPENCODE_CAPABILITIES_URL)
  assert.equal(new Headers(capture.init?.headers).get('user-agent'), 'opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14')
  assert.equal(capabilities.size, 4)

  const failing = (async () => new Response('nope', { status: 503 })) as typeof fetch
  await assert.rejects(fetchOpenCodeCapabilities(OPENCODE_CAPABILITIES_URL, failing), /HTTP 503/)
})

test('ZenModelCatalog enriches the bare Zen directory with real limits', async () => {
  const body = { data: [{ id: 'step-5-preview-free' }, { id: 'big-pickle' }] }
  const fetchImpl = (async (url: string | URL) => {
    if (String(url) === OPENCODE_CAPABILITIES_URL) {
      return new Response(JSON.stringify(capabilityBody), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ZenModelCatalog({ fetchImpl, refreshSeconds: 3600 })
  await catalog.refreshOnce()
  try {
    const step = catalog.get('step-5-preview-free')
    assert.ok(step, 'step-5-preview-free stays in the catalog')
    const info = modelInfo(step)
    assert.equal(info.contextWindow, 1_000_000)
    assert.equal(info.maxTokens, 65_536)
    assert.equal(info.reasoning, true)
    assert.deepEqual(info.inputModalities, ['text', 'image'])
    assert.equal(info.name, 'Step 5 Preview Free')
    // Unknown to the capability catalog: keeps the fallback limits.
    const pickle = modelInfo(catalog.get('big-pickle')!)
    assert.equal(pickle.contextWindow, 262_144)
  } finally {
    catalog.stop()
  }
})

test('ZenModelCatalog survives a capability catalog outage', async () => {
  const body = { data: [{ id: 'step-5-preview-free' }] }
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url))
    if (String(url) === OPENCODE_CAPABILITIES_URL) return new Response('down', { status: 503 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ZenModelCatalog({ fetchImpl, refreshSeconds: 3600 })
  await catalog.refreshOnce()
  try {
    assert.ok(catalog.get('step-5-preview-free'))
    assert.equal(modelInfo(catalog.get('step-5-preview-free')!).contextWindow, 262_144)
    assert.deepEqual(calls, [`${OPENCODE_ZEN_GATEWAY_BASE_URL}/models`, OPENCODE_CAPABILITIES_URL])
  } finally {
    catalog.stop()
  }
})
