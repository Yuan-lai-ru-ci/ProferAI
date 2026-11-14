# Shadow Git 回退底座 · 交接文档

> 交接时间：2026-11-09 12:30（GMT+8）
> 代码库：`/Users/mac/profer/profer-main`
> 配套文档：设计与决策见 `2026-11-08-shadow-git-design.md`（含 §12.1–§12.15 实施记录）；逐文件改动清单见 `2026-11-09-shadow-git-changes.md`
> 阅读顺序建议：先看第 1–3 节搞清「回退到底是什么」，再看第 8–10 节（缺陷、未完成、审查重点），中间按需查。
> 生命周期：**历史交接与验收证据，不是当前 backlog**。本文 §9 的“新链 workspace shadow 采集未做”已有后继 [`2026-11-09-runtime-default-chain-handoff.md`](./2026-11-09-runtime-default-chain-handoff.md) §2.2 和当前 `agent-runtime-entry.ts` 的 begin/end 接线；其他未完项逐项回查源码、测试与工作区 `todo.md` T6。下文保留原始测试数字、设备条件和未验边界。

---

## 1. 这份文档怎么用

- **接手继续开发**：读 2–6 节（现状、语义、架构、模块、决策），再看第 9 节决定下一步。
- **审查查漏洞**：直接跳到第 8 节（已知缺陷）和第 11 节（我主动标出的高风险点），配合 `2026-11-09-shadow-git-changes.md` 逐文件核对。
- **只想验证能不能用**：看第 7 节（已跑通的真机证据）与第 10 节（命令）。

**一个前提**：这个仓库里同时存在大量**用户并行未提交改动**（约 70 个文件被修改，其中只有一部分属于本次工作）。改动清单文档按「新增 / 我修改 / 需 diff 核对 / 属于用户并行工作」四类分开列了，不要按 `git status` 一刀切。

---

## 2. 一句话现状

工作区文件回退（Shadow Git）+ 会话对话回退（Claude 与 Pi）+ 跨 runtime 禁止 + 回退审计已经跑通真机；**还差重新生成/编辑重发的缓存重建（Phase 5）、旧实现收敛（Phase 6）、历史不一致会话的界面入口、以及一次真实点击的 UI 验收**。

---

## 3. 产品语义（先对齐这个，否则代码看着像过度设计）

### 3.1 回退是什么

用户点「回退到此处」，意思是：

1. 对话回到那条 Assistant 回复为止；
2. **Agent 在这之后改过的文件一起撤销**；
3. **用户自己后来改过的内容保留**。

一句话：撤销的是「Agent 的写入」，不是「时间倒流」。

### 3.2 为什么不能"整树还原"

整树还原（把工作区覆盖成某个历史快照）会连带抹掉用户之后的改动。所以文件侧必须做**逆向 patch**：用 `before` 内容作为目标、`current` 作为现状、`after` 作为合并基准，三方合并。冲突时保留 current（用户内容），不写冲突标记。

### 3.3 用户可见约束（设计 §8，已落地）

- 只弹一次「确认回退？」，不做三选一、不做「生成预览」；
- 不出现 UUID / Shadow Git / commit / patch / 冲突 这类内部词；
- 不让用户判断冲突；
- **不提供会骗人的按钮**：工作区回退不支持 undo/refine，能力上报直接关掉，调用会显式报错。

### 3.4 明确不做

- 不改用户项目自己的 `.git`（不用 reset/checkout/clean，不动 index/branch/commit）；
- 不把「看不见」当成「删除」（partial 记录只恢复、不删除）；
- 不在文件回退不可用时假装成功（静默降级到只回退对话，并在计划里体现）。

---

## 4. 架构总览

### 4.1 三个存储位置（不要混淆）

| 位置 | 内容 | 归属 |
| --- | --- | --- |
| `~/.profer-dev/workspace-shadow/<workspaceId>/` | `repo.git`（bare）、`journal.json`、`manifest.json`、`turns.jsonl`、`forks.jsonl`、`restore-journal.jsonl`、`tmp/` | 工作区历史（文件内容对象 + 归属记录） |
| `~/.profer-dev/agent-sessions/<id>.jsonl` | Profer 自己的对话消息（唯一事实源） | 会话历史 |
| `~/.profer-dev/sdk-config/sessions/pi/<时间戳>_<id>.jsonl` | Pi 的 session 文件（**派生缓存**） | 由 Profer 写入，SDK 只读 |

