# Profer 代码审查风险台账

- **审查日期**：2026-07-19
- **范围**：`D:\profer\Proma-main` 当前未提交工作树；Electron Agent/IPC、服务端订阅与计费、Provider/额度、知识库 Paperpipe、构建与测试。
- **验证基线**：`bun test` 通过（354 passed）；全量 `bun run typecheck` 失败（详见 QL-01）。
- **执行边界**：第一阶段处理非 Paperpipe 的 Agent P0、订阅/订单 P0 和 TypeScript 阻断。所有 Paperpipe/论文知识库问题只登记，**暂不修改**。

## 状态定义

- `计划中`：已确认，尚未开始修复。
- `进行中`：第一阶段正在修复。
- `暂缓`：已确认但不在当前阶段修改。
- `待复核`：修复完成，等待全量验证。

---

## 第一阶段（立即处理，非 Paperpipe）

| ID | 优先级 | 状态 | 问题摘要 |
|---|---:|---|---|
| AG-01 | P0 | 已修复 | 专属 query env 凭证回归测试已覆盖，确认不改动 `process.env`。 |
| AG-02 | P0 | 已修复 | 原子 session token 抢占回归测试已覆盖，同 session 第二次占用被拒绝。 |
| AG-03 | P0 | 已修复 | token 匹配释放与异常后可再次占用的回归测试已覆盖。 |
| AG-04 | P0 | 已修复 | Plan 目录路径穿越、非 Markdown 与 MCP 默认拒绝回归测试已覆盖。 |
| AG-05 | P1 | 已修复 | 删除以删除锁阻止重入，stop-and-wait 等待真实 run finally 后才清理持久化数据；并发删除合并。 |
| AG-06 | P1 | 已修复 | SEND_MESSAGE 在镜像/运行副作用前校验 session、严格 workspace 归属及 enabled channel；保持合法渠道切换。 |
| AG-07 | P2 | 计划中 | `Date.now()` 可作为重复 generation，使旧运行清理新运行。 |
| SUB-01 | P0 | 已修复 | 路由级 BDD 测试确认自助 upgrade 返回 409，不能直接改权益。 |
| SUB-02 | P0 | 已修复 | 事务失败注入测试确认 tier 降级失败时订阅销毁整体回滚。 |
| SUB-03 | P1 | 已修复 | 金额篡改测试确认订单保持 pending，且不发权益或积分。 |
| SUB-04 | P2 | 已修复 | 已覆盖提前续费保留到期日、首购 bonus 仅一次和 cycle 持久化。 |
| QL-01 | P0 | 已修复 | 已修复全部报告的 Electron TypeScript 错误；全量 typecheck 已通过。 |

### AG-01：并发 Agent 的全局凭证串扰

- **定位**：`apps/electron/src/main/lib/agent-orchestrator.ts:704-730, 1899-1905, 265-274`
- **触发**：两个不同 session 同时使用不同渠道运行；运行会写同一组 `ANTHROPIC_*` 全局变量，任一运行结束再删除它们。
- **影响**：请求可能走错 Base URL/认证方式/API Key，正在运行的另一会话会随机失去凭证。
- **修复方向**：不按请求修改 `process.env`；凭证仅写入单次 SDK `env`。若 SDK 存在不可替代的全局读取点，必须显式串行化。
- **验收**：不同 session 并发、使用不同 API Key/Base URL 时，单次 SDK 环境彼此独立，结束顺序不影响另一会话。

### AG-02：同 session 并发启动

- **定位**：`agent-orchestrator.ts:535-541, 616-617, 647-654`
- **触发**：同一 session 的两个商业渠道请求都在 `getTeamAuthWithRefresh()` 期间通过 active 检查，随后分别启动。
- **影响**：同一 JSONL 中交错写消息与工具结果，resume 历史/前端事件损坏。
- **修复方向**：同步输入校验后、任意 `await` 前，以不可重复 run token 原子抢占；统一 finally 释放。
- **验收**：并发两次发送仅启动一轮，另一轮收到确定的“处理中”结果。

