import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_OUTPUT_WINDOW_SHARE,
  MIN_ANSWER_TOKENS,
  blendCalibration,
  estimateRequestTokens,
  outputCeilingForWindow,
  overflowMessage,
  resolveWireBudget,
  wireSafetyTokens,
} from '../src/adapter/budget.ts'

test('outputCeilingForWindow keeps a quarter of the window for the prompt', () => {
  assert.equal(MAX_OUTPUT_WINDOW_SHARE, 0.25)
  assert.equal(outputCeilingForWindow(262_144), 65_536)
  assert.equal(outputCeilingForWindow(1_048_576), 262_144)
  assert.equal(outputCeilingForWindow(8_192), 2_048)
  // A degenerate window still yields a usable, positive budget.
  assert.equal(outputCeilingForWindow(3), 1)
  assert.equal(outputCeilingForWindow(0), 1)
  assert.equal(outputCeilingForWindow(Number.NaN), 1)
})

test('wireSafetyTokens holds back at least one kilobyte worth of tokens', () => {
  assert.equal(wireSafetyTokens(262_144), Math.ceil(262_144 * 0.02))
  assert.equal(wireSafetyTokens(1_000), 1_024)
})

/**
 * Real token counts for the samples below, measured with `cl100k_base`
 * (`tiktoken 0.12.0`). They are recorded constants on purpose: an earlier
 * version of these tests used the estimator's own constant as its ground truth,
 * so it could not fail no matter how wrong the estimator was.
 */
const MEASURED_SAMPLES: Array<{ name: string; text: string; real: number }> = [
  { name: 'prose', real: 481, text: 'the quick brown fox jumps over the lazy dog and reports back to the agent loop '.repeat(30) },
  {
    name: 'ts_source',
    real: 1092,
    text: (
      'export function resolveWireBudget(input: WireBudgetInput): WireBudget {\n' +
      '  const window = positiveInteger(input.contextWindow) ?? 1\n' +
      '  const cap = Math.max(1, Math.min(positiveInteger(input.modelMaxTokens) ?? 1, window))\n' +
      '  const room = window - effectiveInputTokens - wireSafetyTokens(window)\n' +
      '  return { maxTokens: Math.min(ceiling, room), effectiveInputTokens, overflow: false }\n' +
      '}\n'
    ).repeat(12),
  },
  {
    name: 'json',
    real: 850,
    text: '{"name":"read_file","arguments":{"path":"/home/huanx/code/kilo2dsh/packages/plugin/src/adapter/budget.ts","limit":2000}},'.repeat(25),
  },
  // Deterministic pseudo-random bytes, so the sample is reproducible in any
  // language: the same LCG produces the same base64/hex the counts were measured
  // on, and a drift in the sample fails the test instead of silently passing.
  { name: 'base64', real: 14_726, text: pseudoRandomBytes(15_360).toString('base64') },
  { name: 'hex', real: 6_823, text: pseudoRandomBytes(6_000).toString('hex') },
  { name: 'cjk', real: 1020, text: '这个适配器会在发送请求之前估算提示词大小，避免会话超出模型窗口。'.repeat(30) },
  { name: 'emoji', real: 1300, text: '🎉👨‍👩‍👧‍👦🚀🔥👍🏽🧑‍💻🌟💡🎯🛠️'.repeat(25) },
  {
    name: 'logs',
    real: 1679,
    text: Array.from({ length: 60 }, (_, index) => `2026-10-04T06:33:${String(index % 60).padStart(2, '0')}.123Z INFO job=abc${index} dur=${index}ms status=ok`).join(' '),
  },
  { name: 'html', real: 880, text: '<div class="row"><span data-testid="cell-42">value</span><!-- comment --></div>'.repeat(40) },
  {
    name: 'markdown',
    real: 810,
    text: '## Heading\n\n- item one with `code`\n- item two with a [link](https://example.com/x)\n\n> quote\n\n'.repeat(30),
  },
  {
    name: 'identifiers',
    real: 1404,
    text: Array.from({ length: 120 }, (_, index) => `id-${index}-${Array.from({ length: 16 }, (_, offset) => String.fromCharCode(97 + ((index * 7 + offset * 3) % 26))).join('')}`).join(' '),
  },
]

