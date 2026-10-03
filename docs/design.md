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

2026-09-16 起，Zen 免费层还校验请求的「agent 会话形状」，缺失时一律
403 FreeTierError：

1. `x-opencode-session` 必须是官方格式 `ses_` + 12 位小写 hex + 14 位
   Base62（适配器把稳定会话种子规整成该形状，会话亲和保持不变）；
2. 请求体必须流式并携带五个核心 agent 工具名
   `bash`/`edit`/`glob`/`grep`/`read`（仅校验名字）。pi-ai 本身强制流式；
   纯聊天回合由 `payloadDecorator` 注入空壳工具定义，已带真实工具的请求
   只补缺失的名字。

## 5. 关联头与隐私

每轮对话由首个用户 turn 派生稳定的 SHA-256 session/project ID，每次请求使用
随机 request ID；正文不会写入 ID。Kilo 发送 `X-KILOCODE-*`，Zen 发送
`x-opencode-*`。免费上游可能记录 prompt、输出和使用次数，调用方应遵守各服务
条款并避免提交敏感数据。

## 5.1 模型能力校正

Kilo 的 live `/models` 元数据是动态的，且不同上游可能把上下文/输出限制放在
顶层、`top_provider` 或 `limit(s)` 中。`modelInfo()` 将兼容字段归一化，取最小
正数上下文限制；输出预算再与上下文窗口、当前网关兼容上限，以及窗口的 25% 取最
小值。对于 MiniMax-M3 免费记录，目录曾报告 943,718 个输出 token，而实际后端上限
为 524,288，因此 Kilo 的 `resolveModel().defaultMaxTokens` 和最终 OpenAI payload
都会自动下调到安全值。输入上下文窗口仍按目录能力保留，不把输出兼容上限误当成输
入窗口；Zen adapter 不继承这个 Kilo 专用上限。

窗口份额（`adapter/budget.ts`）解决的是另一类不一致：网关报的
`max_completion_tokens` 是单次请求上限，而 DSH 把它当作每次请求都要预留的输出预
算。免费线路按 OpenRouter 习惯报出窗口的 90%（`qwen/qwen3.8-27b:free`：235,929 /
262,144），会让请求的 input + output 必然超窗（网关 400），并让
compaction-basic 的 `contextWindow - maxTokens - headroomTokens` 变成负数而失去压
力预算。因此声明预算按窗口缩放，`stream()` 再按 prompt 估算收敛 `max_tokens`；连
最小回答（2,048，仅作"判定无解"门槛）都放不下时直接返回
`CONTEXT_WINDOW_EXCEEDED`，交给 DSH 的溢出压缩路径。

估算按内容的"串"分类计价，而不是按单一字符类别：空白切分后，词长级别的串逐片段计
费（tokenizer 对流内字母/数字/符号的切换各起一个 token），长串再按结构标点占比、数
字占比与字母元音占比（base64/hash 的元音占比只有约 20%）分成代码类、数据类和单词
类，各自用实测单价。这一层是必须的：`cl100k_base` 实测密度从散文 5.58 字符/token
到 emoji 0.38 跨度极大，早先"字母一律 4.3"的版本把 base64 低估 2.6 倍，300 KB 的
base64 工具结果估成 82K、真实 215K，于是又发出必然 400 的请求。测试因此固定了 11
类内容的实测 token 数，并断言估算永不小于它们。

网关的 `prompt_tokens` 反馈用于逐模型校准（EMA，α=0.3，钳到 [0.5, 4]）：下限修正估
算固有的保守（最坏约 2.0 倍），上限让"比任何已测类别都密"的内容也能被向上修正——
早先钳到 1.0 时这条路是堵死的。折算前必须把缓存命中部分加回去：DSH 的
`inputTokens` 只是未命中缓存的余量（pi-ai 算作 `prompt_tokens - cacheRead -
cacheWrite`），否则长会话的反馈比值会小一个数量级，把估算往不安全方向拉。另一个被
否掉的方案是把"上次上报的 prompt"直接当估算下限：上报 215K 而估算 82K 说明估算偏乐
观，上报 215K 而估算 10K 则说明会话刚被压缩，两者从数字上无法区分，猜错就会在每次
重试都拒绝一个其实放得下的 prompt，因此宁可只靠校准。

这些取舍有实测支撑：一个 1.61 MB 的散文型会话被网关计为 247,790 输入 token，旧"字
节 ÷ 3"估成 286,087（+15%），在 262,144 窗口上把约 9K 的真实回答空间算成负数而误报
溢出；反过来 pi-ai 内置的收敛一律按 4 字符/token，对 JSON/工具负载偏乐观，密集内容
仍需 adapter 自己兜住。

思考等级同理，属于"适配器必须主动声明"的能力：`dsh-llm` 只把
`resolveModel()` 返回的 `reasoning.efforts` 当作可选档位（校验 id/name 非空、id 不重
复、`defaultEffort` 必须属于其中之一），未声明时 harness 会在发请求前以
`UNSUPPORTED_REASONING_EFFORT` 拒绝任何显式等级。此前 adapter 不声明，于是官方模型
选择器对 kilo2dsh 模型没有任何档位；同时 pi-ai 的 openrouter 思考格式在"没有等
级"时会发 `{"reasoning":{"effort":"none"}}`，把推理模型的思考静默关掉。现在按目录
的 `supported_parameters`（`reasoning` / `include_reasoning` / `reasoning_effort`）
声明 pi-ai 全量六档（minimal/low/medium/high/xhigh/max），不固定 `defaultEffort`
—— 实测网关在"不发字段"时给的是最强档位（499 reasoning tokens，与 xhigh/max 相同），
固定成低档只会让每次会话少思考；并用
`thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' }`：既让"未指定"变成"不发
字段、用 provider 默认"（而不是发成关闭），也避免 pi-ai 因未声明而把 xhigh/max 收敛
到 high。档位是否真实存在按网关实测判定（27B：minimal/low 399、medium/high 429、
xhigh/max 499；另外 4 个免费模型对 xhigh/max 均 200），而不是照 OpenRouter 文档刻度
砍档。pi-ai 自带的 `reasoningEfforts` 编辑面板与第三方滑块插件都绑定在
`llm-pi-ai` 命名空间上，动态适配器 provider 没有该命名空间，故不能复用。

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