### AG-03：异常导致会话永久卡住

- **定位**：`agent-orchestrator.ts:647-759, 1899-1913`
- **触发**：用户消息落盘、回调、环境构建或元数据写入在内层 try 之前抛错。
- **影响**：`activeSessions`、权限和队列状态残留；会话只能重启应用恢复。
- **修复方向**：槽位取得后立即进入覆盖完整生命周期的外层 try/finally；回调单独防御。
- **验收**：人为模拟落盘/回调/环境构建失败后，可立即重发消息。

### AG-04：Plan 权限边界绕过

- **定位**：`agent-orchestrator.ts:1124-1147`
- **触发**：Plan 模式用 Write/Edit 写任意 `.md`，或调用 automation/collaboration/外部 MCP。
- **影响**：计划模式可在未审批前产生文件和外部副作用。
- **修复方向**：仅允许真实路径位于 session `.context/plan/` 的 Markdown；MCP 默认拒绝，仅允许可信只读工具。
- **验收**：项目/附加目录 Markdown、目录穿越和有副作用 MCP 全部拒绝。

### AG-05：删除运行中会话未停止后台 Agent

- **定位**：`apps/electron/src/main/ipc.ts:2118-2129`、`apps/electron/src/main/lib/agent-session-manager.ts:511-597`
- **影响**：已删除会话仍可写 JSONL/调用工具，造成孤儿文件与不可预期副作用。
- **修复方向**：删除前 stop-and-wait，并使用 deleting 状态阻止并发操作。

### AG-06：IPC session 归属未校验

- **定位**：`apps/electron/src/main/ipc.ts:2488-2499`、`preload/index.ts:1754-1756`
- **影响**：不存在 session 或错配 workspace/channel 仍可运行，历史、工作目录与凭证错配。
- **修复方向**：以 session meta 为权威，主进程验证 session 存在和归属；配置变更走独立接口。

### AG-07：`Date.now()` generation 碰撞

- **定位**：`agent-orchestrator.ts:650, 669-675, 1922-1928`
- **影响**：同毫秒 stop/restart 时，旧 finally 可能清理新运行状态。
- **修复方向**：使用 `randomUUID()` 或单调递增的不可复用 token。

### SUB-01：自助升级绕过支付

- **定位**：`server/src/routes/account/subscription.js:57-77`、`server/src/db/subscription.js:338-352`
- **影响**：普通 JWT 可直接把 active 套餐切到 Pro，获得权益与高 drip。
- **修复方向**：用户接口不得直接改 entitlement；改为创建支付订单或明确暂不提供自助升级；支付确认/受控后台事务才可生效。
- **验收**：普通用户调用 upgrade 不改变 plan、tier、drip。

### SUB-02：destroy 后权益不撤销

- **定位**：`subscription.js:50-54`、`db/subscription.js:317-321`、`scheduler.js:120-140`
- **影响**：destroy 状态不再被到期任务扫描，用户可能永久保留 Plus/Pro。
- **修复方向**：明确为“到期不续费”或“立即取消”；在同一事务维持订阅状态与 membership tier 一致。
- **验收**：destroy 和自然到期后均不保留付费 tier。

### SUB-03：订单金额与套餐权益脱钩

- **定位**：`server/src/routes/admin/orders.js:43-82`、`server/src/db/subscription.js:198-213`
- **影响**：管理员误操作/账号被盗时可用低金额发放高价值套餐，无法对账。
- **修复方向**：服务器按 plan/cycle/VIP 计算不可变价格快照；创建、确认均核验；客户端金额不可作为订阅价格来源。
- **验收**：低于服务端价格的订阅订单被拒绝，正确价格订单可确认。

### SUB-04：续费期限和首购奖励错误

- **定位**：`server/src/db/subscription.js:207-240`
- **影响**：提前续费丢失剩余有效期；每次续费重复给首购红包；cycle 可能错误回退。
- **修复方向**：`expires_at=max(now, oldExpires)+duration`；仅首次发 welcome bonus；持久化 cycle。

