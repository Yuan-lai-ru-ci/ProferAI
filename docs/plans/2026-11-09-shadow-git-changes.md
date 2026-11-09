# Shadow Git 回退底座 · 改动清单（供审查）

> 生成时间：2026-11-09 12:35（GMT+8）
> 用途：审查会话逐文件核对，找出漏洞。配套交接文档 `2026-11-09-shadow-git-handoff.md`。
> **重要前提**：仓库里有大量用户并行未提交改动（`git status --porcelain` 显示约 70 个 modified）。本文档把文件分成四类，**不要按 `git status` 一刀切认定全部属于本次工作**。
>
> 分类方式：新增文件 = 未跟踪（`??`）；「我修改」= 用 `git diff` 关键词扫描（`shadow|rewind|runtimeConflict|canSelectAgentSessionRuntime|resumeAtMessageUuid|piSessionFile|transcript-audit|debug-channel`）命中且语义属于本次工作；「需核对」= 有命中但我不确定归属；「用户并行工作」= 命中属于其他功能或核对后确认不是我改的。

---

## A. 新增文件（全部为本次工作，未跟踪）

### A.1 `packages/session-store/src/shadow-git/`（13 源 + 6 测试，共 6088 行）

| 文件 | 行数 | 作用 | 审查重点 |
| --- | --- | --- | --- |
| `types.ts` | 184 | 类型、状态机、`CurrentState` 三态 | 三态定义是否覆盖所有分支 |
| `git-command.ts` | 217 | 异步 git 调用，支持 `stdoutFile` | 是否还有走字符串的内容路径 |
| `roots.ts` | 156 | 根路径、`isInsideRoot`、realpath | 最近存在祖先是否处理符号链接 |
| `exclusions.ts` | 138 | 排除规则 | 是否会误排用户文件 |
| `walk.ts` | 256 | 遍历与超大文件判定 | `partial`/`truncated` 的判定边界 |
| `tree-builder.ts` | 427 | 多根合成树（三个临时 index） | 嵌套仓库 `hash-object --no-filters` + `update-index --index-info` |
| `repository.ts` | 524 | bare 仓库、ref、commit、`ls-tree` | `previousCommitId` 必须由采集带出 |
| `journal.ts` | 431 | journal/manifest、turn 追加 | 采集与归属是否同一队列任务 |
| `queue.ts` | 93 | 串行队列 | 任务重入与异常后的队列状态 |
| `attribution.ts` | 约 400 | `diffShadowCommits`、`buildShadowTurnAttribution`、4MB 压缩 | 交集判定、`preexisting`、`rootIntroduced` |
| `reverse-patch.ts` | 559 | 逆向 patch + 三方合并 | **判定顺序即安全策略**、字节流、TOCTOU |
| `restore-journal.ts` | 84 | 回退执行日志 | pending 是否先落盘 |
| `manifest.ts` | 165 | 工作区 → 仓库映射 | 非 uuid 的 `workspaceId`（如 `default`）必须能优雅失败 |
| `index.ts` | 22 | 导出面 | 是否泄漏内部类型 |

测试：`shadow-git-attribution.test.ts`、`shadow-git-fs-layer.test.ts`、`shadow-git-git-layer.test.ts`、`shadow-git-incremental.test.ts`、`shadow-git-integration.test.ts`、`shadow-git-journal-queue.test.ts`、`shadow-git-reverse-patch.test.ts`。

### A.2 `apps/electron/src/main/lib/`（装配层，2595 行）

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `workspace-shadow-git.ts` | 248 | 工作区路径、托管工作区、仓库初始化；`beginWorkspaceShadowTurn` / `endWorkspaceShadowTurn` 的宿主侧 |
| `workspace-shadow-exclusions.ts` | 45 | 应用层排除规则（Profer 私有数据等） |
| `workspace-shadow-turns.ts` | 345 | turn 边界采集、分叉边界 `recordWorkspaceShadowFork`、附加目录 |
| `workspace-shadow-restore.ts` | 249 | 回退 facade：保护快照 → 逆向 patch → journal 结论（**采不到快照就不写盘**） |
| `workspace-shadow-rewind.ts` | 162 | `resolveWorkspaceShadowRewind` / `applyWorkspaceShadowRewind`（新→旧，失败即停 → `recovery-required`） |
| `workspace-shadow-reconcile.ts` | 82 | 启动对账（窗口显示后 8s） |
| `debug-channel.ts` | 285 | dev-only 调试通道（loopback + 随机 token + `!app.isPackaged`） |
| `agent-transcript-audit.ts` | 294 | 启动只读审计（会话历史 vs runtime 产物），**只上报，绝不修复/删除** |