/** Same linear congruential generator the measured counts were produced with. */
function pseudoRandomBytes(count: number, seed = 12345): Buffer {
  const bytes = Buffer.alloc(count)
  let state = BigInt(seed)
  for (let index = 0; index < count; index += 1) {
    state = (state * 1103515245n + 12345n) % 2147483648n
    bytes[index] = Number((state >> 16n) & 0xffn)
  }
  return bytes
}

function estimateText(text: string): number {
  return estimateRequestTokens({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
}

test('the prompt estimate is never optimistic against measured tokenizer counts', () => {
  // Regression: charging every ASCII letter at 4.3 characters per token made the
  // estimate 2.6x too small for base64 (real density 1.39 chars/token), so a
  // 300 KB base64 tool result was estimated at 82K tokens, the adapter sent
  // max_tokens = 65536 for a 215K prompt, and the gateway answered 400 with the
  // very overflow this budget exists to prevent.
  for (const sample of MEASURED_SAMPLES) {
    const estimate = estimateText(sample.text)
    assert.ok(
      estimate >= sample.real,
      `${sample.name}: estimate ${estimate} is below the measured ${sample.real} tokens`,
    )
  }
})

test('the prompt estimate stays within the calibration range on every class', () => {
  // Being conservative is only useful while `blendCalibration` can correct it:
  // the floor is 0.5, so an over-estimate above 2x would survive calibration.
  for (const sample of MEASURED_SAMPLES) {
    const estimate = estimateText(sample.text)
    assert.ok(
      estimate <= sample.real * 2.1,
      `${sample.name}: estimate ${estimate} is more than 2.1x the measured ${sample.real} tokens`,
    )
  }
})

test('estimateRequestTokens costs the request envelope, images, and tool schemas', () => {
  // CJK costs about a token per character regardless of its 3 UTF-8 bytes.
  const cjk = estimateText('中'.repeat(3_000))
  assert.ok(cjk >= 3_000 && cjk < 3_600, `CJK estimate out of range: ${cjk}`)

  // Base64 image payloads must not look like a million-token prompt, and the
  // flat charge has to cover the pixels the adapter itself allows (1568px).
  const vision = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'image', data: 'A'.repeat(4_000_000) }] }],
  })
  assert.ok(vision >= 3_200 && vision < 5_000, `expected a flat image charge, got ${vision}`)

  // System prompts and tool schemas are counted too.
  const withTools = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'the quick brown fox jumps over the lazy dog '.repeat(20),
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
  })
  assert.ok(withTools > 200, `expected the system prompt to count, got ${withTools}`)

  // Unvalidated fields must not throw out of the streaming path.
  const malformed = estimateRequestTokens({
    messages: [
      { role: 'user', content: [{ type: 'text', text: undefined as unknown as string }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: undefined as unknown as string }] },
    ],
    system: undefined as unknown as string,
  })
  assert.ok(malformed > 0)
})

test('blendCalibration folds gateway counts in within its bounds', () => {
  // The first sample wins outright, clamped to the band.
  assert.equal(blendCalibration(undefined, 0.866), 0.866)
  assert.equal(blendCalibration(undefined, 1.4), 1.4)
  assert.equal(blendCalibration(undefined, 0.2), 0.5)
  assert.equal(blendCalibration(undefined, Number.NaN), 1)
  // An under-estimate must be correctable: a route whose real prompt is 2.6x the
  // estimate has to move above 1, which an earlier clamp at 1 made impossible.
  assert.equal(blendCalibration(undefined, 2.6), 2.6)
  assert.equal(blendCalibration(undefined, 99), 4)
  // Later samples move the factor by CALIBRATION_ALPHA only.
  const next = blendCalibration(0.8, 1)
  assert.ok(next > 0.8 && next < 1, `expected a bounded step, got ${next}`)
  assert.ok(blendCalibration(0.99, 0.5) > 0.5)
  assert.ok(blendCalibration(2, 1) < 2)
})