Pi 的关系是 §12.15 定下的：SDK 用 `SessionManager.inMemory()` 跑（`persist=false`），正式文件由 `pi/session-file-store.ts` 在工具结果/轮末/异常/中断时 flush。

### 4.2 数据流

```text
采集（turn 边界）
  beginWorkspaceShadowTurn ──→ 采 turn-before（~200ms）
       │
       ├── Agent 跑（工具写文件）
       │
  endWorkspaceShadowTurn ────→ 采 turn-after
       │
       ├── diffShadowCommits → 变更列表（added/modified/deleted/renamed）
       ├── buildShadowTurnAttribution → turns.jsonl（含 roots / beforeRefs / afterRefs / preexisting）
       └── 与 turn 一一对应，boundarySource = 'shadow-git'

回退
  resolveWorkspaceShadowRewind（算 shadowTurns：哪些 turn 要撤）
       │
  agent-rewind-service.prepare（plan.shadowTurns）
       │
  applyWorkspaceShadowRewind（从新到旧逐轮）
       │
  reverse-patch（逐文件判定：见 5.2）
       │
  restore-journal（pending → completed / failed，进程被杀后可对账）
```

### 4.3 依赖方向（审查时先看这个）

```text
packages/session-store/src/shadow-git/*     纯 Node（git 命令 + 文件系统），不依赖 Electron / 会话层
        ↑
apps/electron/src/main/lib/workspace-shadow-*.ts   装配与边界（工作区路径、排除规则、turn 边界、facade）
        ↑
agent-rewind-host / agent-rewind-service     协议层（RewindPlan / capability / 执行事务）
        ↑
renderer RewindDialog / AgentView            只有一个确认弹窗
```

`session-store` 里**不允许**出现 Electron、会话 JSONL、Pi 的概念。一旦发现循环依赖，说明分层被破坏了。

---

## 5. 核心算法（两处最容易出漏洞）

### 5.1 turn 归属：为什么必须"交集"

两个证据源：

- **树差异**：turn-after 与 turn-before 的树对比，得到"看起来变了什么"；
- **工具证据**：Agent 实际调用写工具时的路径与内容引用。

只用树差异会误判（用户在两轮之间改了文件，会被算进 Agent 名下）；只用工具证据会漏（Agent 通过 shell 改的文件没有回调）。

所以：**两者交集才是 `confirmed`**；只有工具证据的标为 `unconfirmed`，回退时**不碰**（宁可少撤，不可误撤）。

### 5.2 逆向 patch 的判定顺序 = 安全策略

顺序本身就是设计，不能重排：

1. `unconfirmed`（证据不足）→ 跳过；
2. `partial` + `added`（采集不完整且是新文件）→ 只恢复、不删除；
3. 当前状态 `unknown`（读取失败但不是 ENOENT）→ 跳过，不能当"不存在"；
4. 历史边界不可读（`ls-tree` 查不到记录）→ 整条跳过（`boundary-unreadable`）；
5. 当前 blob sha 与 after sha 相同 → 直接恢复为 before；
6. 否则三方合并：`base = after`、`ours = current`、`theirs = before`。

其它关键点：

- **语义是"只恢复、不删除"**：`partial` 永远不进删除分支；
- **不能只看内容大小**：`dev/ino/size/mtime` 与计划记录不一致 → `concurrent-modification`，不写；
- **写盘顺序**：先写 pending 计划 → 执行 → 写 completed/failed；进程被杀后靠 `restore-journal` 知道原本打算动哪些文件；
- **原子写 + rename 前 chmod**：否则 0600 变 0644（world-readable）；
- **内容一律走字节流**：`cat-file` / `merge-file -p` 都带 `stdoutFile` 落盘再读，不让内容经过 UTF-8 字符串（非 UTF-8 文件会被 U+FFFD 破坏）；
- **相等判断用 blob sha**，不读全文（大文件不 OOM，不受输出上限影响）。

### 5.3 为什么每轮都采 `turn-before`

反例（真机抓到）：第 1 轮结束到第 2 轮开始之间，用户新建了 `x.md`，然后让 Agent 改它。如果 before 直接用"上一轮的 after"，`x.md` 在第 2 轮里会被记成 `added`，回退这轮就会去删用户文件。

