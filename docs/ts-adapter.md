# kilo-zen2dsh TypeScript adapters

> 当前实现说明（2026-09-01）。本文件记录 Kilo 免费层迁移以及保留的
> OpenCode Zen 兼容层。

## 目标

在 DSH 进程内注册两个原生 `LlmAdapter`，各自拥有独立的目录、认证语义和
上游 URL：

```text
DSH → KiloAdapter       → pi-ai/openai-completions → Kilo Gateway
DSH → ZenAdapter        → pi-ai/openai-completions → OpenCode Zen
                       ↘ pi-ai/openai-responses  (Muse Spark Contributor Free)
```

默认 `mode: adapter` 不启动 Go sidecar。`legacy/agent` 仍可作为需要进程隔离
的 Kilo 本地桥接实现。

## Kilo 无 Key 语义

`ANONYMOUS_API_KEY` 默认是空字符串，目录和 completion 请求都不会添加
`Authorization`。当前 pi-ai 使用的 OpenAI SDK 要求构造函数收到非空值，因此
adapter 只在进程内使用不可发送的 sentinel，并通过 `authorization: null` 清除
SDK 生成的 Bearer 头；线上仍是无鉴权请求。

只有显式设置 `upstreamApiKeyEnv`、`apiKey` 或 `anonymousKey` 时才发送
`Authorization: Bearer <token>`。免费准入、合作方路由和按 IP 限流由 Kilo
Gateway 执行，不由插件绕过。

## OpenCode Zen 兼容语义

Zen 使用独立的 `ZenModelCatalog`、`ZenAdapter` 和 `zen-models.json` 缓存：

```text
GET  https://opencode.ai/zen/v1/models
POST https://opencode.ai/zen/v1/chat/completions
POST https://opencode.ai/zen/v1/responses   (Responses-only model)
```

默认凭据是参考实现使用的 `public` 占位值，且目录/请求附带
`x-opencode-client: cli`、OpenCode session/request 关联头和可配置的
`opencode/<version>` User-Agent。该兼容标记不是认证绕过：Zen 网关可以按活动、
IP、User-Agent 或账号策略拒绝请求，用户应把 Zen 视为 best-effort；显式配置
`zenApiKeyEnv` 可改用自己的 Zen token。

OpenCode 的公开目录目前是最小 OpenAI 记录，缺少统一的价格/免费字段。判定
因此采用：

1. 未来出现的 `isFree`/`is_free` 字段优先；
2. `big-pickle` 例外以及 `:free`/`-free` 后缀；
3. 成功的 live `/models` 快照覆盖静态 bootstrap，失败时使用独立缓存和静态
   文档列表。

`muse-spark-1.2-contributor-free` 在 Zen 文档中使用 Responses endpoint，
`zenModelApi()` 会为它选择 `openai-responses`；其他已知免费模型走 Chat
Completions。未知未来模型默认走 Chat Completions，并可由目录记录的
`api`/`protocol`/`endpoint` 字段声明 Responses。

## 模型目录通用规则

`adapter/catalog.ts` 的 Kilo 判定顺序：

1. `isFree` 或 `is_free` 存在时以字段为准，显式 `false` 不会被名称覆盖；
2. 字段缺失时兼容 `kilo-auto/free`、`openrouter/free`、`:free` 和 `-free`；
3. 默认排除 `output_modalities` 包含 `image` 的模型，以及明确不支持
   `tools` 的模型。

两种目录在成功刷新后都只信任 live snapshot；失败时按 7 天磁盘缓存 → 对应
静态列表回退。每次刷新分别写入：

```text
~/.kilo2dsh/adapter-status.json
~/.kilo2dsh/zen-adapter-status.json
```

## 请求头和消息

每个 provider 都从首个用户 turn 派生稳定 session/project ID，并生成随机 request
ID。Kilo 发送 `X-KILOCODE-*` 关联头；Zen 发送 `x-opencode-*` 兼容头。两者都
不把 prompt 放入 ID。DSH 消息经 `messages.ts` 转成 pi-ai Context，`events.ts`
将 Chat/Responses SSE 事件还原为 DSH chunk。

## 配置

```yaml
mode: adapter
providerId: kilo2dsh
gatewayBaseUrl: https://api.kilo.ai/api/gateway
zenEnabled: true
zenProviderId: opencode2dsh
zenBaseUrl: https://opencode.ai/zen
zenUserAgent: ''
zenApiKeyEnv: ''
zenAnonymousKey: public
```

设置 `zenEnabled: false` 可只注册 Kilo。`sidecar` 模式目前仅实现 Kilo 上游；
需要双 provider 时使用 adapter 模式。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `adapter/catalog.ts` | Kilo/Zen 目录、免费判定、缓存、刷新和静态回退 |
| `adapter/ids.ts` | Kilo 与 OpenCode 关联 ID、User-Agent 和请求头 |
| `adapter/kilo-adapter.ts` | 通用 pi-ai provider、keyless SDK 兼容和 API 选择 |
| `adapter/zen-adapter.ts` | Zen URL、public 凭据、兼容头和 Responses 选择 |
| `adapter/messages.ts` | DSH → pi-ai Context |
| `adapter/events.ts` | pi-ai events → DSH chunks |
| `index.ts` | 两个 adapter 注册、健康快照和 sidecar 生命周期 |

## 验证命令

```sh
cd packages/plugin
pnpm typecheck
pnpm test
pnpm build

cd ../../legacy
go test ./...
```

## 参考

- [Kilo Gateway authentication](https://kilo.ai/docs/gateway/authentication)
- [Using Kilo for Free](https://kilo.ai/docs/getting-started/using-kilo-for-free)
- [OpenCode Zen documentation](https://dev.opencode.ai/docs/zen)
- [OpenCode provider source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts)
- [OpenCode issue #42500: anonymous Zen User-Agent behavior](https://github.com/anomalyco/opencode/issues/42500)
- [QwenPaw OpenAI provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
