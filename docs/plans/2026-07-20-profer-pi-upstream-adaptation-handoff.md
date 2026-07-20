# Profer 适配官方 Proma Pi 架构：开发交接文档

> **用途**：这是 Pi 上游适配工作的长期恢复入口。任何新会话、上下文压缩后的续做，或新的开发者，都应先读本文件，再读关联计划与当前 Git 状态。
>
> **最后更新**：2026-07-21 01:27 GMT+8
>
> **实施分支**：`feature/pi-upstream-adaptation-20260720`
>
> **隔离工作树**：`D:/profer/Profer-pi-upstream-adaptation`
>
> **Profer 基线**：`565c826e` — `feat(agent): add Pi runtime toolbar switch`
>
> **官方参照**：`D:/profer/Proma-main@6b23a274` — `fix(agent): enable thinking by default (#1220)`

---

## 1. 任务目标与正确策略

目标是把官方 Proma 最新 Pi Agent 架构中的**可靠性、兼容性和可维护性改进**适配到 Profer。

这不是将官方 Proma 覆盖、整仓 merge、rebase 或按文件 cherry-pick 的任务。Profer 已在 Pi 初次迁移后深度演进，包含 Paperpipe、知识库 allowlist、任务图、团队工作区、商业渠道、`auto` 权限、双构建目标和 Windows 发布门禁。正确策略是：

> 以 Profer 当前实现为基线，按主题手工前移官方 Pi 修复；每个主题独立提交、独立验证、随时可回滚。

禁止：

- 用官方版本整文件替换 `agent-orchestrator.ts`、`agent-session-manager.ts`、`main/ipc.ts`、`preload/index.ts`、`AgentView.tsx`、`pi-builtin-tools.ts`；
- 对 `Profer-main` 做 `reset`、`stash`、`clean`、`checkout` 或覆盖式修改；
- 复制官方整份 `package.json`、`bun.lock`、`electron-builder.yml`、release workflow；
- 在未验证前启用 Pi fork/rewind UI；
- 批量重写用户 session JSONL、用户配置目录或历史 thinking 状态；
- 未获明确批准就 push、merge、tag、release 或部署。

---

## 2. 当前状态（已完成）

### 2.1 10 路只读架构审计已完成

已并行审计以下方向并汇总为实施计划：

1. Pi runtime 生命周期、模型、工具和 session 路由；
2. Pi SDK 版本、patch、lockfile 与打包闭包；
3. MCP、Skills、内置工具和权限；
4. session 存储、JSONL、恢复、并发、中断、memory；
5. renderer 的流式消息、thinking、工具调用、会话切换；
6. IPC/preload/Electron 边界与安全；
7. Proma/Profer 的 Pi 历史与迁移基线；
8. Profer 特有功能和 Paperpipe 保护范围；
9. 构建、测试、Windows 打包、CI 门禁；
10. 对抗性风险审查与回滚路线。

完整的原始执行计划保留在当前 Agent 会话的：

```text
.context/plan/2026-07-20-profer-pi-upstream-adaptation.md
```

本文件是面向仓库的长期、精简版执行入口；若当前会话目录已不可用，以本文件为准继续。

### 2.2 已建立隔离工作树

主工作树：

```text
D:/profer/Profer-main
```

当前有用户未提交的产品改动，**不得清理或覆盖**：

- `apps/electron/package.json`：版本 `0.14.56 → 0.14.58`；
- `apps/electron/src/renderer/components/settings/AppearanceSettings.tsx`：暂时隐藏 macOS Dock 图标设置；
- `scripts/push-release.cjs`：旧直连发布脚本 externalize Pi runtime 依赖；
- `.context/*.log` / `*.pid`：运行产物，不应纳入代码提交。

已将上述 3 处受控产品改动带入隔离迁移分支，并形成独立本地提交：

```text
31d70c78 chore: preserve pending Profer product changes
```

因此后续在隔离 worktree 中开发时，适配目标是：

```text
Profer 已提交代码 + 上述未提交产品改动 + 官方 Proma Pi 修复
```

### 2.3 当前实施进度

