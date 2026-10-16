/**
 * OpenCode CLI release whose identity the Zen compatibility lane borrows.
 * Zen fingerprints its clients (User-Agent plus the x-opencode-* session
 * headers) and rejects traffic that stops looking like a current client, so
 * this must track a real release. The official CLI now ships as
 * `@opencode/cli` (2.x): https://www.npmjs.com/package/@opencode/cli
 */
export const OPENCODE_CLI_VERSION = '2.0.30'

/**
 * Release channel token in the client's User-Agent. The official client
 * reports the channel it ships on, not a versioned channel.
 */
const OPENCODE_CLI_CHANNEL = 'latest'

/**
 * OpenCode-compatible user agent used by the Zen compatibility lane for both
 * model discovery and inference.
 *
 * The 2026-10-14 free-tier gate validates the `opencode/<channel>/<version>/
 * <client>` layout the official client sends; the compound
 * "opencode/<version> ai-sdk/... runtime/..." form captured from the 1.x
 * client is rejected with 403 FreeTierError even when the rest of the request
 * is identical. The version token itself is not validated upstream, so
 * OPENCODE2DSH_VERSION can override just that token without rebuilding.
 */
export function opencodeUserAgent(): string {
  const version = process.env.OPENCODE2DSH_VERSION?.trim() || OPENCODE_CLI_VERSION
  return `opencode/${OPENCODE_CLI_CHANNEL}/${version}/cli`
}