### QL-01：TypeScript 发布阻断

- **定位**：
  - `apps/electron/src/main/ipc.ts:5262`
  - `apps/electron/src/preload/index.ts:2781,2786`
  - `apps/electron/src/renderer/components/agent/ProjectGraphPanel.tsx:80`
  - `apps/electron/src/renderer/components/agent/TeamActivityFeed.tsx`
  - `apps/electron/src/renderer/components/diff/DetachedPreviewApp.tsx:70`
  - `apps/electron/src/renderer/components/settings/SubscriptionSettings.tsx:97-122`
- **影响**：`bun run typecheck` 不通过，阻断发布质量门禁。
- **修复方向**：修正导出类型、IPC callback 契约、null/undefined 收窄、变量初始化顺序与 Lucide icon props 类型。

---

## 本阶段验证记录

- **2026-07-19**：`PATH="$HOME/.bun/bin:$PATH" bun run typecheck`：通过（所有 workspace 包）。
- **2026-07-19**：新增 P0 专项 BDD：`agent-orchestrator-p0-guards.test.ts`（7 项）、`subscription-db.test.js`（5 项）、`routes/account/subscription.test.js`（2 项）。
- **2026-07-19**：`PATH="$HOME/.bun/bin:$PATH" bun test`：通过，368 passed / 0 failed。
- **2026-07-19**：`git diff --check`：通过。

## Paperpipe / 论文知识库（确认问题，当前暂缓、不修改）

| ID | 优先级 | 状态 | 问题摘要 |
|---|---:|---|---|
| PP-01 | P0 | 部分修复 | Paperpipe 改用独立实际 body/file 上限、PDF 魔数和 413 语义；仍为上限内完整 multipart 缓冲，流式 multipart 转发待后续。 |
| PP-02 | P1 | 部分修复 | 新 local PDF 保存 remoteId/syncState、受控 original.pdf 与最后尝试时间；上传/删除 token 防止旧回调复活。Bridge 幂等映射未部署，未开放 retry。 |
| PP-03 | P1 | 已修复 | 删除等待远端结果；远端失败保留本地并向 UI 返回结构化失败，404 按幂等成功处理。 |
| PP-04 | P1 | 已修复 | 本地 paperId 仅允许 UUID，resolve 后限定 papers 根，读取/删除无隐式创建目录。 |
| PP-05 | P2 | 已修复 | show 内容改为完整 markdown 优先，summary 仅在正文缺失时回退。 |
| PP-06 | P2 | 部分修复 | search/show 消费显式 local 来源；本地论文远端内容回退保持 local UUID/source/workbench identity。Bridge 未提供 source 时仍以兼容 arxiv 默认，待 Bridge schema 标准化。 |
| PP-07 | P2 | 已修复 | 引入单一 library snapshot，list/stats 共享集合；合法远端条目镜像持久化到 index，远端降级状态明确传给 UI。 |
| PP-08 | P2 | 部分修复（Bridge 待部署） | Profer 已支持发送 `X-Paperpipe-Internal-Key` 并记录环境契约；Bridge 源码不在仓库，尚未验证/部署同名 header 校验。 |
| PP-09 | P3 | 暂缓 | workbench 乐观更新和笔记防抖保存存在竞态/丢失。 |
| PP-10 | P3 | 暂缓 | Agent 工具描述与实际异步索引/关键词 fallback 行为不一致。 |

### 2026-07-19 第十二阶段 Paperpipe P0/P1 验证