- [x] 阶段 0a：建立隔离 worktree / 分支。
- [x] 阶段 0b：把受控未提交产品改动纳入隔离分支。
- [x] 阶段 0c：基线 `bun install --frozen-lockfile`、全 workspace typecheck、65 个 Pi/Profer 重点测试、OSS/Commercial main build 和 target verifier 已通过；当前 Proma Bash 无 `node`，Node-native Server 门禁待具备 Node 的环境补跑。
- [x] 阶段 1：3 个子代理切片已由父会话审查并整合：Pi partial/final UUID upsert、session model create/update 持久化与 active-state 双层保护、runtime metadata snapshot rollback、敏感 Agent IPC 主窗口 sender guard。整合后重点测试 23 passed、全 workspace typecheck、OSS/Commercial main build、preload/renderer build 和 `git diff --check` 均通过；renderer build 仅有既存大 chunk 警告。
- [x] 阶段 2：Pi `0.80.9` 原子依赖升级与 Windows 打包闭包。依赖/API 提交 `bdb0e45e`，打包闭包提交 `c807b060`；四个 Pi 包均精确锁定为 `0.80.9`，旧 `pi-ai@0.80.3` patch 已移除。Pi 0.80.9 的 `ModelRuntime`/credential store API 已接入 session-local Codex OAuth 凭据与刷新回写，保留自定义 provider、OpenAI Responses、团队 token、DeepSeek 1M 与 Fast Mode 路径。Windows asarUnpack 已补 Pi 的三组 native scopes，legacy 发布入口会先 `sync:runtime-deps`，并新增离线 packaged Pi probe。
- [ ] 阶段 3：request-local proxy、Pi native retry 与副作用幂等。Codex OAuth 的 0.80.9 credential store/refresh persistence 已作为阶段 2 API 兼容最小闭包完成；request-local OAuth proxy 仍明确后置。
- [ ] 阶段 4：Pi artifact metadata 与旧会话兼容。
- [ ] 阶段 5+：fork/rewind、MCP registry、session reasoning/default thinking、可选 UI（均需二次确认）。

---

## 3. 关键事实与首要修复

### 3.1 Profer 已有的 Pi 能力，不能重新迁移

Profer 已在 `5c01cb4d` 等提交中完成第一轮 Pi 双 runtime 适配，并在 `565c826e` 增加 toolbar runtime switch。现有能力包括：

- Pi Agent adapter、runtime router、用户 MCP bridge；
- Automation、Collaboration、Web tools；
- Profer 知识库与任务图 Pi 工具；
- runtime credential isolation、Codex Fast Mode、DeepSeek 1M 适配；
- stop-and-wait、删除锁、run token、runtime send binding；
- Pi JSONL header 精确匹配与删除隔离；
- OSS / Commercial 双构建与 runtime dependency sync；
- Paperpipe 发布门禁。

官方上游是“补齐后续可靠性”，不是替代 Profer 架构。

### 3.2 P0：Pi 流式消息被 renderer 错误去重

位置：

```text
apps/electron/src/main/lib/adapters/pi-agent-adapter.ts
apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts
```

Pi 会用同一个 UUID 发送多帧：

```text
partial(uuid=A, text=a)
partial(uuid=A, text=abc)
final(uuid=A, text=abcdef)
```

当前 Profer renderer 对已存在 UUID 直接丢弃后续帧，可能让 UI 停在首个 partial，最终帧也不显示。第一阶段应以官方 upsert 逻辑为参考修复：

- partial 更新替换已有 partial；
- final 替换已有 partial；
- 只有 final 重复 final 才去重；
- 保留 Profer 的 graph、knowledge、background waiting、preview 副作用。

### 3.3 P0：Pi 依赖当前不是可复现统一组合

官方验证组合：

```text
@earendil-works/pi-agent-core   0.80.9
@earendil-works/pi-ai           0.80.9
@earendil-works/pi-coding-agent 0.80.9
@earendil-works/pi-tui          0.80.9
```

Profer 当前：前三项 `0.80.3`，但 lockfile 解析出的 `pi-tui` 为 `0.80.10`，并有只适用于 `pi-ai@0.80.3` 的 OAuth patch。

依赖升级必须是一个原子切片：manifest + controlled lockfile + patch 退出/替代 + ModelRuntime API 适配 + runtime closure + package smoke。禁止只改版本号、混装 Pi 包，或将旧 patch 强行重命名应用到 `0.80.9`。

### 3.4 P0：Pi native retry 不能沿用外层 prompt replay

