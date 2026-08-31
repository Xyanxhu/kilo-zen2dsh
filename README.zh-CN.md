<div align="center">

# kilo2dsh

**在 DSH（DeepSeek Harness）中原生使用 Kilo Gateway 免费模型。**

免费层无需账号，也无需 API Key。

[![npm](https://img.shields.io/npm/v/@kilo2dsh%2Fdsh-plugin)](https://www.npmjs.com/package/@kilo2dsh/dsh-plugin)
[![license](https://img.shields.io/npm/l/@kilo2dsh%2Fdsh-plugin)](https://github.com/Xyanxhu/kilo2dsh/blob/master/LICENSE)

[English](README.md) | 简体中文

</div>

---

`kilo2dsh` 向 DSH 注册原生 `LlmAdapter`，使用 Kilo 的 OpenAI 兼容网关：

- 模型发现：`https://api.kilo.ai/api/gateway/models`
- 对话请求：`https://api.kilo.ai/api/gateway/chat/completions`

默认免费通道是真正的无鉴权请求：插件内部为兼容 pi-ai/OpenAI SDK 使用空
Key，并在发送前抑制 SDK 自动生成的 `Authorization` 头。因此默认线路不会发
`Bearer anonymous` 或其他占位 Token。免费模型的准入、路由和限额由 Kilo
Gateway 服务端决定，插件不绕过付费鉴权。

## 特性

- 原生 adapter：发布包不拉起子进程、不监听本地端口。
- 动态免费模型目录：优先使用 Kilo 返回的 `isFree`/`is_free`；兼容
  `kilo-auto/free`、`openrouter/free` 和 `:free`/`-free` 命名。
- 默认只显示文本输出且支持 `tools` 的模型，适合 DSH agent 调用。
- 启动重试、周期刷新、7 天磁盘缓存和健康快照。
- 可选显式 Kilo token；默认不会读取环境中的 `KILO_API_KEY`。

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

重启 `dsh web`，打开模型选择器，在 `kilo2dsh` 分组中选择模型即可。要求
Node.js 20 或更高版本。

## 配置

默认配置即为无 Key 的 Kilo 免费层：

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

如需使用已认证的兼容网关，显式设置 `upstreamApiKeyEnv`。保持为空是有意的，
这样不会误把 `KILO_API_KEY` 等环境变量带到免费请求中。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `adapter` | 原生 adapter；`sidecar` 是可选的旧版 Go bridge。 |
| `providerId` | `kilo2dsh` | DSH 中的 provider 名称。 |
| `gatewayBaseUrl` | `https://api.kilo.ai/api/gateway` | Kilo 兼容网关地址。 |
| `refreshSeconds` | `300` | 模型目录刷新间隔（秒）。 |
| `requireTools` | `true` | 是否隐藏未声明 `tools` 的免费模型。 |
| `upstreamApiKeyEnv` | 空 | 显式指定后才从该环境变量读取上游 Token。 |
| `anonymousKey` | 空 | 私有兼容网关的可选 Token；为空则不发送鉴权头。 |

## 请求行为

```text
GET  https://api.kilo.ai/api/gateway/models
POST https://api.kilo.ai/api/gateway/chat/completions
     （默认免费层不带 Authorization）
```

请求使用普通 OpenAI 兼容 JSON/SSE，并附带 Kilo 关联头：
`X-KILOCODE-EDITORNAME`、`X-KILOCODE-TASKID`、`X-KILOCODE-PROJECTID`。
不会伪装成 OpenCode CLI。

免费模型筛选顺序：

1. 有 `isFree`/`is_free` 时以服务端字段为准（包括显式 `false`）。
2. 没有字段时，接受 `kilo-auto/free`、`openrouter/free` 及以 `:free` 或
   `-free` 结尾的 ID。
3. 默认排除图片输出模型和未声明工具调用能力的模型。

## 健康状态与限额

健康快照：`~/.kilo2dsh/adapter-status.json`；模型缓存：同目录下的
`kilo-models.json`。

匿名免费额度由 Kilo 控制并按出口 IP 限流；Kilo 当前文档说明为每个 IP 每小时
200 次。遇到 429 或模型暂时不可用时，请稍后重试、换另一个免费模型，或自行
配置认证 Token。

旧版 sidecar 可选构建：

```sh
cd legacy
go build ./cmd/agent
go test ./...
```

sidecar 对 DSH 保留本地带 Key 的 `/v1` 接口，但访问 Kilo 上游时使用同样的
无鉴权语义和 `/api/gateway` 路径。

## 改造来源

本项目基于 [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
的 DSH/OpenCode 适配原型改造，将原有的 OpenCode/Zen 免费层迁移为 Kilo
Gateway 免费层。Kilo 和 QwenPaw 的协议参考见下方“参考资料”。

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
- [QwenPaw Kilo provider](https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py)
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)

## 许可证

[MIT](./LICENSE) © FishBottle7