- Paperpipe upload 采用 `PAPERPIPE_MAX_FILE_SIZE`/`PAPERPIPE_MAX_BODY_SIZE`，对 chunked 流仍由 `limitRequestBody()` 累计真实字节；错误不再被 route catch 错映射为 502。
- 本地目录解析限制为 UUID + `resolve` 根目录边界，读取/删除不再通过会创建目录的 getter；索引改用崩溃安全 JSON 读写，且不再以两个 `undefined arxivId` 合并。
- 本地 PDF 保存同步状态与 remoteId；删除等待 remoteId 对应远端响应，失败不会清除本地/UI/workbench。
- Profer 端增加 Bridge 内部密钥 header 契约、文件名/远端 ID 净化和 PDF magic bytes 检查；Bridge 校验须在宿主机另行部署，当前不标记完成。
- 验证：`bun run typecheck` 通过；`bun test` 通过（416 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第十三阶段 Paperpipe 数据一致性验证

- 远端 show 在同时存在 `summary` 和 `markdown` 时始终保留完整 markdown；摘要只在正文不存在时回退展示。
- local PDF 的远端正文 fallback 只取远端内容，保留本地 UUID、source、workbench key 与删除入口；search 对显式 `source: local` 不再强制 arXiv。
- `loadLibrarySnapshot()` 以同一合并集合生成 papers/stats，合法远端条目写入本地索引镜像；UI 使用单次 snapshot，远端失败时显示本地缓存降级提示。
- 导入受控保存 `original.pdf`，不写入用户绝对路径；上传 token 阻止删除后的异步 success/failure 回调重新创建索引记录。Bridge 幂等/lookup 未部署，因此刻意未开放重传 retry IPC/UI。
- Server search 现校验并转发 `topK` / `mode`，不再静默丢失客户端请求语义。
- 验证：`bun run typecheck` 通过；`bun test` 通过（422 passed / 0 failed）；`git diff --check` 通过。

### PP-01：上传限额和内存压力

- **定位**：`server/index.js:109-116`、`server/src/routes/services/paperpipe.js:128-160`
- **修复方向**：流式读取、累计字节限额、正确豁免 upload 路径、并发/频率/存储配额、PDF magic bytes 校验。

### PP-02 / PP-03：远端同步和删除一致性

- **定位**：`apps/electron/src/main/lib/kb-paperpipe.ts:138-222,388-410`
- **修复方向**：上传返回远端 ID 并持久化映射；删除返回 local/remote 的结构化状态，失败可重试。

### PP-04：路径穿越

- **定位**：`apps/electron/src/main/lib/config-paths.ts:759-765`、`kb-paperpipe.ts:321-340,388-405`
- **修复方向**：allowlist ID、resolve 后根目录边界校验、读取/删除函数不创建目录、覆盖 Windows/UNC/符号链接测试。

### PP-05 至 PP-10

- **定位**：`kb-paperpipe.ts:248-315,361-365,421-428`，`KnowledgeBasePanel.tsx`，`kb-workbench-service.ts`，`server/src/routes/services/paperpipe.js`。
- **修复方向**：明确 bridge schema；统一远端/本地数据快照；实现服务间签名或 mTLS；为异步同步、并发 patch、笔记 flush 和 Agent 工具事实标签补测试。

---

## 后续阶段（非 Paperpipe）

| ID | 优先级 | 状态 | 问题摘要 |
|---|---:|---|---|
| SV-01 | P1 | 已修复 | billing snapshot 已接入默认赠送、普通扣款、门禁与请求级 markup；QPU 仍明确保持部署级锚点。 |
| SV-02 | P1 | 已修复 | JWT 仅作为身份凭证；每次认证以 DB 当前停用、管理员和套餐状态生成授权快照，撤权/停用/降级立即生效。 |
| SV-03 | P2 | 已修复 | config-store 已增加有限数、范围、整数及类型校验；批量写入在 DB/cache 间保持原子性。 |
| SV-04 | P2 | 已修复 | drip 以 Asia/Shanghai 周键归属；scheduler 启动即补跑、后续每小时幂等清理跨周未领额度。 |
| SV-05 | P2 | 已修复 | 账户请求只累计当前用户 drip；全局日累计改由 scheduler 启动补跑并每小时幂等执行，订阅查询补充复合索引。 |
| SV-06 | P2 | 已修复 | 非上传请求以实际流式字节数限额，Content-Length 仅作快速拒绝；缺失或低报 header 不可绕过。 |
| SV-07 | P2 | 已修复 | `ALLOWED_ORIGIN` 缺失或空白时默认为 `none`，显式 `*` 才开启开发跨域。 |
| UI-01 | P2 | 已修复 | AgentView 已将稳定的会话优先 channelId 透传给 ContextUsageBadge，hover 可查询订阅额度。 |
| UI-02 | P3 | 已修复 | MiniMax weekly total=0 视为有效 API 字段并生成周额度窗口；仅 null/undefined 代表缺失。 |
| UI-03 | P3 | 已修复 | 普通 zhipu 不再具备 Coding Plan 额度能力或访问其接口；主进程将代理解析等内部异常收敛为保留原 provider 的额度失败结果。 |
| QA-01 | P1 | 部分完成 | 已补 Agent 删除/发送绑定/CORS 行为级 BDD；订阅状态机已覆盖，Paperpipe 回归待其修复阶段一并完成。 |