官方后续通过 native retry 保留同一 Pi transcript/tool results；Profer 外层 retry 若重发原 prompt，可能重复执行：

- `delegate_agent` / `delegate_agents`；
- automation create / run；
- task graph create / update；
- 各类写文件、外部服务或自定义 MCP 工具。

迁移 Pi native retry 时必须同时引入 terminal gate 与按 `sessionId + toolCallId` 的幂等保护；不能单独将 `retry.enabled` 打开。

---

## 4. 不可回退的 Profer 行为契约

### Agent / session / runtime

必须保留：

- `runtime-routing-agent-adapter.ts` 的 runtime 隔离、错误路由和 token 化生命周期；
- `agent-send-binding.ts` / `agent-send-coordinator.ts` 的 workspace/channel/model/runtime 校验和先占用 active slot；
- runtime switch 时清除上一 runtime 的 resume/fork 指针；
- stop-and-wait、deletion lock、run token，避免旧 finally 清除新运行；
- Pi artifact 的首行 header 精确 ID 匹配，禁止文件名 substring 随机匹配；
- 删除 fork 时不可删除 `forkSourceSdkSessionId` 指向的 source artifact；
- `profer_event` event brand；
- Profer 的 `auto | bypassPermissions | plan` 权限模式及 `approve_auto` / `approve_edit` Plan action。

### 知识库、任务图、Paperpipe

必须保留：

- `pi-builtin-tools.ts` 中 Knowledge Base 的 session-scoped allowlist；
- 已删除/撤销 knowledge 不能读取；
- Paperpipe remoteId 只能来自当前索引，不能把任意 itemId 当远端 paper ID；
- Task Graph create/update 业务语义；
- Paperpipe 当前 50 MiB 上限与只重试 network/502/504 的可靠性规则；
- Electron → Server → Bridge 的现有安全边界、Bridge secret、路径/PDF 校验；
- `server/**`、`server/deploy/paperpipe-*` 不属于本任务的常规改动范围。

### 构建与产品

必须保留：

- `@profer/*` 包名、Profer appId、`~/.profer` / `~/.profer-dev` 数据隔离、`profer-file://`；
- OSS / Commercial build target；
- Profer `sync-runtime-deps.ts` 的版本冲突与 symlink 保护；
- Profer release workflow 的 Bun 1.3.14、Node 24、test/typecheck/package/smoke 门禁；
- Windows packaged smoke 与 Paperpipe 发布门禁。

---

## 5. 分阶段执行顺序

## 阶段 0：基线验证（下一步）

在：

```bash
cd D:/profer/Profer-pi-upstream-adaptation
```

运行并记录，不通过就停止扩大范围：

```bash
git status --short --branch
git diff --check
bun --version
bun install --frozen-lockfile
bun run typecheck
bun test apps/electron/src/main/lib/adapters \
  apps/electron/src/main/lib/agent-session-manager.pi-runtime.test.ts \
  apps/electron/src/main/lib/agent-send-binding.test.ts \
  apps/electron/src/main/lib/agent-send-coordinator.test.ts \
  apps/electron/src/main/lib/kb-paperpipe-mapping.test.ts \
  apps/electron/src/main/lib/kb-paperpipe-paths.test.ts \
  apps/electron/src/main/lib/kb-paperpipe-retry-utils.test.ts \
  --timeout 30000
bun run server:test:node
cd apps/electron && bun run build:main-github && bun run verify:build-target:oss
cd apps/electron && bun run build:main-commercial && bun run verify:build-target:commercial
```

说明：Server 门禁须分别报告 Bun 与 Node-native 测试，不能把旧记录中的“Node 111 passed”直接当当前 runner 事实。

## 阶段 1：流式与 session contract

独立提交、小步实现：

1. Pi partial/final UUID upsert；
2. session `modelId` 从 create / update IPC 持久化；
3. stream/backgroundWaiting 时禁止 model/runtime/reasoning 切换，前端和主进程双重保护；
4. runtime switch 使用完整 metadata snapshot rollback；
5. 逐步加主窗口 sender guard，禁止辅助窗口发 Agent/permission 敏感 IPC。

建议提交：

```text
fix(agent): upsert Pi partial stream frames
fix(agent): persist session model and guard active changes
fix(agent): make runtime switch rollback metadata-safe
```

