# kilo-zen2dsh 实施计划与验收

> Kilo + OpenCode Zen 双免费层（2026-09-01）。Kilo 为默认迁移目标，Zen
> 以独立 adapter 方式保留。

## 已完成

### Phase 1 — 原生 TypeScript adapters

- `catalog.ts`：Kilo `/models` 与 Zen `/v1/models` 动态目录、各自的免费判定、
  缓存和静态 bootstrap。
- `ids.ts`：稳定 conversation/project ID、随机 request ID、Kilo 与 OpenCode
  两套请求头。
- `kilo-adapter.ts`：通用 pi-ai OpenAI-compatible provider、Kilo keyless SDK
  兼容、按模型 API 选择，以及最终请求的 max-token 保护。
- `catalog.ts`：归一化多种上下文/输出限制字段；在目录误报时为 DSH 提供安全的
  `defaultMaxTokens`。
- `zen-adapter.ts`：Zen URL、`Bearer public`、OpenCode 兼容头，以及 Responses
  API 模型路由。
- `messages.ts` / `events.ts`：DSH 与 pi-ai 消息/chunk 转换。
- `index.ts`：默认注册 Kilo (`kilo2dsh`) 和 Zen (`opencode2dsh`) 两个 provider，
  独立刷新健康快照。
- 默认 Kilo 线路为空 Key 且实际 HTTP 请求无 `Authorization`；Zen 的 public
  占位凭据可通过配置覆盖或关闭。

验收命令：

```sh
cd packages/plugin
pnpm typecheck
pnpm test
pnpm build
```

### Phase 2 — 可选 Go sidecar

- `legacy/internal/catalog` 解析 Kilo 模型记录并执行免费过滤。
- `legacy/internal/gateway` 保留本地 `/v1` 面，向上游使用 Kilo `/models` 和
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

1. 在 DSH 实例中做一次真实 UI 端到端验证（两个 provider 的模型选择、工具调用、
   长 SSE）。
2. 若需要分发 sidecar，再增加各平台预编译包；默认 npm 包仍只发布 TS adapters。
3. 按 Kilo/Zen 目录变化定期校准静态 bootstrap；动态目录成功后始终优先。
4. 若 Zen 官方开放稳定的第三方免费认证流程，可移除对兼容 User-Agent 的依赖。

## 风险边界

- Kilo 和 Zen 免费模型、合作方路由与活动期限会变化，目录筛选不等同于服务端
  永久保证。
- 匿名请求可能按出口 IP、User-Agent、账号状态或活动规则限流；429 应直接展示给
  用户并允许切换 provider。
- Zen 当前部分部署对非 OpenCode User-Agent 返回 `429 FreeUsageLimitError`；项目
  记录该行为并提供 `zenEnabled` 开关，不把它当作认证绕过。
- 不能把 `isFree: false` 的记录因名字含 `free` 放行。
- 目录误报的输出上限不能直接传给上游；MiniMax-M3 等模型必须经过网关兼容上限
  校正，并在最终 payload 再次检查。
- 不轮换出口、不隐藏上游错误、不承诺免费模型的内容保留策略；调用前请阅读服务
  条款并避免发送敏感数据。

## 参考

- https://github.com/FishBottle7/opencode2dsh（原始 DSH/OpenCode 适配原型）
- https://kilo.ai/docs/gateway/authentication
- https://kilo.ai/docs/getting-started/using-kilo-for-free
- https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/gateway/api-reference.md
- https://dev.opencode.ai/docs/zen
- https://github.com/anomalyco/opencode/issues/42500
- https://github.com/agentscope-ai/QwenPaw/blob/main/src/qwenpaw/providers/openai_provider.py