## 通用发布门禁

在任一发布前必须满足：

1. `bun run typecheck` 全绿；
2. `bun test` 全绿；
3. `git diff --check` 无错误；
4. 新增高风险状态机均有针对性测试；
5. Paperpipe 暂缓时不得混入第一阶段改动或发布提交；
6. 当前工作树含大量用户既有未提交改动，提交时必须精确暂存，禁止捎带无关文件。

### 2026-07-19 第二阶段计费统一验证

- 运行时配置优先级已收敛为 DB override > 合法环境变量默认值 > 代码安全默认值；QPU 不在线动态化。
- `request_logs` 新增 `actual_quota`、`billing_markup` 审计字段；代理进入时冻结 markup，后台补扫优先复用快照。
- Admin batch reset 改为同步三桶真账本与 `credits.balance` 镜像；Admin grant 拒绝非正安全整数。
- 验证：`bun run typecheck` 通过；`bun test` 通过（377 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第三阶段 JWT 实时授权验证

- 新增最小用户授权投影；JWT 完成验签与黑名单检查后，实时读取 DB 的 `is_suspended`、`is_admin`、`membership_tier`，不再信任旧 claims。
- relay token、JWT 和 `pk_` API key 统一生成可信授权 context；API key 查询改用内连接，关联用户删除时不会出现悬挂 key 放行。
- BDD 覆盖：管理员撤权、用户停用/删除、Pro 降级为 Free 后国际模型门控、停用用户 API key。
- 验证：`bun run typecheck` 通过；`bun test` 通过（382 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第四阶段周 drip 过期验证

- `subscriptions` 增加兼容字段 `drip_week_start`，以 Asia/Shanghai 自然周周一为归属键。
- `clearWeeklyDrip()` 改为周键幂等补偿器；每日累计前也会清除旧周余额，服务错过周末或重启后不会继续累计历史未领 drip。
- scheduler 启动立即补跑，之后每小时执行；清理和审计流水处于同一事务。历史无归属周但有余额的记录按保守过期策略处理。
- BDD 覆盖上海周界、跨周清理、同周保留及重复执行幂等性。
- 验证：`bun run typecheck` 通过；`bun test` 通过（385 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第五阶段订阅请求路径性能验证

- `accrueDailyDripForUser(userId)` 只查询和处理当前用户；余额读取和领取 drip 不再扫描全站 active subscriptions。
- 全局 `accrueDailyDrip()` 保留给 scheduler：启动补跑、之后每小时执行，按累计日期幂等，确保不依赖用户访问。
- `subscriptions` 新增 `(user_id, status, created_at DESC)` 与 `(status, expires_at)` 复合索引；订阅状态与用户权益合并为单条 JOIN 查询。
- BDD 覆盖两个活跃订阅中仅 A 被累计、同日幂等且 B 不受影响。
- 验证：`bun run typecheck` 通过；`bun test` 通过（386 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第六阶段请求体限额验证