测试：`workspace-shadow-git.test.ts`、`workspace-shadow-turns.test.ts`、`workspace-shadow-restore.test.ts`、`workspace-shadow-rewind.test.ts`、`agent-rewind-shadow.test.ts`、`agent-transcript-audit.test.ts`。

### A.3 Pi 与跨 runtime

| 文件 | 行数 | 作用 | 审查重点 |
| --- | --- | --- | --- |
| `packages/agent-provider-pi/src/pi-transcript-rewind.ts` | 273 | `findPiSessionFile` + 纯重建（header + 保留历史对应 entry）+ 结构校验 + 原子替换 | 1:1 映射假设（见交接文档 §11.5） |
| `packages/agent-provider-pi/src/pi/session-file-store.ts` | 160 | Profer 独占写 Pi 文件：header、追加 entry、幂等 flush、旧版本迁移回写 | `written` 游标与并发 flush |
| `packages/shared/src/utils/agent-session-runtime.ts` | 86 | **跨 runtime 判据唯一来源**：`resolveAgentRuntimeChannelConflict`、`canSelectAgentSessionRuntime`、`runtimeDisplayName` | 是否有别处自己判 runtime |
| `packages/shared/src/utils/agent-session-runtime.test.ts` | — | 判据单测 | 缺 meta / 缺渠道的边界 |
| `packages/agent-provider-pi/src/pi-transcript-rewind.test.ts` | — | 重建场景（fixture 用 SDK 自己 append 生成） | 是否手搓了 entry 结构 |
| `packages/agent-provider-pi/src/pi/session-file-store.test.ts` | — | 写盘/迁移/flush 幂等 | 旧版本 header 迁移 |
| `packages/agent-provider-pi/src/pi/rewind-evidence.test.ts` | — | absent 不得用空字节表示 | 是否还有第二处同类写法 |

### A.4 脚本与文档

| 文件 | 作用 |
| --- | --- |
| `scripts/verify-shadow-git-dev.ts` | dev 只读压测 + 采集验证 |
| `scripts/verify-shadow-restore-dev.ts` | 文件侧回退生命周期 10 项断言 |
| `docs/plans/2026-11-08-shadow-git-design.md` | 设计与实施记录（§12.1–§12.15 为逐轮追加） |
| `docs/plans/2026-11-09-shadow-git-handoff.md` | 本交接文档 |
| `docs/plans/2026-11-09-shadow-git-changes.md` | 本文件 |

---

## B. 我修改的既有文件（关键词扫描命中 + 语义属于本次工作）

