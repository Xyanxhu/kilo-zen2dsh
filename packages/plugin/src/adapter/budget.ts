/**
 * Output-budget policy shared by the Kilo and OpenCode Zen adapters.
 *
 * Kilo reports OpenRouter-style *per-request* output caps, and it reports them
 * generously: its free lane advertises `max_completion_tokens` as large as 90%
 * of a model's context window (`qwen/qwen3.8-27b:free`: 235929 of 262144,
 * identical for `apodex/apodex-1.1-mini:free` and
 * `nvidia/nemotron-3-super-120b-a12b:free`; `stepfun/step-3.7-flash:free`
 * advertises 262144 of 262144). DSH reads that number as the budget every
 * routed request reserves, so passing it through verbatim breaks the harness
 * twice:
 *
 *  1. every request asks for an answer as large as the whole remaining window,
 *     so prompt + answer overflows the endpoint and the gateway answers 400
 *     ("requested about 262507 tokens ... maximum context length is 262144");
 *  2. compaction-basic reserves the same number, so
 *     `contextWindow - maxTokens - headroomTokens <= 0` leaves no pressure
 *     budget and automatic compaction is disabled exactly when it is needed.
 *
 * Three guards keep the adapter self-correcting with no user configuration:
 * `outputCeilingForWindow` bounds the *declared* budget (model metadata),
 * `resolveWireBudget` clamps the budget sent against the estimated prompt size,
 * and `blendCalibration` folds the gateway's own usage report back into the
 * estimator so the estimate stops drifting away from reality.
 */

import type { HarnessBlock, HarnessGenerateOptions, HarnessMessage } from './messages.ts'

/**
 * Largest share of the context window the adapter advertises as output. A
 * router's per-request cap and the harness's reserved budget are different
 * quantities: 25% keeps output generous for agent work while leaving the
 * harness most of the window for input plus compaction headroom.
 *
 * Note the harness's compaction pressure budget is
 * `contextWindow - maxTokens - headroomTokens`, and `compaction-basic` defaults
 * `headroomTokens` to 65536, so a window at or below ~87381 tokens has no
 * positive pressure budget at any share: those models stay outside automatic
 * compaction, which is a harness limit rather than something this share can fix.
 */
export const MAX_OUTPUT_WINDOW_SHARE = 0.25

/**
 * Share of the window (at least {@link MIN_WIRE_SAFETY_TOKENS}) held back from
 * the wire budget so a small tokenizer difference between our estimate and the
 * gateway cannot push the request over the limit.
 */
export const WIRE_SAFETY_SHARE = 0.02

/** Floor for {@link wireSafetyTokens}. */
export const MIN_WIRE_SAFETY_TOKENS = 1024

/**
 * Smallest answer worth dispatching. This is a *refusal* threshold, not an
 * output cap: the budget actually sent is `contextWindow - prompt - safety`.
 * When less than this remains the request cannot produce a useful answer, so
 * the adapter reports a context overflow and lets the harness compact instead
 * of paying a round trip for a truncated reply.
 */
export const MIN_ANSWER_TOKENS = 2048

/**
 * Character classes, measured against `cl100k_base`, that drive the prompt
 * estimate. Values are *characters per token*, so a smaller number means a
 * denser (more expensive) class:
 *
 * | content                        | measured chars/token |
 * | ------------------------------ | -------------------- |
 * | English prose                  | 5.58                 |
 * | TypeScript source              | 4.23                 |
 * | markdown / HTML / minified JS  | 3.36 - 3.59          |
 * | tool JSON                      | 3.38                 |
 * | URLs                           | 2.70                 |
 * | pure digits                    | 2.99                 |
 * | random hex / UUIDs             | 1.76 - 1.95          |
 * | random lowercase letters       | 1.62                 |
 * | random base64                  | 1.39                 |
 * | CJK                            | 1.00                 |
 * | emoji (incl. ZWJ sequences)    | 0.38                 |
 *
 * Every constant below sits on the conservative side of those measurements, so
 * the estimate is never smaller than the gateway's own count for the samples in
 * `test/budget.test.ts`. That matters because an optimistic estimate is exactly
 * what produced the original 400.
 */
