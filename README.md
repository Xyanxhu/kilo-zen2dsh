<div align="center">

# kilo2dsh

**Kilo Gateway's free models, natively inside DSH (DeepSeek Harness).**

No account or API key is required for the free lane.

[![npm](https://img.shields.io/npm/v/@kilo2dsh%2Fdsh-plugin)](https://www.npmjs.com/package/@kilo2dsh/dsh-plugin)
[![license](https://img.shields.io/npm/l/@kilo2dsh%2Fdsh-plugin)](https://github.com/Xyanxhu/kilo2dsh/blob/master/LICENSE)

English | [简体中文](README.zh-CN.md)

</div>

---

`kilo2dsh` registers a native DSH `LlmAdapter` backed by Kilo's
OpenAI-compatible gateway. It discovers models from
`https://api.kilo.ai/api/gateway/models`, exposes only records marked free,
and streams completions to
`https://api.kilo.ai/api/gateway/chat/completions`.

The default request is genuinely keyless: the plugin sends an empty SDK key
internally and suppresses the generated `Authorization` header on the wire.
Kilo decides which free models are available and applies its per-IP quota; the
plugin does not bypass authentication or billing.

## Highlights

- Native adapter, no child process or local port in the published package.
- Dynamic free-model discovery using Kilo's `isFree`/`is_free` flag, with
  `kilo-auto/free` and `:free` suffix compatibility fallbacks.
- Text-output and tool-capable models only, suitable for DSH agent turns.
- Startup retry, periodic refresh, seven-day disk cache, and a health snapshot.
- Optional authenticated Kilo token for compatible deployments; it is never
  enabled by default.

## Install

```sh
dsh plugin --profile web add @kilo2dsh/dsh-plugin
```

When using this checkout before the npm package is published, build a local
tarball instead:

```sh
cd packages/plugin
pnpm install
pnpm pack
dsh plugin --profile web add ./kilo2dsh-dsh-plugin-0.3.0.tgz
```

Restart `dsh web`, open the model picker, and choose a model in the
`kilo2dsh` provider group. Node.js 20 or newer is required.

## Configuration

The defaults are keyless and point at the public Kilo gateway:

```yaml
- id: kilo2dsh
  name: '@kilo2dsh/dsh-plugin'
  config:
    mode: adapter
    providerId: kilo2dsh
    gatewayBaseUrl: https://api.kilo.ai/api/gateway
    refreshSeconds: 300
    requireTools: true
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

## Wire behavior

```text
GET  https://api.kilo.ai/api/gateway/models
POST https://api.kilo.ai/api/gateway/chat/completions
     (no Authorization header for the default free lane)
```

The adapter sends ordinary OpenAI-compatible JSON/SSE plus Kilo correlation
headers (`X-KILOCODE-EDITORNAME`, `X-KILOCODE-TASKID`, and
`X-KILOCODE-PROJECTID`). It does not impersonate the OpenCode CLI.

The model filter is deliberately conservative:

1. `isFree` or `is_free` is authoritative when present.
2. If the flag is absent, `kilo-auto/free`, `openrouter/free`, and IDs ending
   in `:free`/`-free` are accepted.
3. Image-output models and models without advertised tool support are hidden
   by default.

## Health and troubleshooting

Adapter status is written to `~/.kilo2dsh/adapter-status.json`. The cache is
stored beside it as `kilo-models.json`.

Kilo's anonymous free usage is controlled by Kilo and is rate-limited by IP
(the current documentation describes 200 requests per hour per IP). A 429 or
an unavailable model is an upstream service decision; wait, choose another
free model, or configure an authenticated token.

For the optional legacy bridge:

```sh
cd legacy
go build ./cmd/agent
go test ./...
```

It keeps a local authenticated `/v1` endpoint for DSH, but its upstream Kilo
requests use the same keyless behavior and `/api/gateway` paths.

## Adaptation source

This project is adapted from the [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
DSH/OpenCode integration prototype. The original OpenCode/Zen free-tier
integration was migrated here to Kilo Gateway's free tier; the Kilo and QwenPaw
protocol references are listed below.

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
- [QwenPaw Kilo provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)

## License

[MIT](./LICENSE) © FishBottle7
