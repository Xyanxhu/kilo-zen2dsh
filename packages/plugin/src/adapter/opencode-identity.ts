/**
 * OpenCode CLI release whose identity the Zen compatibility lane borrows.
 * Zen fingerprints its clients (User-Agent plus the x-opencode-* session
 * headers) and rejects traffic that stops looking like a current CLI, so
 * this must track a real release:
 * https://github.com/anomalyco/opencode/releases
 */
export const OPENCODE_CLI_VERSION = '1.18.35'

/**
 * Tokens the real CLI appends after `opencode/<version>`: the Vercel AI SDK
 * underneath adds its provider-utils version and the Bun runtime, producing
 * the compound form captured from a live opencode 1.18.35 request
 * (2026-10-06):
 *
 *     opencode/1.18.35 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
 *
 * Refresh all three tokens together (capture a live CLI request) when
 * bumping OPENCODE_CLI_VERSION. OPENCODE2DSH_VERSION still overrides just
 * the version token so users can update without rebuilding.
 */
const OPENCODE_CLI_UA_TOKENS = 'ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

/**
 * OpenCode-compatible user agent used by the Zen compatibility lane for
 * both model discovery and inference. The previous
 * `opencode/<version> (<platform> <arch>; node<version>)` shape never
 * matched any real client on the wire.
 */
export function opencodeUserAgent(): string {
  const version = process.env.OPENCODE2DSH_VERSION?.trim() || OPENCODE_CLI_VERSION
  return `opencode/${version} ${OPENCODE_CLI_UA_TOKENS}`
}