## 阶段 1 已整合提交

```text
aef951a5 fix(renderer): upsert Pi partial stream messages
215683db fix(agent): restore runtime metadata and guard sensitive IPC
9a1f88cd fix(agent): satisfy strict types for Pi safety updates
134c9247 fix(agent): persist session model and guard active changes
```

整合后追加：`UPDATE_SESSION_MODEL` 也进入主窗口 sender guard；不得让 Quick Task、Voice Dictation 或 Detached Preview 修改主会话模型。

## 阶段 2：Pi 0.80.9 依赖闭包

1. 升级四个 Pi 包到统一 `0.80.9`；
2. 受控重解析 `bun.lock`，不复制官方 lock；
3. 移除/替代精确 `0.80.3` patch；
4. 适配 `pi-model-registry.ts` 的 `ModelRuntime` API；
5. 验证 OSS / Commercial main build、runtime sync、native unpack 和 Windows package。

停止条件：Pi 四包未全锁 `0.80.9`、lock 出现无关大范围漂移、OAuth/fast mode/custom providers 失败、任何 build target verifier 失败。

### 阶段 2 已整合提交与验证

```text
bdb0e45e fix(agent): upgrade Pi runtime dependency closure
c807b060 fix(build): close Pi runtime package dependencies
```

已通过：

```text
bun install --frozen-lockfile
bun test apps/electron/src/main/lib/adapters apps/electron/src/main/lib/agent-session-manager.pi-runtime.test.ts apps/electron/src/main/lib/agent-send-binding.test.ts apps/electron/src/main/lib/agent-send-coordinator.test.ts --timeout 30000  # 62 passed
bun test apps/electron/scripts/package-closure.test.ts apps/electron/src/main/lib/adapters/pi-model-registry.test.ts --timeout 30000  # 22 passed
bun run typecheck
cd apps/electron && bun run build:main-github && bun run verify:build-target:oss
cd apps/electron && bun run build:main-commercial && bun run verify:build-target:commercial
cd apps/electron && bun run build:preload && bun run build:renderer
```

`git diff --check` 通过。

### 2026-07-21 Windows 打包验证（不发布）

本机已定位并会话级使用 `C:\Program Files\nodejs\node.exe`（v24.15.0）。为避免 Proma 的 Bun shell shim 无法被子进程再次解析，`apps/electron/scripts/build-cli.ts` 改为使用 `process.execPath` 调用当前 Bun 可执行文件；不依赖 PATH 中的 `bun`。

已通过：

```text
bun run server:test:node  # 18 passed
bun run build:github
bun run sync:runtime-deps  # 136 个 runtime 依赖同步
bun x electron-builder --win --x64 --publish never
ELECTRON_RUN_AS_NODE=1 out/win-unpacked/Profer.exe scripts/packaged-pi-probe.cjs out/win-unpacked/resources
```

生成但未发布的安装包：`apps/electron/out/Profer-Setup-0.14.58.exe`。packaged probe 成功从 `app.asar` 导入四个 Pi `0.80.9` 包，验证 `ModelRuntime.create`、自定义 provider 注册和 `SessionManager` 初始化，并确认 `app.asar.unpacked` 内有 7 个 Pi native/wasm 文件。未执行 push/tag/release/部署。

## 阶段 3：proxy、OAuth、native retry

1. 新增 request-local `pi-request-proxy.ts`；仅包 model provider stream，不污染 MCP/Paperpipe/web 等工具网络；
2. 合并 Codex OAuth credentials / refresh / channel persist；
3. 新增 `pi-retry-control.ts`，native retry 与 terminal gate；
4. 为 collaboration、automation、task graph 等有副作用工具建立幂等测试；
5. Pi 不再通过外层 retry replay 原 prompt；Claude 保持原有策略。

停止条件：proxy 串会话、重试重复副作用、OAuth 写错 channel 或不持久化、UI 终态但 Pi 后台还活跃。

## 阶段 4：Pi artifact metadata

只增、向后兼容地加入：

```ts
piSessionFile?: string
piEntryBindings?: Record<string, string>
```

实现新 Pi session 的精确 artifact 回调/持久化；读取时先验证 metadata path 的 header，再 fallback 递归精确扫描。旧会话继续使用 fallback，但 metadata/binding 缺失时 fork/rewind 必须 fail-closed。