所以：

1. 每轮开头单独采 `turn-before`（~200ms/轮）；
2. 第二道防线：`added` 但带 `beforeRefs` → 视为 `preexisting`，回退走 `keep-current`。

---

## 6. 模块清单

### 6.1 `packages/session-store/src/shadow-git/`（6088 行，13 个源文件）

| 文件 | 行数 | 职责 | 审查注意 |
| --- | --- | --- | --- |
| `types.ts` | 184 | 全部类型与状态机 | 三态 `CurrentState`、`partial` 语义 |
| `git-command.ts` | 217 | 异步 git 调用封装 | 必须支持 `stdoutFile`；不允许 `spawnSync` |
| `roots.ts` | 156 | 根路径解析、`isInsideRoot`、realpath | 最近存在祖先的 realpath |
| `exclusions.ts` | 138 | 排除规则（Profer 私有数据、`.git`、node_modules 等） | managed 工作区曾误收 563 条，修后 24 条 |
| `walk.ts` | 256 | 文件遍历、超大文件判定 | 大文件进 `partial` / `truncated` |
| `tree-builder.ts` | 427 | 多根合成树（三个临时 index） | 嵌套仓库必须 `hash-object -w --no-filters` + `update-index --index-info` |
| `repository.ts` | 524 | bare 仓库、ref、commit、`ls-tree` | `previousCommitId` 由采集带出，不另读 |
| `journal.ts` | 431 | `journal.json` / `manifest.json`、turn 记录追加 | 与归属记录必须在同一队列任务内 |
| `queue.ts` | 93 | 串行队列 | 采集与归属不能分两个任务 |
| `attribution.ts` | 约 400 | `diffShadowCommits` / `buildShadowTurnAttribution` / 4MB 压缩 | 交集判定、`preexisting`、`rootIntroduced` |
| `reverse-patch.ts` | 559 | 逆向 patch 与三方合并 | 判定顺序、字节流、TOCTOU |
| `restore-journal.ts` | 84 | 回退执行日志 | pending 必须先落 |
| `manifest.ts` | 165 | 工作区 → 仓库映射与版本 | 早期 `workspaceId` 可能是 `default` 这类非 uuid，需 try/catch |

### 6.2 `apps/electron/src/main/lib/`（装配层）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `workspace-shadow-git.ts` | 248 | 工作区路径、托管工作区、仓库初始化 |
| `workspace-shadow-exclusions.ts` | 45 | 应用层排除规则 |
| `workspace-shadow-turns.ts` | 345 | turn 边界（begin/end）、分叉边界、附加目录 |
| `workspace-shadow-restore.ts` | 249 | 回退 facade：保护快照 → patch → journal |
| `workspace-shadow-rewind.ts` | 162 | 把 `shadowTurns` 翻译成逐轮撤销（新→旧，失败即停） |
| `workspace-shadow-reconcile.ts` | 82 | 启动对账（窗口显示后 8s） |
| `debug-channel.ts` | 285 | dev-only 调试通道（127.0.0.1:7791，随机 token，仅非打包版） |
| `agent-transcript-audit.ts` | 294 | 启动只读审计（会话历史 vs runtime 产物），**只上报不修复** |

### 6.3 回退协议层

| 文件 | 关键点 |
| --- | --- |
| `agent-rewind-service.ts` | 可选 `ports.shadow`；`shadowTurns` 分支跳过全部 legacy 文件通道；`refine`/`undo` 显式拒绝 |
| `agent-rewind-host.ts` | resolver 文件来源改为工作区历史；`writeConversation` 分 Claude / Pi 两条路径 |
| `agent-rewind-claude.ts` | `rewindBoundaryIndex(turns, target)` 算"最后保留轮下标"，文件侧只按它切片 |
| `RewindDialog.tsx` | 一次确认；打开即准备；`prepareWithFallback` 静默降级到只看对话 |

### 6.4 Pi 侧

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `pi-transcript-rewind.ts` | 273 | 定位 Pi session 文件、纯重建（header + 保留历史对应的 entry）、结构校验、原子替换 |
| `pi/session-file-store.ts` | 160 | Profer 独占写：header + 追加 entry、幂等 flush、旧版本迁移回写 |
| `pi/rewind-evidence.ts`（改） | — | 修复「新建文件用空 `Uint8Array` 表示 absent」导致的 `preexisting` 误判 |

