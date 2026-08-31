# kilo2dsh 实施计划与验收

> Kilo 免费层迁移版（2026-08-31）。旧版 OpenCode/Zen、`models.dev` 和
> `Bearer public` 方案已废弃。

## 已完成

### Phase 1 — 原生 TypeScript adapter

- `catalog.ts`：Kilo `/models` 动态目录、免费字段/后缀判定、工具/图片过滤、
  缓存和静态 bootstrap。
- `ids.ts`：稳定 conversation/project ID、随机 task ID、`X-KILOCODE-*` 头。
- `kilo-adapter.ts`：pi-ai OpenAI-compatible 流式适配。
- `messages.ts` / `events.ts`：DSH 与 pi-ai 消息/chunk 转换。
- `index.ts`：运行时 `registerAdapter`、刷新健康快照、可选 sidecar 生命周期。
- 默认线路为空 Key 且实际 HTTP 请求无 `Authorization`。

验收命令：

```sh
cd packages/plugin
pnpm typecheck
pnpm test
pnpm build
```

### Phase 2 — 可选 Go sidecar

- `legacy/internal/catalog` 解析 Kilo 模型记录并执行同一免费过滤。
- `legacy/internal/gateway` 保留本地 `/v1` 面，向上游使用 gateway `/models` 和
  `/chat/completions`。
- 空 `anonymous_key` 时不发送 Authorization；显式 token 才发送 Bearer。
- loopback 监听、随机本地 token、READY 握手和进程优雅退出保留。

验收命令：

```sh
cd legacy
go test ./...
go build ./cmd/agent
```

## 后续可选工作

1. 在 DSH 实例中做一次真实 UI 端到端验证（模型选择、工具调用、长 SSE）。
2. 若需要分发 sidecar，再增加各平台预编译包；默认 npm 包仍只发布 TS adapter。
3. 按 Kilo 目录变化定期校准静态 bootstrap；动态目录成功后始终优先。

## 风险边界

- Kilo 免费模型和合作方路由会变化，目录筛选不等同于服务端保证。
- 匿名请求按出口 IP 限流（当前文档为每 IP 每小时 200 次）；429 应直接展示给用户。
- 不能把 `isFree: false` 的记录因名字含 `free` 放行。
- 不轮换出口、不伪造其他 CLI 身份、不尝试绕过付费鉴权。

## 参考

- https://github.com/FishBottle7/opencode2dsh（原始 DSH/OpenCode 适配原型）
- https://kilo.ai/docs/gateway/authentication
- https://kilo.ai/docs/getting-started/using-kilo-for-free
- https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/gateway/api-reference.md
- https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py
