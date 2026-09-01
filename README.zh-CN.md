<div align="center">

# kilo2dsh

**在 DSH（DeepSeek Harness）中原生使用 Kilo Gateway 与 OpenCode Zen 免费模型。**

Kilo 免费层无需 Key；OpenCode Zen 是独立的兼容线路，匿名可用性由 Zen
网关决定。

[![npm](https://img.shields.io/npm/v/@kilo2dsh%2Fdsh-plugin)](https://www.npmjs.com/package/@kilo2dsh/dsh-plugin)
[![license](https://img.shields.io/npm/l/@kilo2dsh%2Fdsh-plugin)](https://github.com/Xyanxhu/kilo2dsh/blob/master/LICENSE)

[English](README.md) | 简体中文

</div>

---

`kilo2dsh` 向 DSH 注册两个彼此独立的原生 `LlmAdapter`：

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
dsh plugin --profile web add @kilo2dsh/dsh-plugin
```

如果 npm 包尚未发布，可在当前代码库中打包后安装：

```sh
cd packages/plugin
pnpm install
pnpm pack
dsh plugin --profile web add ./kilo2dsh-dsh-plugin-0.3.0.tgz
```

重启 `dsh web`，打开模型选择器，在 `kilo2dsh`（Kilo）或 `opencode2dsh`
（Zen）分组中选择模型即可。要求 Node.js 20 或更高版本。

## 配置

默认配置会注册 Kilo 和 Zen 两个 adapter；Kilo 线路无 Key，Zen 使用公共
兼容占位凭据：

```yaml
- id: kilo2dsh
  name: '@kilo2dsh/dsh-plugin'
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