### 6.5 跨 runtime

`packages/shared/src/utils/agent-session-runtime.ts`（86 行）是**唯一判据来源**：

- `resolveAgentRuntimeChannelConflict({sessionRuntime, channel, model})` → 冲突描述或用空；
- `canSelectAgentSessionRuntime(session)` → 会话是否已锁定内核；
- `runtimeDisplayName(runtime)` → 用户可见名字（Pi / Claude），不暴露内部词。

三个拦截入口：`agent-orchestrator.ts`（预检）、`agent-runtime-host.ts`（每轮 run 必经）、`agent-session-ui-projection-publisher.ts`（meta 写入）。

用户可见文案：`该模型不能用于当前会话: 当前会话使用 Pi 引擎，所选渠道「…」只支持 Claude 引擎；请新建会话后再选择`。

---

## 7. 已跑通的真机证据（2026-11-08 – 11-09）

数字都是实测，不是估算；引用时请连同日期一起。

### 7.1 工作区历史采集

| 项目 | 结果 |
| --- | --- |
| managed 工作区采集条目 | 563 → 24（修正排除规则后） |
| 启动对账 | 4/4 通过（846/843/795/856ms） |
| dev 只读压测 | 2 工作区 / 7 记录 / change 2 / 抛错 0 |

### 7.2 文件逆向 patch（`scripts/verify-shadow-restore-dev.ts`）

生命周期 10 项断言全 pass，其中值得记的：

- 0744 模式保持；`clean-merge`；`conflict-kept-current` 且**不写冲突标记**；
- `partial` / `edited` / `recreated` / `boundary-unreadable` 四种边界各一条；
- journal `pending → completed`；重复执行幂等。

### 7.3 端到端（Claude，调试通道）

```text
建文件 p4-claude-probe.md → /rewind 到会话开始
  status=committed，files.deleted=['p4-claude-probe.md']
  文件消失，JSONL 6 行 → 0 行
  supportsFiles=true supportsUndo=false
三方合并：Agent 改第 1 行 + 用户改第 3 行
  clean-merge，最终 LINE1 baseline / LINE2 baseline / LINE3 user
```

### 7.4 端到端（Pi）

```text
会话级（0fd0e69d）：回退前 文件 12B / Profer 5 行 / Pi 8 行
  execute committed → 文件消失 / Profer 0 行 / Pi 1 行（仅 header）
  续聊：同一 sessionId 正常（Profer 5 / Pi 8）

消息级（a15a2f07，3 轮）：plan removed turn3 6 条、delete p5m-3.md
  committed → Profer 19→11 / Pi 20→14（leaf = turn2 终态）
  续聊建 p5m-4.md 成功
```

### 7.5 派生化之后（§12.15，最近一次）

```text
pi 会话发一轮：Pi +7 条，Profer 对话 4 = Pi 4
跨内核发送：被拒，Pi 文件未变（错误文案已人工确认可读）
rewind both/session-start：committed，Pi 仅 header，无 backup、无「条数不符」日志
续聊：Profer 6 = Pi 6
工具级落盘：一个 turn 内 +6 / +2 / +2 三次 flush（不是轮末一次性写）
```

### 7.6 自动化测试（截至 2026-11-09 12:30）

| 范围 | 结果 |
| --- | --- |
| `packages/session-store` | 109 pass / 0 fail（14 文件） |
| `apps/electron` rewind + shadow | 82 pass / 0 fail（14 文件） |
| `packages/agent-provider-pi` | 207 pass / 2 fail（失败是 `prompt-cache-request.test.ts` 的既有顺序问题：单独跑 2/2 通过，全量跑 requests=0，与本次无关） |
| 根 `bun run typecheck` | 16/16 包 exit 0 |
| `apps/electron bun run build:main` | 通过 |

---

## 8. 缺陷记录

### 8.1 已修复（留档防回归，不要重新引入）

独立审查会话（模型 `deepseek-v4.1-flash`）在真实代码上抓出 7 条，全部已修：

