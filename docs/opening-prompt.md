# Opening prompt: implement the Kilo + OpenCode Zen free-tier DSH adapters

This repository is a migration of the original
[FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
OpenCode-oriented prototype.
Treat the following as the acceptance contract:

- Kilo provider: base URL `https://api.kilo.ai/api/gateway`; discovery `GET
  /models`; completion `POST /chat/completions`; default free requests have an
  empty API key and **no Authorization header**.
- Zen provider: base URL `https://opencode.ai/zen/v1`; discovery `GET /models`;
  Chat Completions models use `POST /chat/completions`, while
  `muse-spark-1.2-contributor-free` uses `POST /responses`.
- Kilo `isFree`/`is_free` wins over naming; absent flags may use
  `kilo-auto/free`, `openrouter/free`, `:free`, or `-free`. Zen accepts the
  documented `big-pickle` exception and free suffixes, with future explicit
  flags taking precedence.
- Only text-output, tool-capable models are shown by default.
- Kilo uses `X-KILOCODE-*` correlation headers. Zen uses the OpenCode
  compatibility marker and correlation headers required by its current
  anonymous lane; this is an upstream compatibility requirement, not an auth
  bypass, and may still yield a 429 or require an account.
- Kilo and Zen own anonymous routing, quotas, and billing decisions; do not
  implement auth or rate-limit bypasses.

The preferred integration is an in-process TypeScript `LlmAdapter` pair
registered with `ctx.llm.registerAdapter`. The legacy Go sidecar is optional,
currently Kilo-only, and must retain Kilo's upstream URL and keyless semantics.

Run after every material change:

```sh
cd packages/plugin && pnpm typecheck && pnpm test && pnpm build
cd ../../legacy && go test ./...
```

Use the Kilo documentation and the QwenPaw provider implementation as protocol
references:

- https://kilo.ai/docs/gateway/authentication
- https://kilo.ai/docs/getting-started/using-kilo-for-free
- https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py
- https://dev.opencode.ai/docs/zen
- https://github.com/anomalyco/opencode/issues/42500