本阶段明确不暴露 fork/rewind UI、不重写历史 JSONL、不迁移用户目录。

## 阶段 5+（必须再次确认）

仅在 0–4 全部绿且 packaged Pi probe 通过后考虑：

- Pi native fork / rewind；
- lenient/strict JSONL parser 分层；
- builtin MCP registry 与 settings；
- session-level OpenAI reasoning；
- 官方 default thinking/high 迁移；
- 默认 Pi runtime；
- live task overlay / process-group UI 改造。

注意：默认 thinking high 改变成本与用户行为。除非专门产品决策，**不得**将历史 `off` 批量翻转到 `high`。

---

## 6. 固定测试和发布门禁

每一个 Pi 变更切片至少应按影响范围运行：

```bash
bun run typecheck
bun test apps packages --timeout 30000
bun run server:test:node
bun run electron:build:github
cd apps/electron && bun run sync:runtime-deps
npx electron-builder --win --x64 --publish never
git diff --check
```

以下 Profer 专项不能被上游测试取代：

```bash
bun test apps/electron/src/main/lib/agent-session-manager.pi-runtime.test.ts \
  apps/electron/src/main/lib/adapters/runtime-routing-agent-adapter.test.ts \
  apps/electron/src/main/lib/agent-send-binding.test.ts \
  apps/electron/src/main/lib/agent-send-coordinator.test.ts \
  apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts \
  apps/electron/src/main/lib/kb-paperpipe-mapping.test.ts \
  apps/electron/src/main/lib/kb-paperpipe-paths.test.ts \
  apps/electron/src/main/lib/kb-paperpipe-retry-utils.test.ts \
  server/src/routes/services/paperpipe-helpers.test.js --timeout 30000
```

最终必须新增 **packaged Pi probe**。现有 `Profer.exe --disable-gpu` 存活 12 秒只能证明应用没有立即退出，不能证明安装包内 Pi runtime、native addon、SessionManager 可实际加载和初始化。

---

## 7. 恢复工作时的标准步骤

任何新会话续做应按以下顺序：

1. 阅读本文件；
2. 检查隔离 worktree：

   ```bash
   git -C D:/profer/Profer-pi-upstream-adaptation status --short --branch
   git -C D:/profer/Profer-pi-upstream-adaptation log --oneline -8
   ```

3. 检查主工作树，但绝不自动清理：

   ```bash
   git -C D:/profer/Profer-main status --short --branch
   ```

4. 阅读对应阶段的 commit、测试输出和未完成项；
5. 在隔离 worktree 中继续一个完整小切片；
6. 先运行相关单测，再 typecheck，再构建/打包门禁；
7. 更新本文件中的“当前状态”、阶段 checklist、最新提交、失败/阻塞原因；
8. 仅在用户明确要求时，把验证后的适配提交三方合并到 `Profer-main`；主工作树未提交改动必须逐处保留。

---

## 8. 回滚方式

- 每一阶段独立 commit；不要将依赖、adapter、session schema、UI、Paperpipe 混在单个 commit。
- 新 metadata 保持 optional；旧应用忽略未知字段，旧 Pi session 继续 fallback lookup。
- Pi 出问题时可切回 Claude runtime，但不得跨 runtime 复用 `sdkSessionId`。
- fork/rewind 未完成验证前不开放 UI；不做不可逆 artifact 操作。
- Windows package 或 packaged Pi probe 失败即停止 release；不 push/tag/publish。

---

## 9. 关联文档

- 工作区项目状态入口：
  `C:/Users/yuan/.proma/agent-workspaces/profer/workspace-files/.context/project-status.md`
- 原始 Agent 执行计划（会话级，可能随会话清理）：
  `.context/plan/2026-07-20-profer-pi-upstream-adaptation.md`
- 旧 Pi 迁移范围说明：
  `D:/profer/Profer-main/.context/pi-runtime-migration-scope.md`
- Paperpipe 发布质量门：
  `C:/Users/yuan/.proma/agent-workspaces/profer/workspace-files/.context/paperpipe-release-gate-2026-07-19.md`
- 工作区研发原则：
  `C:/Users/yuan/.proma/agent-workspaces/profer/.claude/memory/product-engineering-principles.md`