| # | 缺陷 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | 读失败当成「文件不存在」 | 会把读不到的文件当新增，回退时误删 | `CurrentState` 三态：只有 `ENOENT`/`ENOTDIR` 算 `absent` |
| 2 | before 读不到 vs 路径不存在无法区分 | 凭空生成删除 | `ls-tree -z` 区分，不可读整条跳过（`boundary-unreadable`） |
| 3 | 非 UTF-8 内容经字符串解码 | U+FFFD 破坏二进制 | 全链路字节流（`stdoutFile`） |
| 4 | `record.partial` 未被读取 | partial 记录也会进删除分支 | partial 一律只恢复不删除 |
| 5 | 文件模式全丢 | 回退后 0600 变 0644 | `ls-tree` 取 mode，rename 前 chmod |
| 6 | 单文件 fs 错误中断整轮、journal 永远 pending | 半恢复且无结论 | 每文件 try/catch + facade 必写结论 |
| 7 | `maxMergeBytes` 读入后才检查 | 大文件 OOM | 先 `stat` / `cat-file -s` |

真机暴露的 3 条：

| # | 缺陷 | 修法 |
| --- | --- | --- |
| 8 | 7 条真实记录中 3 条没有 `roots`（Phase 2-B1 之前），facade `record.roots.map` TypeError | 读取边界归一 `roots`/`changes` 为空数组；空 changes 早退；空 roots 但有变化则拒绝并报「归属记录缺少根路径快照」 |
| 9 | 「上一轮 after 就是本轮 before」不成立（两轮之间用户新建文件被记成 added） | 每轮开头采 `turn-before` + `preexisting` 第二道防线 |
| 10 | Pi 新建文件的 `before` 用空 `Uint8Array` 表示 absent | 归属记录带上 `beforeRefs` → `preexisting:true` → 永远不删。改为 absent 只由 `kind` 表达 |
| 11 | Pi 一轮多条 assistant，边界按 assistant 下标换算 | 整段漏撤文件轮。改为按用户轮 uuid 定位 |

### 8.2 现存风险（按严重度）

| 级别 | 风险 | 触发条件 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| 高 | **Pi 独有内容无法重建** | 回退后重建 Pi 文件 | `system`/thinking/compaction 只存在 Pi 文件里，Profer 历史没有；重建后模型行为可能变化，不报错 | 重建前把 Pi 独有 entry 一起带上（不只看 Profer 历史），或在计划里显式声明丢弃 |
| 高 | **`piEntryBindings` 语义过期会误截** | 绑定项与真实 entry 漂移 | 截到错误位置 | 重建前用 entry id 存在性 + 父子链校验，不存在就退化为「整轮保留」 |
| 中 | 崩溃窗口 | 进程在工具调用中途被杀 | 丢「正在跑的那一条工具调用」 | 已从轮末改成工具级 flush；若要零丢失需再加子步骤粒度 |
| 中 | 历史不一致会话 54 个（10 个跨内核） | 早期版本产生的数据 | 回退时可能失败或行为异常 | 只上报不修复是对的；缺 UI 诊断入口，用户看不到 |
| 中 | 工作区回退没有 undo | 用户回退错了 | 无法回滚这次回退 | 已有 recovery 记录与 `rewind-after` 快照，缺一个入口 |
| 低 | `refine`（按文件剔除）不可用 | 用户想只撤销部分文件 | 显式 `CAPABILITY_UNAVAILABLE` | 有意为之：文件是三方合并改的，剔除会留半恢复状态 |
| 低 | UI 置灰只有组件测试 | — | 真机可能仍能选中跨内核模型 | 需人工点一次（见第 10 节） |
| 低 | 新会话允许内核跟随渠道 | 未锁定 runtime 的新会话 | 设计选择，非缺陷 | 保持 |

---

## 9. 还没做（按优先级）

### P0

1. **Phase 5：重新生成 / 编辑重发走同一事务 + 缓存重建**
   现状：重新生成 = 回退 + 重发，复用了回退事务，但**没有重建**：provider continuation、上下文拼装、消息/turn 索引、标题摘要用量、文件索引。也没有把回退结果作为不可见上下文传给新 Agent。
   风险：新回复带着旧上下文残留，用户会感觉"它还记得我让它忘掉的事"。
   > 2026-11-09 15:10 更新：第一刀（§12.16）+ 新链热启动（§12.17）已落——旧链 resume 边界改为「provider 真接上才消费」、回退结果作为一次性不可见上下文注入、导航索引失效 + 回溯水位回退；新链补齐 `sdkSessionId` 热启动、`resumeSessionAt`、notice 注入与 resume 失效重建。仍未做：新链的 workspace shadow 归属采集（文件回退在新链上不可用）、submitAfterRewind 事务化。