const WORD = { letters: 3.6, digits: 2.6, struct: 1.7, other: 1.7 } as const

/** Long runs that look like structured text: code, JSON, HTML, URLs. */
const STRUCTURED = { letters: 2.4, digits: 1.35, struct: 1.8, other: 1.4 } as const

/** Long runs that look like machine data: base64, hex, hashes, opaque ids. */
const DATA = { letters: 1.2, digits: 2.2, struct: 1.5, other: 1.3 } as const

/** Letters in a long but word-shaped run (no spaces, vowels present). */
const WORDLIKE_LETTERS = 2.6

/**
 * Runs longer than this are treated as machine data rather than words: prose
 * separates words with spaces, so a 16+ character run without whitespace is
 * usually an id, a hash, base64, or minified code.
 */
const LONG_RUN = 16

/** Structural punctuation, used to separate code-like from data-like runs. */
const STRUCTURAL = new Set('"\'{}[]<>()=:,;.!?&%$#@*|/\\^~`+-')

/**
 * English words draw ~38% of their letters from `aeiou`; random base64/hex
 * draws ~20%. Runs below this fraction are charged as data even when JSON
 * punctuation surrounds them, which is what a hashed `integrity` field looks
 * like.
 */
const WORD_VOWEL_FLOOR = 0.28

/** Structural punctuation share that marks a long run as code-like. */
const STRUCTURED_RATIO = 0.08

/** Digit share that marks a long run as data-like (hex, ids, timestamps). */
const DIGITS_RATIO = 0.1

/** Characters per token for whitespace: spaces measured 125, newlines 29. */
const SPACE_CHARS_PER_TOKEN = 16
const NEWLINE_TOKENS = 0.5

/**
 * Non-ASCII text costs a token per character on average, and CJK measured
 * slightly denser than that (0.94 characters per token), so it is charged a
 * little above one token per character.
 */
const WIDE_TOKENS = 1.1

/** A letter fragment at least this long can be judged random instead of a word. */
const RANDOM_MIN_LENGTH = 6

/** Tokens per code point for emoji, including ZWJ sequence members. */
const EMOJI_TOKENS = 3

/** Per-message envelope cost (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4

/**
 * Flat charge for an inline image. The adapter downscales to at most 1568px
 * (`messages.ts`), which bills at roughly `(1568 / 28) ** 2 ≈ 3136` tokens on
 * the providers that price tiles; charging that keeps a screenshot-heavy
 * session from looking like text.
 */
const IMAGE_TOKENS = 3200

/** One-off request envelope cost (system preamble, tool schema framing). */
const FIXED_OVERHEAD_TOKENS = 256

/**
 * Bounds for {@link blendCalibration}, as a multiplier on the raw estimate.
 *
 * The floor corrects the estimator's deliberate pessimism (measured up to 1.8x
 * on HTML-heavy input). The ceiling has to sit well above 1: a route whose real
 * prompt turns out denser than any class we model must be *correctable upward*,
 * and clamping at 1 is what made an earlier version unable to learn from a
 * 2.6x under-estimate.
 */
export const MIN_CALIBRATION = 0.5
export const MAX_CALIBRATION = 4

/** EMA weight of one fresh usage report. */
export const CALIBRATION_ALPHA = 0.3

/** Output ceiling implied by one context window, never below one token. */
export function outputCeilingForWindow(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 1
  return Math.max(1, Math.floor(contextWindow * MAX_OUTPUT_WINDOW_SHARE))
}

/** Token headroom held back at the wire boundary for one context window. */
export function wireSafetyTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return MIN_WIRE_SAFETY_TOKENS
  return Math.max(MIN_WIRE_SAFETY_TOKENS, Math.ceil(contextWindow * WIRE_SAFETY_SHARE))
}