test('resolveWireBudget clamps the answer to the room the prompt leaves', () => {
  const contextWindow = 262_144
  const estimatedInputTokens = 45_000
  const budget = resolveWireBudget({
    requested: 235_929,
    modelMaxTokens: 65_536,
    contextWindow,
    estimatedInputTokens,
  })
  assert.equal(budget.overflow, false)
  assert.equal(budget.maxTokens, 65_536)
  assert.equal(budget.effectiveInputTokens, estimatedInputTokens)
  // Prompt + answer + safety stays inside the window.
  assert.ok(estimatedInputTokens + budget.maxTokens! + wireSafetyTokens(contextWindow) <= contextWindow)

  // A large prompt shrinks the answer below the declared cap.
  const tight = resolveWireBudget({
    requested: 65_536,
    modelMaxTokens: 65_536,
    contextWindow,
    estimatedInputTokens: 230_000,
  })
  assert.equal(tight.overflow, false)
  assert.equal(tight.maxTokens, contextWindow - 230_000 - wireSafetyTokens(contextWindow))

  // Missing or bogus requests fall back to the adapter's own cap.
  assert.equal(resolveWireBudget({ modelMaxTokens: 32_768, contextWindow, estimatedInputTokens: 0 }).maxTokens, 32_768)
  assert.equal(resolveWireBudget({ requested: 0, modelMaxTokens: 32_768, contextWindow, estimatedInputTokens: 0 }).maxTokens, 32_768)
  // The cap can never exceed the window itself.
  assert.equal(
    resolveWireBudget({ modelMaxTokens: 999_999, contextWindow: 4_096, estimatedInputTokens: 0 }).maxTokens,
    4_096 - wireSafetyTokens(4_096),
  )
})

test('calibration rescues a session whose raw estimate is pessimistic', () => {
  // The reported case: raw estimate 286,087 for a prompt the gateway counted at
  // 247,790 on a 262,144-token window. Uncalibrated the room goes negative and
  // the request is refused; calibrated, several thousand answer tokens fit.
  const contextWindow = 262_144
  const rawEstimate = 286_087
  const uncalibrated = resolveWireBudget({ modelMaxTokens: 65_536, contextWindow, estimatedInputTokens: rawEstimate })
  assert.equal(uncalibrated.overflow, true)

  const calibration = blendCalibration(undefined, 247_790 / rawEstimate)
  const calibrated = resolveWireBudget({
    modelMaxTokens: 65_536,
    contextWindow,
    estimatedInputTokens: rawEstimate,
    calibration,
  })
  assert.equal(calibrated.overflow, false)
  assert.ok(calibrated.maxTokens! >= 7_000, `expected a usable answer budget, got ${calibrated.maxTokens}`)
  // The budget must still leave the gateway's own count room to be wrong.
  assert.ok(247_790 + calibrated.maxTokens! <= contextWindow)
})

test('resolveWireBudget reports overflow instead of dispatching a doomed request', () => {
  const contextWindow = 262_144
  assert.equal(MIN_ANSWER_TOKENS, 2_048)
  const budget = resolveWireBudget({
    requested: 65_536,
    modelMaxTokens: 65_536,
    contextWindow,
    // Prompt alone nearly fills the window.
    estimatedInputTokens: contextWindow - MIN_ANSWER_TOKENS,
  })
  assert.equal(budget.overflow, true)
  assert.equal(budget.maxTokens, undefined)
})

test('a non-finite window refuses instead of emitting a NaN budget', () => {
  // Regression: `room` was computed from the raw window, so NaN slipped past the
  // `room < MIN_ANSWER_TOKENS` check and `maxTokens: NaN` reached the payload.
  for (const contextWindow of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const budget = resolveWireBudget({ modelMaxTokens: 65_536, contextWindow, estimatedInputTokens: 10 })
    assert.equal(budget.overflow, true, `window ${contextWindow} should refuse`)
    assert.equal(budget.maxTokens, undefined)
  }
})

test('overflowMessage matches the harness classifiers and says what to do', () => {
  const message = overflowMessage(300_000, 262_144)
  assert.match(message, /input/i)
  assert.match(message, /exceeds/i)
  assert.match(message, /maximum context length/i)
  assert.match(message, /262144 tokens/)
  // Actionable for the human reading the session.
  assert.match(message, /compact this session/)
  assert.match(message, /larger context window/)
})