2. **真实点击的 UI 验收**：悬停按钮 → 弹窗 → 执行 → 结果，一次都没人工点过。目前全部走调试通道（等价于主进程路径，但没有覆盖渲染层状态机）。
3. **历史不一致会话的界面入口**：54 个只写日志。至少要在会话设置里能看到「这个会话的 Pi 记录与对话不一致」。

### P1

4. **回退撤销入口**：数据都在（recovery + `rewind-after`），只缺 UI 与一次能力上报。
5. **Pi 独有内容保留**（见 8.2 第一条）。
6. **`piEntryBindings` 自检**（见 8.2 第二条）。

### P2

7. **Phase 6：收敛旧实现** —— 旧 D4 gateway/host、`pi-checkpoint-git.ts`、`agent-rewind-file-port.ts` 里的 legacy candidates 仍在。现在靠"测试里一调用就抛错"挡住误用，不适合长期。
8. **清理 dev 残留**：两条 `P4` 开头的空白会话、轮次验证产生的 P5–P8 会话（可删，但这些是我的验证记录，删前确认）。

---

## 10. 怎么跑、怎么验

### 10.1 环境

- dev 配置目录 `~/.profer-dev`（正式是 `~/.profer`，**不要动**）；`PROFER_CONFIG_DIR` 可覆盖。
- dev 调试通道：`127.0.0.1:7791`，token 在 `~/.profer-dev/debug-channel.json`，请求头 `x-profer-debug-token`。仅 `!app.isPackaged` 启动。
- 可用渠道+模型对（实测过）：
  - Pi：`channelId=ca3b04be-e037-4694-ae44-f3566a54c541` + `modelId=deepseek-flash`
  - Claude：`newapi-family-claude` + `claude-opus-4-7`（Pi 通道用同渠道会挂）
  - 子会话通道：`cn:deepseek-v4.1-flash`

### 10.2 命令

```bash
# 单元测试
cd packages/session-store && bun test
cd apps/electron && bun test src/main/lib/agent-rewind src/main/lib/workspace-shadow
cd packages/agent-provider-pi && bun test src/pi-transcript-rewind.test.ts src/pi/session-file-store.test.ts

# 类型与构建
cd /Users/mac/profer/profer-main && bun run typecheck      # 期望 16/16 exit 0
cd apps/electron && bun run typecheck && bun run build:main

# 重启 dev（改主进程后必须）
cd /Users/mac/profer/profer-main
pkill -f "concurrently -k -n vite,electron"; pkill -f "Electron"; sleep 3
(cd apps/electron && bun run dev:kill > /tmp/kill.log 2>&1)
nohup bun run dev > /tmp/dev.log 2>&1 &
# 等 40s，日志里应有「[Debug Channel] 已监听」与「启动对账完成」
```

### 10.3 调试通道端点（生产代码不含，仅 dev）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ok, pid, packaged}` |
| GET | `/sessions` | 会话列表 |
| GET | `/attributions?sessionId=` | 归属记录 |
| POST | `/sessions` | 建会话（`workspaceId/channelId/modelId/runtime/title`） |
| POST | `/send` | `{sessionId, userMessage, channelId, modelId}`（**三个都必填**） |
| POST | `/rewind` | `{sessionId, target:{kind}, mode, execute}` |
| POST | `/restore-shadow` | 直接跑文件侧回退 |

`target.kind`：`session-start` | `before-turn` | `after-turn` | `message`（后者匹配 **assistantMessageUuid**）。

### 10.4 手工验收清单（需要人点）