- 新增 Web Streams 请求体 limiter，按实际 chunk 字节累计；绝不先完整缓冲 body，也不信任缺失/低报的 `Content-Length`。
- `Content-Length` 仍用于快速拒绝；真实流超限统一返回 413 与 `REQUEST_BODY_TOO_LARGE`。文件上传继续使用 `files.js` 的独立 `MAX_FILE_SIZE` 流式限制。
- BDD 覆盖正常分块通过、无 header 的超限 body、非法配置与可信 Content-Length 快速拒绝。
- 验证：`bun run typecheck` 通过；`bun test` 通过（390 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第七阶段 CORS 与 Agent 会话生命周期验证

- CORS 缺省由开放 `*` 收紧为 `none`；显式 `ALLOWED_ORIGIN=*` 仍保留开发兼容。该措施仅限制浏览器跨域授权，不能替代服务端认证或 CSRF 防护。
- SEND_MESSAGE 在飞书镜像和 Agent 运行前以 session meta 校验 session 存在、workspace 严格归属及 workspace 存在性；渠道必须存在且 enabled。历史 session channel 不做严格相等判断，以兼容合法渠道切换。
- 删除会话采用 per-session deletion Promise 合并并发请求；删除锁覆盖 send/queue/headless 编排入口。运行中会话先 abort 并等待 `sendMessage` finally 的 completion，再清理交互状态和会话文件；超时会保留数据并拒绝删除。
- BDD 新增 CORS 配置隔离加载与 Agent 发送绑定校验，覆盖缺省收紧、白名单/显式通配符、session/workspace/channel 错误和合法渠道切换。
- 验证：`bun run typecheck` 通过；`bun test` 通过（394 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第八阶段 Agent 核心回归验证

- 将 SEND_MESSAGE 与删除 session 的 IPC 协调逻辑提取为可注入协调器；BDD 证明绑定失败零镜像/零运行副作用、镜像失败仍按 best-effort 执行、删除必须等 stop-and-wait 后才清理、并发删除合并、停止失败不删数据。
- CORS 决策与安全头抽到无 DB 依赖模块；BDD 覆盖 `none`、白名单、显式 `*` 与 OPTIONS 的 header 语义。修正 OPTIONS 直接返回 Response 时遗漏已设置安全/CORS headers 的实现问题。
- 验证：`bun run typecheck` 通过；`bun test` 通过（404 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第九阶段 Agent 订阅额度 Badge 验证

- AgentView 将会话优先、默认回退且防抖动的稳定 channelId 透传至 ContextUsageBadge 的 `planQuotaChannelId`；保留现有 hover 才查询、缓存 TTL 和不支持渠道不展示的语义。
- BDD 覆盖当前渠道优先、初始化短暂为空时回退最近稳定渠道、从未有渠道则不查询。
- 验证：`bun run typecheck` 通过；`bun test` 通过（407 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第十阶段 MiniMax 周额度验证

- MiniMax Token Plan 响应 mapper 对 `current_weekly_total_count` 使用 nullish 存在性判断；有效数值 0 不再被 truthiness 当作缺失，仍展示 API 提供的 weekly remaining percent。
- BDD 覆盖 weekly total=0 保留周窗口、字段缺失不虚构周窗口。
- 验证：`bun run typecheck` 通过；`bun test` 通过（409 passed / 0 failed）；`git diff --check` 通过。

### 2026-07-19 第十一阶段 智谱额度路由验证

- 将订阅额度 provider 能力集中为 shared helper；普通 `zhipu` 不再误标为 GLM Coding Plan，renderer 不展示/请求该额度，main 也在解密与网络请求前返回统一不支持结果。
- 仅 `zhipu-coding` 可以调用 Coding Plan quota endpoint；`getEffectiveProxyUrl()` 被纳入主进程 Result 边界，内部失败返回原始 provider 的 unsupported quota result，而非 IPC rejection。
- BDD 覆盖 `zhipu-coding` 支持与普通 `zhipu` 不支持的能力分流。
- 验证：`bun run typecheck` 通过；`bun test` 通过（411 passed / 0 failed）；`git diff --check` 通过。
