# kilo2dsh TypeScript adapter

> 当前实现说明（2026-08-31）。本文件取代早期针对 OpenCode/Zen 的设计草稿。

## 目标

在 DSH 进程内注册 `kilo2dsh` 原生 `LlmAdapter`，直连 Kilo 的 OpenAI 兼容
网关，不携带账号凭证即可调用 Kilo 免费模型。

```text
DSH → KiloAdapter → pi-ai/openai-completions
                   ├─ GET  https://api.kilo.ai/api/gateway/models
                   └─ POST https://api.kilo.ai/api/gateway/chat/completions
```

发布包默认不启动 Go sidecar；`legacy/agent` 仅作为可选的本地桥接实现。

## 无 Key 语义

QwenPaw 和 Kilo 官方文档采用的免费层模式是“空 Key + OpenAI 兼容请求”。
本项目的 `ANONYMOUS_API_KEY` 默认值是空字符串，目录请求不会添加
`Authorization`。当前 pi-ai 使用的 OpenAI SDK 要求构造函数收到非空值，
因此 adapter 内部使用不可发送的私有 sentinel，并通过 `authorization: null`
清除 SDK 生成的 Bearer 头；线上请求仍然没有 Authorization。

只有显式设置 `upstreamApiKeyEnv`、`apiKey` 或 `anonymousKey` 时才会发送
`Authorization: Bearer <token>`。这不是认证绕过，免费准入和按 IP 限流由 Kilo
Gateway 服务端执行。

## 模型目录

`adapter/catalog.ts` 的判定顺序：

1. `isFree` 或 `is_free` 存在时以字段为准，显式 `false` 不会被名称覆盖；
2. 字段缺失时兼容 `kilo-auto/free`、`openrouter/free`、`:free` 和 `-free`；
3. 默认排除 `output_modalities` 包含 `image` 的模型，以及明确不支持
   `tools` 的模型。

实时响应成功后，动态目录完全取代静态 bootstrap；网络失败时使用 7 天缓存，
冷启动再使用源码内的 Kilo 免费 ID。每次刷新写入
`~/.kilo2dsh/adapter-status.json`。

## 请求头和消息

每个请求由首个用户 turn 派生稳定 session/project ID，并生成随机 task ID。
只发送 Kilo 关联头：

```text
X-KILOCODE-EDITORNAME: DSH/kilo2dsh
X-KILOCODE-TASKID: <req_…>
X-KILOCODE-PROJECTID: <prj_…>
```

不会伪装成 OpenCode CLI，也不会发送旧的 `x-opencode-*` 头。DSH 消息经
`messages.ts` 转成 pi-ai 文本、推理、工具调用和工具结果；`events.ts` 将
pi-ai SSE 事件还原为 DSH chunk。

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `adapter/catalog.ts` | Kilo `/models`、免费判定、缓存、刷新和静态回退 |
| `adapter/ids.ts` | Kilo task/project 关联 ID 与请求头 |
| `adapter/kilo-adapter.ts` | provider 构造、keyless SDK 兼容、流式调用 |
| `adapter/messages.ts` | DSH → pi-ai Context |
| `adapter/events.ts` | pi-ai events → DSH chunks |
| `index.ts` | adapter 注册、健康快照和可选 sidecar 生命周期 |

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
- [QwenPaw OpenAI provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
