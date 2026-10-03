<div align="center">

# kilo-zen2dsh

**在 DSH（DeepSeek Harness）中原生使用 Kilo Gateway 与 OpenCode Zen 免费模型。**

Kilo 免费层无需 Key；OpenCode Zen 是独立的兼容线路，匿名可用性由 Zen
网关决定。

[![npm](https://img.shields.io/npm/v/@huanx%2Fkilo-zen2dsh)](https://www.npmjs.com/package/@huanx/kilo-zen2dsh)
[![license](https://img.shields.io/npm/l/@huanx%2Fkilo-zen2dsh)](https://github.com/Xyanxhu/kilo-zen2dsh/blob/master/LICENSE)

[English](README.md) | 简体中文

</div>

---

`kilo-zen2dsh` 向 DSH 注册两个彼此独立的原生 `LlmAdapter`：

- `kilo2dsh`：Kilo Gateway，模型发现 `/api/gateway/models`，对话
  `/api/gateway/chat/completions`
- `opencode2dsh`：OpenCode Zen，模型发现 `/zen/v1/models`，按模型使用
  `/chat/completions` 或 `/responses`

Kilo 默认免费通道是真正的无鉴权请求：插件内部为兼容 pi-ai/OpenAI SDK 使用空
Key，并在发送前抑制 SDK 自动生成的 `Authorization` 头。Zen 兼容通道默认使用
`Bearer public` 和 OpenCode 兼容请求标记；是否允许匿名、额度和账号要求仍由
Zen 网关决定。两条线路都不绕过认证或计费。

## 特性

- 原生 adapter：发布包不拉起子进程、不监听本地端口。
- 动态免费模型目录：优先使用 Kilo 返回的 `isFree`/`is_free`；兼容
  `kilo-auto/free`、`openrouter/free` 和 `:free`/`-free` 命名。
- 独立的 OpenCode Zen 目录和 `opencode2dsh` adapter；包含文档列出的免费
  模型，并为 `muse-spark-1.2-contributor-free` 自动使用 Responses API。
- 默认只显示文本输出且支持 `tools` 的模型，适合 DSH agent 调用。
- 启动重试、周期刷新、7 天磁盘缓存和健康快照。
- 可选显式 Kilo/Zen token；默认不会读取环境中的账号密钥。

## 安装

```sh
dsh plugin --profile web add @huanx/kilo-zen2dsh
```

如果 npm 包尚未发布，可在当前代码库中打包后安装：

```sh
cd packages/plugin
pnpm install
pnpm pack
dsh plugin --profile web add ./huanx-kilo-zen2dsh-0.4.5.tgz
```

重启 `dsh web`，打开模型选择器，在 `kilo2dsh`（Kilo）或 `opencode2dsh`
（Zen）分组中选择模型即可。要求 Node.js 20 或更高版本。

## 配置

默认配置会注册 Kilo 和 Zen 两个 adapter；Kilo 线路无 Key，Zen 使用公共
兼容占位凭据：

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

如需使用已认证的兼容网关，显式设置对应的环境变量。Kilo 的
`upstreamApiKeyEnv` 和 Zen 的 `zenApiKeyEnv` 默认都为空，不会误读环境中的
其他密钥。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `adapter` | 原生 adapter；`sidecar` 是可选的旧版 Go bridge。 |
| `providerId` | `kilo2dsh` | Kilo 在 DSH 中的 provider 名称。 |
| `gatewayBaseUrl` | `https://api.kilo.ai/api/gateway` | Kilo 兼容网关地址。 |
| `refreshSeconds` | `300` | 模型目录刷新间隔（秒）。 |
| `requireTools` | `true` | 是否隐藏未声明 `tools` 的免费模型。 |
| `maxOutputTokens` | `524288` | Kilo 网关兼容输出上限；`null` 关闭该上限。逐模型输出预算由窗口自动推导，无需配置。 |
| `upstreamApiKeyEnv` | 空 | 显式指定后才从该环境变量读取 Kilo Token。 |
| `anonymousKey` | 空 | Kilo 私有兼容网关的可选 Token；为空则不发送鉴权头。 |
| `zenEnabled` | `true` | adapter 模式下是否注册 OpenCode Zen。 |
| `zenProviderId` | `opencode2dsh` | Zen 在 DSH 中的 provider 名称。 |
| `zenBaseUrl` | `https://opencode.ai/zen` | OpenCode Zen 根地址。 |
| `zenUserAgent` | 空 | 可选兼容 User-Agent；为空时按 OpenCode 格式生成。 |
| `zenApiKeyEnv` | 空 | 可选的 Zen 账号 Token 环境变量。 |
| `zenAnonymousKey` | `public` | Zen 公共占位凭据；私有无鉴权部署可设为空。 |

只使用 Kilo 时设置 `zenEnabled: false`。`sidecar` 是旧版 Go bridge，目前只
暴露 Kilo；双 provider 功能在原生 adapter 模式中提供。

## 请求行为

```text
Kilo:
  GET  https://api.kilo.ai/api/gateway/models
  POST https://api.kilo.ai/api/gateway/chat/completions
       （默认免费层不带 Authorization）

OpenCode Zen:
  GET  https://opencode.ai/zen/v1/models
  POST https://opencode.ai/zen/v1/chat/completions
       （Bearer public + OpenCode 兼容请求头）
  POST https://opencode.ai/zen/v1/responses
       （Responses-only 免费模型使用）
```

Kilo 请求使用普通 OpenAI 兼容 JSON/SSE，并附带 Kilo 关联头：
`X-KILOCODE-EDITORNAME`、`X-KILOCODE-TASKID`、`X-KILOCODE-PROJECTID`。
Zen 请求附带当前匿名线路要求的 OpenCode 兼容标记；这只是上游兼容要求，
不保证 Zen 永久接受第三方客户端。

免费模型筛选顺序：

1. 有 `isFree`/`is_free` 时以服务端字段为准（包括显式 `false`）。
2. 没有字段时，Kilo 接受 `kilo-auto/free`、`openrouter/free` 及以 `:free` 或
   `-free` 结尾的 ID；Zen 接受文档中的 `big-pickle` 和 `:free`/`-free` ID。
3. 默认排除图片输出模型和未声明工具调用能力的模型。

### 自动校正上下文与输出上限

Kilo 模型目录的限制字段并不总是在同一层：它可能出现在顶层记录、
`top_provider` 或嵌套的 `limit(s)` 对象中，不同兼容网关的字段拼写也可能不同。
adapter 会合并这些声明并取所有正数限制中的最小值作为有效上下文窗口；输入上下文
窗口与输出预算分开计算。

当前目录把 `minimax/minimax-m3:free` 的最大输出报成 943,718，但后端实际拒绝大于
524,288 的请求。因此 adapter 对 `defaultMaxTokens` 以及发到网关前的
`max_tokens`/`max_completion_tokens` 统一施加 524,288 的网关兼容上限（模型自身更
小的限制优先）。即使 DSH 传入过大的默认值，也会自动下调，无需手工改模型配置；
同时保留目录声明的 1M 输入上下文窗口，避免因为这个错误把可用上下文一并缩小。
这个兼容上限只用于 Kilo；OpenCode Zen 仍使用自己的目录限制。

### 输出预算按窗口自动缩放

网关报的 `max_completion_tokens` 是"单次请求的输出上限"，而 DSH 把
`defaultMaxTokens` 当成"每次请求都要预留的输出预算"，两者语义并不相同。Kilo 免费
线路按 OpenRouter 习惯把上限报成上下文窗口的 90%，于是同时踩两个坑：

- 请求里要的输出和整个剩余窗口一样大，prompt + output 必然超窗，网关直接 400：
  `requested about 262507 tokens ... maximum context length is 262144`；
- 压缩插件预留同样多的 token，`contextWindow - maxTokens - headroomTokens <= 0`
  导致它算不出压力阈值，自动压缩在该生效时反而不生效。

所以 adapter 自己翻译这个数字，无需任何配置：

1. **声明预算按窗口缩放**：`defaultMaxTokens` 不超过窗口的 25%（模型更小的声明优
   先）。`qwen/qwen3.8-27b:free` 于是从 235,929 变成 65,536，为 prompt 留下
   196,608 的输入预算和 131,072 的压缩压力预算；`stepfun/step-3.7-flash:free`
   这类"输出等于窗口"的声明同样被收敛。注意压缩压力预算只对约 87,381 token 以上的窗
   口为正——compaction-basic 自己固定预留 65,536 的 headroom，更小的窗口在任何份额下
   都进不了自动压缩，这不是输出声明能解决的。
2. **每次请求再按 prompt 估算收敛**：发请求前估算输入 token，`max_tokens` 收敛到
   `窗口 - 输入估算 - 安全余量`，保证 input + output 永远进得去。pi-ai 自己也有类似
   收敛，但它一律按"4 字符/token"算，对工具负载偏乐观——这类内容靠 adapter 的估算兜
   住。
3. **估算按构造保证保守**：实测 `cl100k_base` 的真实密度从散文 5.58 字符/token 一直
   到 emoji 0.38，单一常数不可能覆盖。因此估算按空白切分成串：词长级别的串逐片段计
   费，长串再分成"代码类"（结构标点多）、"数据类"（base64/hex/ID，用元音占比判定，
   因为 `sha512-…` 完全不像单词）和"单词类"，各自用实测单价。测试里固定了 11 类内容
   的实测 token 数并断言估算**永不小于**它们——早先的版本把所有 ASCII 字母都按 4.3
   字符/token 计，base64 被低估 2.6 倍，正好重现了这套预算本该防住的 400。
4. **估算会跟着网关自校准**：每次成功响应都带网关自己的 prompt 计数，adapter 把这个
   比值折进逐模型的校准因子（指数滑动平均，钳在 `[0.5, 4]`）。估算本身刻意保守
   （标签密集的 HTML 最多 2.0 倍），而真实内容比任何已测类别更密时现在可以**向上**修
   正——之前钳到 1.0 时这做不到。折算前会把缓存命中的部分加回来：DSH 把缓存输入单独
   上报（`inputTokens` 只是未命中的那部分），否则长会话看起来会小一个数量级。
5. **实在放不下时报可识别的溢出错误**：若连最小回答都放不下，adapter 不发出注定失败
   的请求，而是返回 `CONTEXT_WINDOW_EXCEEDED`（用 pi-ai / dsh-llm 都认识的溢出措辞
   外加可操作建议：压缩本会话、换更大窗口的模型、或新开会话），让 DSH 走上下文溢出
   压缩并重试。注意 2,048 只是"判定无解"的门槛，不是输出上限：真正发出的预算是
   `窗口 - prompt - 安全余量`。

需要全局改写网关兼容上限时才有配置项：`maxOutputTokens`（默认 524,288，`null` 关
闭该兼容上限）。逐模型无需配置。

### 思考等级来自目录声明

DSH 只为"适配器在 `resolveModel()` 里声明了 `reasoning.efforts`"的模型显示思考等级
选择器。没有声明时，harness 无档可选、任何显式等级都会在发出请求前被拒，adapter 只
能用自己的默认值；而在 pi-ai 的 openrouter 思考格式下，这个默认值曾是显式的
`{"reasoning":{"effort":"none"}}`——等于把所有推理模型的思考关掉。

现在 adapter 把 Kilo 的能力表翻译成该契约：

- `supported_parameters` 里含 `reasoning`、`include_reasoning` 或
  `reasoning_effort` 的模型提供 pi-ai 的完整档位：`minimal`、`low`、`medium`、
  `high`、`xhigh`、`max`（实时目录 401 条里有 307 条符合，免费线路全覆盖）；
- 不固定 `defaultEffort`：实测 `qwen/qwen3.8-27b:free` 在不发 reasoning 字段时用的是
  它自己能给的**最强档位**，固定成更低档等于每次会话都少思考；
- `thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' }`：让"未指定等级"时
  **完全不发** reasoning 字段（而不是发成 `"none"` 关闭），同时避免 pi-ai 把 `xhigh`/
  `max` 收敛到 `high`。

实测档位梯度（同一道分步计算题，`qwen/qwen3.8-27b:free` 的 reasoning tokens）：
`none` 0、`minimal`/`low` 399、`medium`/`high` 429、`xhigh`/`max` 499、不发字段 499；
另外 4 个免费模型（`stepfun/step-3.7-flash:free`、
`nvidia/nemotron-3-super-120b-a12b:free`、`apodex/apodex-1.1-mini:free`、
`dots-studio/dots-3-note-preview:free`）对 `xhigh`/`max` 同样返回 200，所以给出全部
六档，而不是停在 OpenRouter 文档刻度上的 `high`。

档位列表在 `packages/plugin/src/adapter/catalog.ts`（`KILO_REASONING_EFFORTS`）。

注意：pi-ai 自带的 `reasoningEfforts` 设置面板和第三方思考等级滑块插件
（`dsh-better-reasoning-effort`）都写死了 `llm-pi-ai` 设置命名空间，只能管理声明在
`llm-pi-ai` 下的模型；本插件这类动态适配器 provider 没有设置命名空间，等级来自上面
的声明，并通过官方模型选择器调整。

Zen 的公开 `/v1/models` 记录目前只有最小 OpenAI 字段，实时目录成功后会替换
源码内的 bootstrap 列表；目录不可用时会使用独立的 Zen 缓存和静态列表。

## 健康状态与限额

Kilo 健康快照：`~/.kilo2dsh/adapter-status.json`，Zen 健康快照：
`~/.kilo2dsh/zen-adapter-status.json`；对应缓存为 `kilo-models.json` 和
`zen-models.json`。

匿名免费额度由 Kilo 控制并按出口 IP 限流；Kilo 当前文档说明为每个 IP 每小时
200 次。遇到 429 或模型暂时不可用时，请稍后重试、换另一个免费模型，或自行
配置认证 Token。

Zen 免费模型是限时推广，可能撤下或限流；部分部署会对非 OpenCode User-Agent
返回 `429 FreeUsageLimitError`。请将 Zen 视为尽力服务，不要向免费模型发送
敏感数据；需要账号时设置 `zenApiKeyEnv`。

旧版 sidecar 可选构建：

```sh
cd legacy
go build ./cmd/agent
go test ./...
```

sidecar 对 DSH 保留本地带 Key 的 `/v1` 接口，但访问 Kilo 上游时使用同样的
无鉴权语义和 `/api/gateway` 路径。需要 Zen 时请使用原生 adapter 模式。

## 改造来源

本项目基于 [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
的 DSH/OpenCode 适配原型改造：Kilo 是迁移目标，原有 Zen 免费层作为独立的
原生 adapter 保留，没有混入 Kilo 的无 Key 传输。Kilo、Zen 和 QwenPaw 的协议
参考见下方“参考资料”。

## 开发

```sh
cd packages/plugin
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 参考资料

- [Kilo Gateway Authentication](https://kilo.ai/docs/gateway/authentication)
- [Using Kilo for Free](https://kilo.ai/docs/getting-started/using-kilo-for-free)
- [Kilo Gateway API Reference](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/gateway/api-reference.md)
- [OpenCode Zen 文档](https://dev.opencode.ai/docs/zen)
- [OpenCode provider 源码（`apiKey: public` 免费线路）](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts)
- [OpenCode issue：Zen 匿名 User-Agent 行为](https://github.com/anomalyco/opencode/issues/42500)
- [QwenPaw Kilo provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)

## 许可证

[MIT](./LICENSE) © FishBottle7
