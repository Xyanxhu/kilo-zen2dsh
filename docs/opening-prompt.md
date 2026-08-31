# Opening prompt: implement the Kilo free-tier DSH adapter

This repository is a migration of the original
[FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
OpenCode-oriented prototype.
Treat the following as the acceptance contract:

- Base URL: `https://api.kilo.ai/api/gateway`.
- Discovery: `GET /models`; completion: `POST /chat/completions`.
- Default free requests have an empty API key and **no Authorization header**.
- `isFree`/`is_free` wins over naming; absent flags may use
  `kilo-auto/free`, `openrouter/free`, `:free`, or `-free`.
- Only text-output, tool-capable models are shown by default.
- Use Kilo correlation headers (`X-KILOCODE-*`), never OpenCode CLI spoofing.
- Kilo owns anonymous routing and per-IP limits; do not implement auth bypasses.

The preferred integration is an in-process TypeScript `LlmAdapter` registered
with `ctx.llm.registerAdapter`. The legacy Go sidecar is optional and must
share the same upstream URL and keyless semantics.

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
