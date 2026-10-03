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
 * `resolveWireBudget` clamps the budget sent against the measured prompt size,
 * and `blendCalibration` folds the gateway's own usage report back into the
 * estimator so the estimate stops drifting away from reality.
 */

import type { HarnessBlock, HarnessGenerateOptions, HarnessMessage } from './messages.ts'

/**
 * Largest share of the context window the adapter advertises as output. A
 * router's per-request cap and the harness's reserved budget are different
 * quantities: 25% keeps output generous for agent work while leaving the
 * harness most of the window for input plus compaction headroom.
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
 * Characters per token for ASCII letters and spaces. English prose tokenizes
 * near 4.3 characters per token; code and JSON are denser and are charged
 * through {@link SYMBOLS_PER_TOKEN} instead.
 */
const LETTERS_PER_TOKEN = 4.3

/** Characters per token for digits and punctuation (JSON, code, logs). */
const SYMBOLS_PER_TOKEN = 2.2

/** Per-message envelope cost (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4

/** Inline image payloads are not text: charge a flat rate instead of their base64 size. */
const IMAGE_TOKENS = 1600

/** One-off request envelope cost (system preamble, tool schema framing). */
const FIXED_OVERHEAD_TOKENS = 256

/**
 * Bounds for {@link blendCalibration}. The observed ratio of gateway count to
 * our estimate can be well below 1 (prose over-counts) but never meaningfully
 * above it: clamping at 1 keeps the estimator on the conservative side.
 */
export const MIN_CALIBRATION = 0.5
export const MAX_CALIBRATION = 1

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

/**
 * Approximate one string's token cost from its character classes.
 *
 * Measured against a real 248K-token agent session (prose, shell output, and
 * tool JSON): a single bytes-per-token divisor cannot fit both English prose
 * (~4.3 chars/token) and JSON/code (~2.5-3), and the error either wastes the
 * harness's answer budget or overflows the gateway. Classifying the characters
 * keeps the estimate within a few percent of the gateway on both.
 */
function textTokens(text: string): number {
  let letters = 0
  let symbols = 0
  let wide = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x7f) {
      // Space belongs to the prose class; digits and punctuation to the dense one.
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 32) letters += 1
      else symbols += 1
    } else {
      // CJK and other non-ASCII text costs about one token per character.
      wide += 1
    }
  }
  return letters / LETTERS_PER_TOKEN + symbols / SYMBOLS_PER_TOKEN + wide
}

function blockTokens(block: HarnessBlock): number {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return textTokens(block.text)
    case 'tool-call':
      return textTokens(block.name) + textTokens(block.arguments) + 8
    case 'tool-result': {
      let tokens = textTokens(block.toolCallId) + 8
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
 * mildly conservative on every character class, and
 * {@link blendCalibration} removes the remaining systematic drift once the
 * gateway has reported its own count for this route.
 *
 * @param options - the harness request about to be dispatched.
 * @returns a token estimate close to, and normally slightly above, the gateway count.
 */
export function estimateRequestTokens(
  options: Pick<HarnessGenerateOptions, 'messages' | 'system' | 'tools'>,
): number {
  let tokens = FIXED_OVERHEAD_TOKENS
  if (typeof options.system === 'string') tokens += textTokens(options.system)
  for (const message of Array.isArray(options.messages) ? options.messages : []) tokens += messageTokens(message)
  for (const tool of Array.isArray(options.tools) ? options.tools : []) {
    tokens += textTokens(tool.name) + textTokens(tool.description)
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
 * @param previous - current factor for the route, when a request already reported usage.
 * @param observed - gateway input tokens divided by this adapter's raw estimate.
 * @returns the blended factor, clamped so the estimator never becomes optimistic.
 */
export function blendCalibration(previous: number | undefined, observed: number): number {
  if (!Number.isFinite(observed) || observed <= 0) return previous ?? MAX_CALIBRATION
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
   * ({@link blendCalibration}). Defaults to 1 (fully conservative estimate).
   */
  calibration?: number
}

export interface WireBudget {
  /** `max_tokens` to send; absent only when {@link WireBudget.overflow} is set. */
  maxTokens?: number
  /** Prompt-size estimate after calibration, for logging and messages. */
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
 * @param input - requested budget, model cap, window, prompt estimate, calibration.
 * @returns the budget to send, or an overflow signal when nothing usable fits.
 */
export function resolveWireBudget(input: WireBudgetInput): WireBudget {
  const cap = Math.max(1, Math.min(positiveInteger(input.modelMaxTokens) ?? 1, positiveInteger(input.contextWindow) ?? 1))
  const requested = positiveInteger(input.requested) ?? cap
  const ceiling = Math.min(requested, cap)
  const calibration = Number.isFinite(input.calibration) ? Math.min(1, Math.max(MIN_CALIBRATION, input.calibration as number)) : 1
  const effectiveInputTokens = Math.ceil(Math.max(0, input.estimatedInputTokens) * calibration)
  const room = Math.floor(input.contextWindow - effectiveInputTokens - wireSafetyTokens(input.contextWindow))
  if (room < MIN_ANSWER_TOKENS) return { effectiveInputTokens, overflow: true }
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