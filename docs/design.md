# kilo-zen2dsh 架构设计

> 版本：Kilo + OpenCode Zen 双免费层（2026-09-01）。Kilo 是默认迁移目标，
> Zen 作为独立兼容 provider 保留。

## 1. 定位

`kilo-zen2dsh` 是一个 DSH cordis 插件：在 DSH 进程内注册 Kilo 和 OpenCode Zen
两个 provider，分别发现各自网关的免费模型，并以 OpenAI 兼容流式协议返回
结果。发布包默认不需要 Go 二进制。

服务端负责免费准入、合作方路由、账号策略和限流；插件只做目录筛选与协议适配，
不尝试绕过付费鉴权。

## 2. 数据流

```text
┌──────────────┐   registerAdapter   ┌──────────────┐
│ DSH / dsh-llm│ ───────────────────▶ │ KiloAdapter  │ ──┐
└──────────────┘                     └──────────────┘   │
             └──────────────────────▶ ┌──────────────┐   │ pi-ai
                                      │ ZenAdapter   │ ──┘
                                      └──────┬───────┘
                                             │
                  ┌──────────────────────────┴─────────────────────────┐
                  │ Kilo Gateway                 OpenCode Zen           │
                  │ /api/gateway/models         /zen/v1/models          │
                  │ /api/gateway/chat/...       /zen/v1/chat/...        │
                  │                               /zen/v1/responses     │
                  └─────────────────────────────────────────────────────┘
```

两个目录分别刷新并写入独立状态文件；任何一个上游不可用都不阻塞 DSH 启动。

## 3. 免费模型判定

### Kilo

1. `isFree` / `is_free`：字段存在时完全服从（`false` 不能被名称覆盖）；
2. 字段缺失时接受 `kilo-auto/free`、`openrouter/free`、`*:free` 与 `*-free`；
3. 排除图片输出和明确不支持 `tools` 的记录。

### OpenCode Zen

Zen `/v1/models` 当前只返回最小 OpenAI 记录，通常没有价格或 `isFree` 字段。
因此：

1. 若未来返回 `isFree` / `is_free`，字段优先；
2. 接受官方文档列出的 `big-pickle` 例外及 `:free` / `-free` 后缀；
3. `muse-spark-1.2-contributor-free` 映射到 Responses API，其余已知免费 ID
   默认映射到 Chat Completions；记录中的 `api`/`protocol`/`endpoint` 可覆盖
   该默认值。

实时目录成功后是唯一权威来源；失败时按“7 天磁盘缓存 → 对应静态 bootstrap”
回退。静态列表不会覆盖已经成功目录中的付费或下线记录。

## 4. 认证与请求

### Kilo

```text
gatewayBaseUrl = https://api.kilo.ai/api/gateway
anonymousKey   = ''

GET  /models
POST /chat/completions
Authorization: （默认不发送）
```

pi-ai/OpenAI SDK 构造需要非空 key，Kilo adapter 仅在内存中使用 sentinel，并以
`authorization: null` 清除 SDK 默认头。显式设置 token 才发送 Bearer。

### OpenCode Zen

```text
zenBaseUrl     = https://opencode.ai/zen
zenAnonymousKey = public
zenUserAgent   = ''  (empty derives the OpenCode-compatible format)

GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
Authorization: Bearer public（默认）
```

Zen 请求附带 `x-opencode-client: cli`、session/request/project 关联头和可配置
的 `opencode/<version>` User-Agent。该标记是当前网关的兼容要求，不是认证绕过；
匿名资格、IP 配额、活动期限和账号要求仍由 Zen 服务端决定。

## 5. 关联头与隐私

每轮对话由首个用户 turn 派生稳定的 SHA-256 session/project ID，每次请求使用
随机 request ID；正文不会写入 ID。Kilo 发送 `X-KILOCODE-*`，Zen 发送
`x-opencode-*`。免费上游可能记录 prompt、输出和使用次数，调用方应遵守各服务
条款并避免提交敏感数据。

## 5.1 模型能力校正

Kilo 的 live `/models` 元数据是动态的，且不同上游可能把上下文/输出限制放在
顶层、`top_provider` 或 `limit(s)` 中。`modelInfo()` 将兼容字段归一化，取最小
正数上下文限制；输出预算再与上下文窗口和当前网关兼容上限取最小值。对于
MiniMax-M3 免费记录，目录曾报告 943,718 个输出 token，而实际后端上限为
524,288，因此 Kilo 的 `resolveModel().defaultMaxTokens` 和最终 OpenAI payload 都
会自动下调到安全值。输入上下文窗口仍按目录能力保留，不把输出兼容上限误当成
输入窗口；Zen adapter 不继承这个 Kilo 专用上限。

## 6. 生命周期与缓存

`index.ts` 在 adapter 模式下立即注册两个 provider，然后异步执行目录刷新。每个
`ModelCatalog` 都有启动重试、周期刷新、7 天缓存和 `stop()` 清理；Cordis effect
负责插件卸载时停止定时器。状态文件分别为：

```text
~/.kilo2dsh/adapter-status.json
~/.kilo2dsh/zen-adapter-status.json
```

设置 `zenEnabled: false` 时只创建 Kilo catalog。若 provider ID 冲突，Zen 会被
跳过并记录 warning，避免覆盖 Kilo route。

## 7. 可选 Go sidecar

`legacy/agent` 保留一个本地鉴权 `/v1` OpenAI 兼容桥，当前只实现 Kilo 上游；它
共享 Kilo 模型记录、免费判定和“空 key 不发 Authorization”规则。双 provider
功能只在原生 adapter 模式提供，sidecar 不包含在 npm 发布包中。

## 8. 验收

```sh
cd packages/plugin && pnpm typecheck && pnpm test && pnpm build
cd ../../legacy && go test ./...
```

关键验收项：

- Kilo `/models` 和 chat 默认没有 Authorization；
- Zen `/v1/models` 使用 `Bearer public`、OpenCode 兼容头，且只暴露免费 ID；
- Zen Responses-only 模型请求 `/v1/responses`；
- 两个 provider 的目录、缓存和状态文件互不覆盖；
- free flag 为 false 的模型不会因 `:free` 名称被放行；
- SSE 文本、推理、工具调用和 usage/finish chunk 可回到 DSH。

## 9. 参考资料

- [原始 OpenCode/DSH 适配原型：opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
- [Kilo Gateway Authentication](https://kilo.ai/docs/gateway/authentication)
- [Using Kilo for Free](https://kilo.ai/docs/getting-started/using-kilo-for-free)
- [Kilo Gateway API Reference](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/gateway/api-reference.md)
- [OpenCode Zen documentation](https://dev.opencode.ai/docs/zen)
- [OpenCode provider source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts)
- [OpenCode issue #42500: Zen anonymous User-Agent behavior](https://github.com/anomalyco/opencode/issues/42500)
- [QwenPaw provider catalog](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/provider_catalog.py)
- [QwenPaw OpenAI provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
