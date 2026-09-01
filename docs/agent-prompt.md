# kilo2dsh 实现提示（Kilo + OpenCode Zen 免费层）

> 当前实现同时保留 Kilo 迁移层和独立的 OpenCode Zen 兼容层。涉及 Zen 时以
> OpenCode 官方文档和网关返回为准，并将匿名限制视为上游策略。

目标：实现一个 DSH cordis 插件，默认注册原生 `kilo2dsh`（Kilo）和
`opencode2dsh`（OpenCode Zen）adapter，分别直连各自的 OpenAI 兼容接口。

本仓库基于 [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
的 OpenCode/DSH 原型进行改造；以下约束描述两条线路的边界。

必须保持的行为：

1. Kilo 默认免费请求不带 `Authorization`；不得向 Kilo 发送 `Bearer public`
   或 `Bearer anonymous`。只有显式 Kilo token 配置才可带 Bearer。
2. 模型目录从 `/models` 获取；优先 `isFree`/`is_free`，字段缺失时兼容
   `kilo-auto/free`、`openrouter/free`、`:free`/`-free`。
3. 默认排除图片输出和明确不支持 `tools` 的模型。
4. 上游地址固定为 gateway base，chat 路径是 `/chat/completions`（没有
   `/v1`）；DSH 本地 sidecar 路径仍可保留 `/v1`。
5. Kilo 只发送 Kilo 关联头，不携带 Zen/OpenCode 标记；匿名限额由 Kilo 按 IP
   执行。
6. 发布 npm 包不包含 Go 二进制；`legacy/agent` 只作为可选进程隔离桥。
7. Zen 使用 `/zen/v1/models`，默认 `Bearer public`、OpenCode 兼容请求头，
   `muse-spark-1.2-contributor-free` 使用 Responses API；Zen 的 User-Agent
   兼容要求不是认证绕过，必须在文档中说明可能的 429/账号限制，并保留
   `zenEnabled`/`zenUserAgent` 配置开关。

实现顺序：

```text
catalogs → ids → KiloAdapter/ZenAdapter → messages/events → apply()
         → optional Kilo sidecar
```

验证：

```sh
cd packages/plugin && pnpm typecheck && pnpm test && pnpm build
cd ../../legacy && go test ./...
```

参考：

- https://kilo.ai/docs/gateway/authentication
- https://kilo.ai/docs/getting-started/using-kilo-for-free
- https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py
- https://dev.opencode.ai/docs/zen
- https://github.com/anomalyco/opencode/issues/42500
