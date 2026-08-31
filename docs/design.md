# kilo2dsh 架构设计

> 版本：Kilo 免费层迁移版（2026-08-31）。早期 OpenCode/Zen 设计已被本文件取代。

## 1. 定位

`kilo2dsh` 是一个 DSH cordis 插件：在 DSH 进程内注册 Kilo provider，动态发现
Kilo Gateway 的免费模型，并以 OpenAI Chat Completions 流式协议返回结果。
发布包不需要账号、API Key、额外 HTTP 代理或 Go 二进制。

Kilo 服务器负责免费准入、合作方路由和按 IP 限流；插件只筛选公开目录中明确
可用的免费模型，不尝试绕过付费鉴权。

## 2. 数据流

```text
┌──────────────┐   registerAdapter   ┌──────────────┐
│ DSH / dsh-llm│ ───────────────────▶ │ KiloAdapter  │
└──────────────┘                     └──────┬───────┘
                                           │ pi-ai
                              ┌────────────▼────────────┐
                              │ Kilo Gateway              │
                              │ /api/gateway/models       │
                              │ /api/gateway/chat/...     │
                              └───────────────────────────┘
```

启动时 adapter 立即注册。目录刷新在后台执行，状态写入
`~/.kilo2dsh/adapter-status.json`，因此网络暂时不可用不会阻塞 DSH 启动。

## 3. 免费模型判定

目录记录优先级如下：

1. `isFree` / `is_free`：字段存在时完全服从（`false` 不能被名称覆盖）；
2. 字段缺失时接受 `kilo-auto/free`、`openrouter/free`、`*:free` 与 `*-free`；
3. `architecture.output_modalities` 含 `image` 的模型排除；
4. 默认要求 `supported_parameters` 包含 `tools`。字段缺失或为空时按兼容模式
   处理为支持工具。

实时目录成功后是唯一权威来源；失败时按“7 天磁盘缓存 → 静态 Kilo bootstrap”
回退。静态列表只用于目录不可达期间，不能把已成功目录中的付费/下线模型重新
加入选择器。

## 4. 无鉴权请求

默认配置：

```text
gatewayBaseUrl = https://api.kilo.ai/api/gateway
upstreamApiKeyEnv = ""
anonymousKey = ""
```

因此：

```text
GET  /api/gateway/models
POST /api/gateway/chat/completions
Authorization: （不发送）
```

`@earendil-works/pi-ai` 当前依赖的 OpenAI SDK 要求构造函数接收一个 key。为
保持线上无鉴权，adapter 只在进程内使用 sentinel，并将 `authorization: null`
传给 SDK 以删除其默认 Bearer 头；测试会检查实际 HTTP 请求头。

显式设置 `apiKey`、`upstreamApiKeyEnv` 或 `anonymousKey` 时才发送 Bearer token，
且仍然只允许免费目录模型。

## 5. 关联头和隐私

每轮对话由首个用户 turn 派生稳定的 SHA-256 session/project ID，每次请求使用
随机 task ID。发送的附加头是：

```text
X-KILOCODE-EDITORNAME
X-KILOCODE-TASKID
X-KILOCODE-PROJECTID
```

不发送旧 `x-opencode-*` 头，不伪装成其他客户端。请求正文会按 Kilo 的上游策略
发送；匿名免费服务可能由 Kilo 或合作方记录 prompt、输出和使用次数，用户应按
其服务条款使用。

## 6. 可选 Go sidecar

`legacy/agent` 保留一个本地 `/v1` OpenAI 兼容桥，主要用于需要进程隔离的部署。
它共享同一套 Kilo 模型记录、免费判定、`/models` 路径和“空 key 不发
Authorization”规则；本地端点仍要求插件生成的 loopback token。sidecar 不包含在
npm 发布包中。

## 7. 验收

```sh
cd packages/plugin && pnpm typecheck && pnpm test && pnpm build
cd ../../legacy && go test ./...
```

关键验收项：

- `/models` 默认请求没有 Authorization；
- free flag 为 false 的模型不会因 `:free` 名称被放行；
- chat 请求 URL 为 `/api/gateway/chat/completions`；
- SSE 文本、推理、工具调用和 usage/finish chunk 可回到 DSH；
- 目录失败时使用缓存/静态列表，并记录错误状态。

## 8. 参考资料

- [原始 OpenCode/DSH 适配原型：opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
- [Kilo Gateway Authentication](https://kilo.ai/docs/gateway/authentication)
- [Using Kilo for Free](https://kilo.ai/docs/getting-started/using-kilo-for-free)
- [Kilo Gateway API Reference](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/gateway/api-reference.md)
- [QwenPaw provider catalog](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/provider_catalog.py)
- [QwenPaw OpenAI provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