type CharClass = 'letters' | 'digits' | 'struct' | 'other' | 'wide'

const VOWELS = new Set('aeiouAEIOU')

function classify(char: string): CharClass {
  const code = char.codePointAt(0) ?? 0
  if (code > 0x7f) return 'wide'
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return 'letters'
  if (code >= 48 && code <= 57) return 'digits'
  if (STRUCTURAL.has(char)) return 'struct'
  return 'other'
}

/**
 * Emoji and their joiners cost far more than their code point count: a ZWJ
 * sequence measured 0.38 characters per token, so each code point is charged as
 * several tokens.
 */
function isEmoji(code: number): boolean {
  return (
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff) ||
    (code >= 0x2190 && code <= 0x21ff) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    code === 0xfe0f ||
    code === 0x200d
  )
}

/**
 * Charge one short (word-sized) run, one tokenizer fragment at a time.
 *
 * Tokenizers emit roughly one token per homogeneous fragment: `dur=42ms` costs
 * four tokens, not the two a purely linear per-class charge would predict,
 * because letters, `=`, digits and letters each start a new token. Letter
 * fragments of six characters or more are additionally checked for vowels: a
 * short random id (`qxzjvbnmwrts`) tokenizes like data, not like a word.
 */
function shortRunTokens(run: string): number {
  let tokens = 0
  let className: CharClass | undefined
  let length = 0
  let vowels = 0
  const flush = () => {
    if (className !== undefined && length > 0) {
      if (className === 'letters') {
        tokens +=
          length >= RANDOM_MIN_LENGTH && vowels / length < WORD_VOWEL_FLOOR
            ? length / DATA.letters
            : Math.max(1, Math.floor(length / WORD.letters))
      } else if (className !== 'wide') {
        tokens += Math.max(1, Math.floor(length / WORD[className]))
      }
    }
    className = undefined
    length = 0
    vowels = 0
  }
  for (const char of run) {
    const kind = classify(char)
    if (kind === 'wide') {
      flush()
      tokens += isEmoji(char.codePointAt(0) ?? 0) ? EMOJI_TOKENS : WIDE_TOKENS
      continue
    }
    if (kind === className) {
      length += 1
      if (VOWELS.has(char)) vowels += 1
      continue
    }
    flush()
    className = kind
    length = 1
    vowels = VOWELS.has(char) ? 1 : 0
  }
  flush()
  return tokens
}

/**
 * Charge one long (machine-data-sized) run.
 *
 * Long runs cannot use the word table: random base64 is 1.39 characters per
 * token while English words are 4.3-5.6, and both are "letters". The run is
 * therefore classified first, using the signals that separate code from data:
 * structural punctuation (code and JSON are full of it), digit share (hex, ids
 * and timestamps), and the vowel fraction of its letters (base64 and hashes
 * look nothing like words).
 */
function longRunTokens(run: string): number {
  let letters = 0
  let digits = 0
  let struct = 0
  let other = 0
  let vowels = 0
  let wide = 0
  let emoji = 0
  for (const char of run) {
    const kind = classify(char)
    if (kind === 'wide') {
      wide += 1
      if (isEmoji(char.codePointAt(0) ?? 0)) emoji += 1
      continue
    }
    if (kind === 'letters') {
      letters += 1
      if (VOWELS.has(char)) vowels += 1
      continue
    }
    if (kind === 'digits') digits += 1
    else if (kind === 'struct') struct += 1
    else other += 1
  }
  let tokens = (wide - emoji) * WIDE_TOKENS + emoji * EMOJI_TOKENS
  const ascii = letters + digits + struct + other
  if (ascii === 0) return tokens
  const vowelFraction = letters > 0 ? vowels / letters : 0
  const looksRandom = letters / ascii >= 0.6 && vowelFraction < WORD_VOWEL_FLOOR
  let table: { letters: number; digits: number; struct: number; other: number }
  if (struct / ascii >= STRUCTURED_RATIO && !looksRandom) table = STRUCTURED
  else if (digits / ascii >= DIGITS_RATIO) table = DATA
  else if (letters / ascii >= 0.9 && vowelFraction >= WORD_VOWEL_FLOOR) table = { ...WORD, letters: WORDLIKE_LETTERS }
  else table = DATA
  tokens += letters / table.letters + digits / table.digits + struct / table.struct + other / table.other
  return tokens
}

