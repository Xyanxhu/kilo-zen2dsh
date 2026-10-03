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

test('estimateRequestTokens costs prose and code by character class', () => {
  // English prose tokenizes near 4.3 characters per token, so 4000 letters and
  // spaces cost about 930 tokens plus the request envelope.
  const proseText = 'word '.repeat(800)
  const prose = estimateRequestTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: proseText }] }] })
  assert.ok(prose > 1_100 && prose < 1_300, `prose estimate out of range: ${prose}`)

  // Dense JSON (punctuation-heavy) costs more per character than prose does.
  const jsonText = '{"a":1,"b":[2,3],"c":{"d":4}}'.repeat(200)
  const json = estimateRequestTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: jsonText }] }] })
  const proseCostOfSameLength = (jsonText.length / 4.3) + 300
  assert.ok(json > proseCostOfSameLength, `expected dense JSON to cost more: ${json} vs ${proseCostOfSameLength}`)

  // CJK costs about one token per character regardless of its 3 UTF-8 bytes.
  const cjk = estimateRequestTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: '中'.repeat(3_000) }] }] })
  assert.ok(cjk >= 3_000 && cjk < 3_400, `CJK estimate out of range: ${cjk}`)

  // Base64 image payloads must not look like a million-token prompt.
  const vision = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'image', data: 'A'.repeat(4_000_000) }] }],
  })
  assert.ok(vision < 5_000, `expected a flat image charge, got ${vision}`)

  // System prompts and tool schemas are counted too.
  const withTools = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: proseText,
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
  })
  assert.ok(withTools > 900, `expected the system prompt to count, got ${withTools}`)
})

test('estimateRequestTokens is not systematically pessimistic on prose', () => {
  // Real data point: a 1.6 MB prose-heavy agent surface that the gateway counted
  // at 247,790 input tokens, while the old bytes/3 estimator reported 286,087
  // (+15%, which silently ate the answer budget and caused a false overflow).
  const prose = 'the quick brown fox jumps over the lazy dog and reports back '.repeat(24_000)
  const estimate = estimateRequestTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: prose }] }] })
  const gatewayWouldCount = prose.length / 4.3
  assert.ok(estimate < gatewayWouldCount * 1.1, `prose over-count too large: ${estimate} vs ${gatewayWouldCount}`)
})

test('blendCalibration folds gateway counts in without becoming optimistic', () => {
  // The first sample wins outright, clamped to the conservative band.
  assert.equal(blendCalibration(undefined, 0.866), 0.866)
  assert.equal(blendCalibration(undefined, 1.4), 1)
  assert.equal(blendCalibration(undefined, 0.2), 0.5)
  assert.equal(blendCalibration(undefined, Number.NaN), 1)
  // Later samples move the factor by CALIBRATION_ALPHA only.
  const next = blendCalibration(0.8, 1)
  assert.ok(next > 0.8 && next < 1, `expected a bounded step, got ${next}`)
  assert.ok(blendCalibration(0.99, 0.5) > 0.5)
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