| # | 场景 | 操作 | 预期 |
| --- | --- | --- | --- |
| 1 | Pi 基本回退 | 让 Pi 建 `a.md`，对那条回复点「回退到此处」 | 只弹一次「确认回退？」；`a.md` 消失；对话回到该点 |
| 2 | 保留用户改动 | Agent 写 3 行文件，手工改第 3 行再回退 | 回到改之前，但第 3 行是用户内容；无冲突标记 |
| 3 | 回退到会话开始 | 两轮各建一个文件，对第一轮回复回退 | 两个文件都消失 |
| 4 | 跨内核禁止 | Pi 会话打开模型选择器 | 跨内核渠道置灰 +「仅支持 Claude 引擎」；键盘跳过 |
| 5 | 重新生成 | 对最后一轮点「重新生成」 | 文件回到该轮前 + 自动重发，不需二次点击 |
| 6 | 回退后继续 | 回退后再发一轮 | 正常出结果（Pi resume 未损坏） |
| 7 | 不该有的按钮 | 找「撤销」「按文件剔除」 | 看不到或明确提示不支持，不能点了没反应 |

记录重点：弹窗次数、是否出现内部词、文件少删/多删。

---

## 11. 给审查会话的提示（我主动标的高风险点）

按「最可能藏 bug」排序。每一条都给出具体怀疑，不要泛泛检查。

1. **`reverse-patch.ts` 的判定顺序被重排或短路**（559 行）。这是安全策略本身：任何一条被跳过或顺序变化都会导致误删/误覆盖。重点看：`partial` 是否真的进不了删除分支；`unknown` 是否被当成 `absent`。
2. **字节流是否真的没有回到字符串**。grep `toString('utf8')` / `readFileSync(..., 'utf8')` 出现在内容路径上就是问题；`cat-file` / `merge-file` 必须走 `stdoutFile`。
3. **TOCTOU 防护是否覆盖所有写盘点**。`dev/ino/size/mtime` 比对必须与实际 `writeFile` 之间没有别的 `await`。
4. **`preexisting` 判定**。`added` + `beforeRefs` 必须走 `keep-current`；注意 Pi 那边刚修过一次（空 `Uint8Array` 表示 absent），确认没有第二处同类写法。
5. **Pi 纯重建的历史映射**。`pi-transcript-rewind.ts` 假设 Profer ↔ Pi 1:1（`user`↔`user`、`assistant`↔`assistant`、全 tool_result 的 `user`↔`toolResult`、`system`/`result` 不落 Pi）。请用真实会话文件核对，特别是**多工具并发**、**中断轮**、**compact 之后**这三种情况。
6. **`session-file-store.flush()` 的幂等性**。`written` 计数与 `getEntries()` 的滑动窗口如果错位，会重复写或漏写。并发 flush（工具级 + 轮末同时触发）是否安全。
7. **跨 runtime 判据的唯一性**。是否还有地方自己判断 runtime 而不走 `resolveAgentRuntimeChannelConflict`——这类分叉会导致"某个入口能选，另一个入口报错"。
8. **`rewindBoundaryIndex` 的边界**。会话层 `${sessionId}-T{n}` 与归属记录里的用户消息 uuid 是两套编号，各解一次必然错位。确认文件侧只按一个下标切片。
9. **`shadowTurns` 从新到旧执行中途失败**。必须停在失败轮并转 `recovery-required`，不能继续撤更旧的轮（否则用户看到的是"撤了一半还继续出错"）。
10. **session-store 的分层**。`packages/session-store` 不应 import Electron 或会话 JSONL 相关模块；出现即破坏架构。
11. **启动对账的时机**。窗口显示后 8s 触发；如果用户在 8s 内就点了回退，是否有并发写冲突。
12. **审计只读性**。`agent-transcript-audit.ts` 绝不能写、不能删、不能"顺手修复"。

---

## 12. 名词表（避免审查时误读）

| 词 | 含义 |
| --- | --- |
| turn | 一次用户输入到 Agent 结束的一轮 |
| turn-before / turn-after | 该轮开始前 / 结束后的工作区树快照 |
| attribution（归属记录） | `turns.jsonl` 里一条：这轮改了哪些文件、证据是什么 |
| `shadowTurns` | 回退计划里"要撤销哪些 turn"，不是"目标内容" |
| `partial` | 采集不完整（超大文件、跳过项），语义是只恢复不删除 |
| `preexisting` | 这轮之前文件已存在（即使被记成 added） |
| `boundary-unreadable` | 历史边界无法读取，整条跳过 |
| `concurrent-modification` | 计划与执行之间文件被改，放弃写入 |
| 派生化 | Pi session 文件由 Profer 生成，SDK 只读（§12.15） |
