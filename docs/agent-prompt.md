# kilo2dsh 实现提示（Kilo 免费层）

> 这份提示取代早期 OpenCode/Zen 版本。代码改动以当前仓库实现和 Kilo
> 官方文档为准。

目标：实现一个 DSH cordis 插件，注册原生 `kilo2dsh` adapter，直连
`https://api.kilo.ai/api/gateway` 的 OpenAI 兼容接口。

本仓库基于 [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
的 OpenCode/DSH 原型进行改造；以下约束描述的是迁移后的 Kilo 行为。

必须保持的行为：

1. 默认免费请求不带 `Authorization`；不得发送 `Bearer public` 或
   `Bearer anonymous`。只有显式 token 配置才可带 Bearer。
2. 模型目录从 `/models` 获取；优先 `isFree`/`is_free`，字段缺失时兼容
   `kilo-auto/free`、`openrouter/free`、`:free`/`-free`。
3. 默认排除图片输出和明确不支持 `tools` 的模型。
4. 上游地址固定为 gateway base，chat 路径是 `/chat/completions`（没有
   `/v1`）；DSH 本地 sidecar 路径仍可保留 `/v1`。
5. 发送 Kilo 关联头，不伪装 OpenCode CLI；匿名限额由 Kilo 按 IP 执行。
6. 发布 npm 包不包含 Go 二进制；`legacy/agent` 只作为可选进程隔离桥。

实现顺序：

```text
catalog → ids → KiloAdapter → messages/events → apply() → optional sidecar
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