/** Approximate one string's token cost from its whitespace-separated runs. */
function textTokens(text: string): number {
  let tokens = 0
  let run = ''
  for (const char of text) {
    if (char === ' ') {
      if (run !== '') tokens += run.length <= LONG_RUN ? shortRunTokens(run) : longRunTokens(run)
      run = ''
      tokens += 1 / SPACE_CHARS_PER_TOKEN
      continue
    }
    if (char === '\n' || char === '\t') {
      if (run !== '') tokens += run.length <= LONG_RUN ? shortRunTokens(run) : longRunTokens(run)
      run = ''
      tokens += NEWLINE_TOKENS
      continue
    }
    run += char
  }
  if (run !== '') tokens += run.length <= LONG_RUN ? shortRunTokens(run) : longRunTokens(run)
  return tokens
}

/** Estimate a field that is documented as text but arrives unvalidated. */
function textTokensOf(value: unknown): number {
  return typeof value === 'string' ? textTokens(value) : 0
}

function blockTokens(block: HarnessBlock): number {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return textTokensOf(block.text)
    case 'tool-call':
      return textTokensOf(block.name) + textTokensOf(block.arguments) + 8
    case 'tool-result': {
      let tokens = textTokensOf(block.toolCallId) + 8
      for (const nested of Array.isArray(block.content) ? block.content : []) tokens += blockTokens(nested)
      return tokens
    }
    case 'image':
      // Base64 payloads are not tokenized as text; charge the flat image rate
      // so a vision request does not look like a million-token prompt.
      return IMAGE_TOKENS
    default:
      return 0
  }
}

function messageTokens(message: HarnessMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS
  for (const block of Array.isArray(message.content) ? message.content : []) tokens += blockTokens(block)
  return tokens
}

/**
 * Approximate one request's prompt size in tokens.
 *
 * The estimate feeds {@link resolveWireBudget}: it exists so a request can never
 * ask for prompt + answer beyond the gateway's window. It is deliberately
 * conservative on every character class — verified sample by sample against
 * `cl100k_base` in the tests — and {@link blendCalibration} removes the
 * remaining systematic drift once the gateway has reported its own count for
 * this route.
 *
 * @param options - the harness request about to be dispatched.
 * @returns a token estimate at or above the gateway's count for measured content.
 */
export function estimateRequestTokens(
  options: Pick<HarnessGenerateOptions, 'messages' | 'system' | 'tools'>,
): number {
  let tokens = FIXED_OVERHEAD_TOKENS
  tokens += textTokensOf(options.system)
  for (const message of Array.isArray(options.messages) ? options.messages : []) tokens += messageTokens(message)
  for (const tool of Array.isArray(options.tools) ? options.tools : []) {
    tokens += textTokensOf(tool.name) + textTokensOf(tool.description)
    try {
      tokens += textTokens(JSON.stringify(tool.parameters ?? {}))
    } catch {
      tokens += FIXED_OVERHEAD_TOKENS
    }
  }
  return Math.ceil(tokens)
}

/**
 * Fold one gateway usage report into the estimator's calibration factor.
 *
 * The observed ratio is `reportedPromptTokens / rawEstimate`, so a value above 1
 * means the estimator was optimistic for this route and the factor moves up
 * toward {@link MAX_CALIBRATION}. Non-finite or non-positive observations leave
 * the previous factor untouched.
 *
 * @param previous - current factor for the route, when a request already reported usage.
 * @param observed - gateway prompt tokens divided by this adapter's raw estimate.
 * @returns the blended factor, clamped to the configured bounds.
 */