| 文件 | 改动点 | 为什么 |
| --- | --- | --- |
| `packages/session-store/src/index.ts` | 导出 `shadow-git` 公共面 | 装配层只从这里拿 |
| `packages/shared/src/types/agent-rewind.ts` | `RewindPlan.shadowTurns?: string[]` | 计划里存「要撤哪些轮」，不存目标内容（存内容会诱导整文件覆盖） |
| `packages/shared/src/types/agent-preset.ts` | 与 runtime 相关的类型扩展 | 跨内核渠道置灰需要 runtime 维度 |
| `packages/shared/src/types/chat.ts` | 同上 | 同上 |
| `packages/shared/src/utils/index.ts` | 导出 runtime 判据 | 唯一来源必须可被三处复用 |
| `packages/agent-provider-pi/src/index.ts` | 导出 `rewindPiTranscript`、`findPiSessionFile`、`rewindPiTranscriptDerived`（后被纯重建取代，确认无残留导出） | 宿主需要 |
| `packages/agent-provider-pi/src/pi-agent-adapter.ts` | 改用 `SessionManager.inMemory`；新增 `openPiSessionFile` + `flushPiSessionFile`；在工具结果/正常结束/异常/中断/消费方退出五处 flush | Pi 文件写入权归 Profer（§12.15） |
| `packages/agent-provider-pi/src/pi/rewind-evidence.ts` | absent 不再用空 `Uint8Array` 表达 | 空字节被宿主当成「存在但空」→ `preexisting` 误判 → 永不删文件 |
| `apps/electron/src/main/index.ts` | 启动：调试通道、启动对账（8s）、只读审计（8s+5s） | 装配入口 |
| `apps/electron/src/main/lib/agent-orchestrator.ts` | 在 `fileWritesByToolUse` 后、`try {` 前接入 `beginWorkspaceShadowTurn` 并 await；跨内核预检 | turn 边界必须早于工具执行 |
| `apps/electron/src/main/lib/agent-session-manager.ts` | 分叉时动态 import `recordWorkspaceShadowFork` 记录分叉边界 | 没有它，分叉后第一条 turn 会把整棵树当成自己改的 |
| `apps/electron/src/main/lib/remote-service.ts` | `uuid` 缺省时由宿主生成 | 缺 uuid 会让 Pi 的 rewindTurnId 退化成时间戳、归属记录无法与 JSONL 对齐 |
| `apps/electron/src/main/lib/agent-rewind-claude.ts` | 导出 `rewindBoundaryIndex(turns, target)` | 两套编号（`${sessionId}-T{n}` 与消息 uuid）只能解一次 |
| `apps/electron/src/main/lib/agent-rewind-service.ts` | 可选 `ports.shadow`、`shadowTurns` 分支、`shadowCapability()`、`refine`/`undo` 显式拒绝 | 两条链路必须切干净 |
| `apps/electron/src/main/lib/agent-rewind-host.ts` | resolver 文件来源改为工作区历史；`shadow.apply` 接线；`session.read/resolveTarget/writeConversation` 支持 Pi（纯重建） | 宿主适配 |
| `apps/electron/src/main/lib/agent-runtime-host.ts` | 每轮 run 前的跨内核冲突校验 | 不可绕过的一道闸 |
| `apps/electron/src/main/lib/agent-session-ui-projection-publisher.ts` | meta 写入前的跨内核校验 | 防止"UI 显示 A、实际写 B" |
| `apps/electron/src/main/lib/agent-goal-runtime-bridge.test.ts` | 补跨内核判据的断言 | 回归保护 |
| `apps/electron/src/main/lib/agent-orchestrator-host-seams.test.ts` | 补 turn 边界接线断言 | 回归保护 |
| `apps/electron/src/renderer/components/agent/RewindDialog.tsx` | 重写为一次确认：`getRewindConfirmCopy`、打开即准备、`prepareWithFallback` 静默降级 | 设计 §8 |
| `apps/electron/src/renderer/components/agent/RewindDialog.test.tsx` | 3 个用例 | 回归保护 |
| `apps/electron/src/renderer/components/chat/ModelSelector.tsx` | 新增 `runtime` 维度：跨内核渠道置灰（不隐藏）、键盘跳过 | 让用户点了才知道错是最差体验 |
| `apps/electron/src/renderer/components/chat/ModelSelector.test.tsx` | 10 个用例 | 回归保护 |
| `apps/electron/src/renderer/components/automation/AutomationFormView.tsx` | 传入 `runtime={form.agentRuntime}` | 自动化表单同一条判据 |

---

## C. 需 diff 核对（有关键词命中，但我不能确认是否我改的）

审查时请用 `git diff -- <file>` 自行判断；这几处很可能是**用户并行工作**与本次改动混在同一文件。

| 文件 | 命中的关键词 | 我的判断 |
| --- | --- | --- |
| `apps/electron/src/main/preload/index.ts` | 无（在 modified 列表里） | 应该是用户改动；本次没有新增 IPC 通道 |
| `apps/electron/src/renderer/atoms/agent-atoms.ts` | 无 | 同上 |
| `apps/electron/src/renderer/components/agent/AgentMessages.tsx` | `Rewind` | 该文件本次改动是 `minimapHostRef`（用户），`onRewind` 是更早就有的 |
| `apps/electron/src/renderer/components/agent/AgentView.tsx` | 无（25+/4-） | 改动是「停止按钮自救 + minimap」，属于用户并行工作 |
| `apps/electron/src/renderer/components/ai-elements/scroll-minimap.tsx` | `Shadow` | 命中的是 CSS `box-shadow`（用户） |
| `apps/electron/src/main/ipc.ts` | `AgentStopOutcome` | 用户的停止收敛改动 |
| `packages/agent-provider-pi/src/pi/real-usage-compaction.test.ts` | 无 | 压缩阈值测试，用户/另一会话的改动 |
| `scripts/verify-stop-convergence.ts` | 无（未跟踪） | 停止收敛验证脚本，**不是**本次工作产生的 |

