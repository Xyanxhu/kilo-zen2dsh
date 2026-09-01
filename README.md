<div align="center">

# kilo-zen2dsh

**Kilo Gateway and OpenCode Zen free models, natively inside DSH (DeepSeek Harness).**

Kilo's free lane is keyless. OpenCode Zen is an independent, compatibility
lane whose anonymous availability is controlled by the Zen gateway.

[![npm](https://img.shields.io/npm/v/@huanx%2Fkilo-zen2dsh)](https://www.npmjs.com/package/@huanx/kilo-zen2dsh)
[![license](https://img.shields.io/npm/l/@huanx%2Fkilo-zen2dsh)](https://github.com/Xyanxhu/kilo-zen2dsh/blob/master/LICENSE)

English | [简体中文](README.zh-CN.md)

</div>

---

`kilo-zen2dsh` registers native DSH `LlmAdapter`s backed by two independent
OpenAI-compatible gateways:

- `kilo2dsh` → Kilo Gateway (`/api/gateway/models` and
  `/api/gateway/chat/completions`)
- `opencode2dsh` → OpenCode Zen (`/zen/v1/models` and the model-specific
  `/chat/completions` or `/responses` endpoint)

Kilo requests are genuinely keyless: the plugin suppresses the generated
`Authorization` header on the wire. Zen's compatibility lane uses the public
`Bearer public` placeholder and OpenCode-compatible request markers by default;
the gateway may still require its own anonymous eligibility, quota, or a user
account. Neither provider is an authentication or billing bypass.

## Highlights

- Native adapter, no child process or local port in the published package.
- Dynamic free-model discovery using Kilo's `isFree`/`is_free` flag, with
  `kilo-auto/free` and `:free` suffix compatibility fallbacks.
- Independent OpenCode Zen catalog and adapter (`opencode2dsh`) with the
  documented free model IDs, a separate cache, and Responses API routing for
  `muse-spark-1.2-contributor-free`.
- Text-output and tool-capable models only, suitable for DSH agent turns.
- Startup retry, periodic refresh, seven-day disk cache, and a health snapshot.
- Optional authenticated Kilo or Zen token for compatible deployments; no
  account token is enabled by default.

## Install

```sh
dsh plugin --profile web add @huanx/kilo-zen2dsh
```

When using this checkout before the npm package is published, build a local
tarball instead:

```sh
cd packages/plugin
pnpm install
pnpm pack
dsh plugin --profile web add ./huanx-kilo-zen2dsh-0.3.0.tgz
```

Restart `dsh web`, open the model picker, and choose a model in either the
`kilo2dsh` (Kilo) or `opencode2dsh` (Zen) provider group. Node.js 20 or newer is
required.

## Configuration

The defaults are keyless and point at the public Kilo gateway:

```yaml
- id: kilo2dsh
  name: '@huanx/kilo-zen2dsh'
  config:
    mode: adapter
    providerId: kilo2dsh
    gatewayBaseUrl: https://api.kilo.ai/api/gateway
    refreshSeconds: 300
    requireTools: true
    zenEnabled: true
```

To use an authenticated gateway token, set `upstreamApiKeyEnv` explicitly.
Leaving it empty is intentional; the plugin will not pick up
`KILO_API_KEY` (or another ambient secret) by accident.

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `adapter` | Native adapter. `sidecar` is an optional legacy Go bridge. |
| `providerId` | `kilo2dsh` | DSH route name. |
| `gatewayBaseUrl` | `https://api.kilo.ai/api/gateway` | Kilo-compatible gateway base URL. |
| `refreshSeconds` | `300` | Model catalog refresh interval. |
| `requireTools` | `true` | Hide free models that do not advertise `tools`. |
| `upstreamApiKeyEnv` | empty | Environment variable to opt into an explicit token. |
| `anonymousKey` | empty | Optional token for a private compatible gateway; empty means no auth header. |
| `zenEnabled` | `true` | Register the independent OpenCode Zen adapter in adapter mode. |
| `zenProviderId` | `opencode2dsh` | DSH route name for Zen. |
| `zenBaseUrl` | `https://opencode.ai/zen` | OpenCode Zen root URL. |
| `zenUserAgent` | empty | Optional compatibility User-Agent; empty derives the OpenCode format. |
| `zenApiKeyEnv` | empty | Optional Zen account-token environment variable. |
| `zenAnonymousKey` | `public` | Zen anonymous placeholder; set empty for a header-less private deployment. |

Set `zenEnabled: false` when you only want Kilo, or when the Zen gateway is
returning an anonymous-lane 429. `sidecar` mode is the legacy Go bridge and
currently exposes Kilo only; the two-provider setup is implemented in native
adapter mode.

## Wire behavior

```text
Kilo:
  GET  https://api.kilo.ai/api/gateway/models
  POST https://api.kilo.ai/api/gateway/chat/completions
       (no Authorization header for the default free lane)

OpenCode Zen:
  GET  https://opencode.ai/zen/v1/models
  POST https://opencode.ai/zen/v1/chat/completions
       (Bearer public + OpenCode compatibility headers)
  POST https://opencode.ai/zen/v1/responses
       (used for Responses-only free models)
```

The Kilo adapter sends ordinary OpenAI-compatible JSON/SSE plus Kilo correlation
headers (`X-KILOCODE-EDITORNAME`, `X-KILOCODE-TASKID`, and
`X-KILOCODE-PROJECTID`). The Zen adapter sends the OpenCode compatibility
marker and correlation headers required by the current anonymous lane. This is
an upstream compatibility requirement, not a guarantee that Zen will accept
third-party clients.

The model filter is deliberately conservative:

1. `isFree` or `is_free` is authoritative when present.
2. If the flag is absent, `kilo-auto/free`, `openrouter/free`, and IDs ending
   in `:free`/`-free` are accepted.
3. Image-output models and models without advertised tool support are hidden
   by default.

### Automatic context and output-limit reconciliation

Kilo model-directory records are not always internally consistent: a limit may
be present on the top-level record, `top_provider`, or a nested `limit(s)`
object, and compatible gateways use several spellings. The adapter merges
those declarations and uses the smallest positive context limit. It keeps the
advertised context window for prompt history, while calculating a separate
safe output budget.

The current gateway catalog advertises `minimax/minimax-m3:free` with a
943,718-token completion limit, but the backend rejects requests above
524,288. The adapter therefore applies a 524,288-token gateway compatibility
ceiling (or the smaller model-specific limit) to `defaultMaxTokens` and to
both `max_tokens` and `max_completion_tokens` immediately before the wire
request. An oversized default supplied by DSH is consequently reduced
automatically; callers do not need to edit their model configuration. This
keeps a 1M-token context declaration available for input while preventing the
400 error shown by MiniMax-M3. The compatibility ceiling is Kilo-specific;
OpenCode Zen keeps the limits reported by its own catalog.

For Zen, the public model directory currently contains minimal OpenAI records,
so the adapter accepts the documented `big-pickle` exception and IDs ending in
`-free`/`:free`, while treating an explicit future `isFree`/`is_free` flag as
authoritative. The live catalog replaces the bootstrap list after a successful
refresh.

## Health and troubleshooting

Kilo adapter status is written to `~/.kilo2dsh/adapter-status.json`; Zen status
is written to `~/.kilo2dsh/zen-adapter-status.json`. Their caches are
`kilo-models.json` and `zen-models.json` respectively.

Kilo's anonymous free usage is controlled by Kilo and is rate-limited by IP
(the current documentation describes 200 requests per hour per IP). A 429 or
an unavailable model is an upstream service decision; wait, choose another
free model, or configure an authenticated token.

Zen's free models are promotional and can be withdrawn or rate-limited. The
current OpenCode documentation describes them as limited-time models, and the
gateway has rejected non-OpenCode user agents with `429 FreeUsageLimitError` in
some deployments. Treat Zen as best-effort, avoid sending confidential data to
free models, and use `zenApiKeyEnv` if your Zen account requires a token.

For the optional legacy bridge:

```sh
cd legacy
go build ./cmd/agent
go test ./...
```

It keeps a local authenticated `/v1` endpoint for DSH, but its upstream Kilo
requests use the same keyless behavior and `/api/gateway` paths. Use native
adapter mode for the independent Zen provider.

## Adaptation source

This project is adapted from the [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
DSH/OpenCode integration prototype. The Kilo adapter is the migration target;
the original Zen free-tier behavior is retained as a separate optional native
adapter rather than being mixed into Kilo's keyless transport. The Kilo, Zen,
and QwenPaw protocol references are listed below.

## Development

```sh
cd packages/plugin
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## References

- [Kilo Gateway authentication](https://kilo.ai/docs/gateway/authentication)
- [Using Kilo for Free](https://kilo.ai/docs/getting-started/using-kilo-for-free)
- [Kilo Gateway API reference](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/gateway/api-reference.md)
- [OpenCode Zen documentation](https://dev.opencode.ai/docs/zen)
- [OpenCode provider source (`apiKey: public` free lane)](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts)
- [OpenCode issue: anonymous Zen user-agent behavior](https://github.com/anomalyco/opencode/issues/42500)
- [QwenPaw Kilo provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)

## License

[MIT](./LICENSE) © FishBottle7