export function blendCalibration(previous: number | undefined, observed: number): number {
  if (!Number.isFinite(observed) || observed <= 0) return previous ?? 1
  const bounded = Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, observed))
  if (previous === undefined || !Number.isFinite(previous)) return bounded
  const blended = previous + (bounded - previous) * CALIBRATION_ALPHA
  return Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, blended))
}

export interface WireBudgetInput {
  /** Budget DSH materialized from the adapter (may be absent for direct callers). */
  requested?: number | string | null
  /** Adapter-side cap for this model, already window- and gateway-bounded. */
  modelMaxTokens: number
  /** Context window the gateway enforces for this model. */
  contextWindow: number
  /** Prompt size estimated by {@link estimateRequestTokens}. */
  estimatedInputTokens: number
  /**
   * Calibration factor learned from this route's own usage reports
   * ({@link blendCalibration}). Defaults to 1 (uncalibrated estimate).
   */
  calibration?: number
}

export interface WireBudget {
  /** `max_tokens` to send; absent only when {@link WireBudget.overflow} is set. */
  maxTokens?: number
  /** Prompt-size estimate after calibration and the reported floor. */
  effectiveInputTokens: number
  /**
   * True when even a minimal answer cannot fit next to the prompt: the adapter
   * must surface a context-overflow failure instead of spending a doomed
   * request, so the harness can compact and retry.
   */
  overflow: boolean
}

function positiveInteger(value: number | string | null | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.floor(parsed)
}

/**
 * Clamp the output budget of one request to the room its prompt leaves.
 *
 * A gateway-reported prompt size is deliberately not used as a floor here. A
 * reported 215K against an 82K estimate means the estimator was optimistic,
 * while a reported 215K against a 10K estimate after compaction means the
 * session shrank, and these are indistinguishable from the numbers alone; a
 * floor that guesses wrong refuses a prompt that fits, on every retry.
 * {@link blendCalibration} recovers that precision instead, and its upward bound
 * lets a route learn from an under-estimate without refusing anything.
 *
 * @param input - requested budget, model cap, window, prompt estimate, calibration.
 * @returns the budget to send, or an overflow signal when nothing usable fits.
 */
export function resolveWireBudget(input: WireBudgetInput): WireBudget {
  const window = positiveInteger(input.contextWindow) ?? 1
  const cap = Math.max(1, Math.min(positiveInteger(input.modelMaxTokens) ?? 1, window))
  const requested = positiveInteger(input.requested) ?? cap
  const ceiling = Math.min(requested, cap)
  const calibration = Number.isFinite(input.calibration)
    ? Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, input.calibration as number))
    : 1
  const rawEstimate = Math.max(0, Number.isFinite(input.estimatedInputTokens) ? input.estimatedInputTokens : 0)
  const effectiveInputTokens = Math.ceil(rawEstimate * calibration)
  const room = window - effectiveInputTokens - wireSafetyTokens(window)
  if (!Number.isFinite(room) || room < MIN_ANSWER_TOKENS) return { effectiveInputTokens, overflow: true }
  return { maxTokens: Math.min(ceiling, room), effectiveInputTokens, overflow: false }
}

/**
 * Message the adapter reports when a prompt cannot fit. The wording is
 * deliberately the OpenAI-compatible overflow phrasing that both pi-ai's
 * `isContextOverflow` and dsh-llm's `isContextWindowExceededError` recognize,
 * so the harness routes it to context-overflow recovery instead of surfacing a
 * raw upstream 400. The trailing guidance is for the human reading the session.
 */
export function overflowMessage(estimatedInputTokens: number, contextWindow: number): string {
  return (
    `input exceeds the model's maximum context length of ${contextWindow} tokens ` +
    `(about ${estimatedInputTokens} input tokens, leaving less than ${MIN_ANSWER_TOKENS} for the answer); ` +
    'compact this session, switch to a model with a larger context window, or start a new session'
  )
}