---

## D. 属于用户并行工作、本次未触碰（仅列举，避免审查误判）

`apps/electron/src/main/lib/agent-collaboration-*`、`agent-preset-*`、`agent-service.ts`、`agent-session-deletion-service.ts`、`packages/agent-runtime/src/*`、`packages/user-memory/src/*`、`apps/electron/src/renderer/components/user-profile/*`、`app-shell/left-sidebar/*`、`tabs/TabSwitcher.tsx`、`settings/GeneralSettings.tsx`、`lib/heatmap-utils*`、`lib/session-status-visual.ts`、`profile-preview/main.tsx`、`components/ai-elements/scroll-minimap*`。

判断依据：这些文件的 diff 里没有本工作链路的语义（回退、归属、shadow、runtime 判据）。

---

## E. 我做过但不在 diff 里的动作（审查需要知道）

| 动作 | 说明 | 是否可恢复 |
| --- | --- | --- |
| 删除 `~/.profer-dev/sdk-config/sessions/pi/*.rewind-backup-*`（3 个，各约 110KB） | 上一版 Pi 截断实现的备份残留，对应的 Pi 文件已被后续会话正常继续使用 | 不可恢复；这些是 P4/P5 验证会话的旧备份 |
| 清理 dev 里的 probe 文件 | `p4-claude-probe.md`、`p5-*.md`、`p6-*.md`、`p7-*.md`、`p8-*.md`、`p5m-*.md` 等，均在 `~/.profer-dev/agent-workspaces/**` 下 | 无需恢复 |
| 重启 dev 多次 | 每次改主进程后必需 | — |
| 创建 dev 验证会话 | `0fd0e69d`、`a15a2f07`、`183320d3`、`33f86966`、`34b32d41` 等（标题 P5–P8），未删除 | 可按需删除 |
| 创建并删除临时渠道 | P7 验证时建过「P7 Claude 专用」，验证后删除 | — |

**没有做过的危险动作**（明确声明）：没有 `git add/commit/stash/checkout/reset/clean`；没有改用户项目自己的 `.git`、index、branch；没有改 `~/.profer`（正式配置）；没有删除任何用户文件或用户会话。

---

## F. 如何独立验证这批改动

```bash
cd /Users/mac/profer/profer-main/packages/session-store && bun test                    # 109 pass / 0 fail
cd /Users/mac/profer/profer-main/apps/electron && bun test src/main/lib/agent-rewind src/main/lib/workspace-shadow
cd /Users/mac/profer/profer-main/packages/agent-provider-pi && bun test src/pi-transcript-rewind.test.ts src/pi/session-file-store.test.ts
cd /Users/mac/profer/profer-main && bun run typecheck                                  # 期望 16/16
cd apps/electron && bun run build:main
```

真机（dev 需在运行，`/health` 应返回 `packaged:false`）：

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('/Users/mac/.profer-dev/debug-channel.json'))['token'])")
curl -s -H "x-profer-debug-token: $TOKEN" http://127.0.0.1:7791/health
curl -s -H "x-profer-debug-token: $TOKEN" "http://127.0.0.1:7791/attributions?sessionId=<id>"
```

---

## G. 如果要把这批改动单独摘出来（不碰用户改动）

不要用 `git stash`（会把用户改动一起收走）。建议：

```bash
# 1) 先给本次涉及的文件生成补丁备份
git diff -- <B 列逐个文件> > /tmp/shadow-git-mine.patch

# 2) 新增文件另存（未跟踪，不受 diff 影响）
tar czf /tmp/shadow-git-new-files.tgz \
  packages/session-store/src/shadow-git \
  apps/electron/src/main/lib/workspace-shadow-*.ts \
  apps/electron/src/main/lib/agent-transcript-audit.ts \
  apps/electron/src/main/lib/debug-channel.ts \
  packages/agent-provider-pi/src/pi-transcript-rewind.ts \
  packages/agent-provider-pi/src/pi/session-file-store.ts \
  packages/shared/src/utils/agent-session-runtime.ts \
  scripts/verify-shadow-*-dev.ts
```

回退这批改动 = `git apply -R /tmp/shadow-git-mine.patch` + 删除上述新增文件。**注意**：`agent-orchestrator.ts`、`agent-session-manager.ts`、`remote-service.ts` 等文件里可能同时存在用户改动，反向 apply 前先 `git apply --check -R` 确认无冲突。
