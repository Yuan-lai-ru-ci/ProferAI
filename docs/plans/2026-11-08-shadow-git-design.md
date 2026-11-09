# Shadow Git 工作区版本底座与 Agent 回退设计

> 状态：设计稿，尚未进入实现。
>
> 目标：逐步把 Shadow Git 铺成 Profer 工作区的内部版本底座，再让 Agent 回退、重新生成和会话缓存重建接入这套底座。

## 1. 设计结论

Profer 的回退不是把工作区 reset 到一个旧快照，也不是恢复某个 Agent turn 结束时的整棵文件树。回退的目标是：

> 在当前原会话中，撤销目标位置之后由该会话产生的文件变化；工作区中用户和其他会话的变化继续保留；当前会话的对话、运行时 continuation 和派生缓存回到同一位置。

Shadow Git 是工作区版本底座，负责保存工作区实际出现过的内容和状态。它不直接决定某段变化属于哪个会话；会话和 Agent turn 的边界由 Profer 运行时记录，并与 Shadow Git 的版本边界关联。

用户界面保持简单：点击消息上的“回退”后只弹一次确认，内容是“确认回退？”。确认后后台执行整条回退链路。UUID、文件列表、回退范围、预览、shadow commit、冲突详情和内部恢复阶段都不进入主流程。

## 2. 当前仓库事实与改造边界

当前仓库已经有两类与回退有关的能力，但它们不能直接代表新的模型：

- `apps/electron/src/main/lib/pi-checkpoint-git.ts` 已实现 Pi 专用的 bare shadow repository、tree snapshot、checkpoint ref 和 tree 恢复。
- `apps/electron/src/main/lib/pi-file-checkpoint.ts` 以每个 Pi session 为单位保存文件检查点，恢复时按检查点恢复一组路径。
- `apps/electron/src/main/lib/agent-rewind-pi.ts` 已有 Pi turn、mutation sequence 和受控 Write/Edit 证据记录。
- `packages/session-store/src/rewind-store.ts` 已有内容对象、before/after 版本和恢复 journal 的存储能力。
- Claude 已有 provider-native file-history snapshot 和 Profer JSONL 截断路径。
- Pi 的 session artifact 是 append-only tree，当前回退通过物理截断 JSONL 保留目标 entry 的主路径。
- `forkSourceSdkSessionId`、`forkSourceDir`、`parentSessionId`、`rootSessionId` 等字段已经表达部分分叉关系。
- 当前项目文件监听只监听项目 `.profer` 目录，不监听项目源码树；因此不能把现有 `workspace-watcher` 当作完整的用户文件变化采集器。

这些能力说明了现有入口和数据位置，但不等于新的 Shadow Git 设计已经存在。旧的每 session checkpoint 只能兼容读取和逐步迁移，不能继续作为项目工作区文件回退的最终语义。旧 D4 的 `prepare → execute → undo` 统一协议也不作为新产品入口。

本设计只新增一条逐步演进的底座路线，不要求一次性删除所有旧代码。实现过程中保留用户已有的其他 Agent、preset、session-layout 和 collaboration 修改。

## 3. Shadow Git 的职责

### 3.1 记录范围

Shadow Git 覆盖 Profer 管理范围内的工作区文件，包括：

- 用户手动创建、修改、删除和重命名的文件；
- 当前 Agent session 通过文件工具造成的变化；
- 其他 Agent session 造成的变化；
- Agent 通过可识别的受控工具执行的文件变化；
- 需要支持的附加目录中的文件。

它不覆盖：

- 用户项目自己的 `.git` 目录、index、branch 和 commit；
- Profer 的 session 存储、shadow repository 自身、缓存和临时目录；
- `node_modules`、构建产物和明显的高噪声生成目录，除非未来明确把它们纳入某个工作区规则；
- Bash、网络、数据库、部署和外部服务的副作用。文件被 Bash 修改时，可以在工作区版本中留下事实，但不能仅凭全量 diff 推断它属于哪个 Agent session。

Shadow Git 的提交和 ref 都在 Profer 配置目录中。所有实际用户文件仍留在原工作区，用户项目的 Git 状态完全不变。

### 3.2 按工作区共享，而不是每个 session 一份

一个工作区对应一个 Shadow Git 底座。多个 session 看到同一个工作区状态，也写入同一个 shadow repository。这样才能表达：

```text
用户修改 + session A 修改 + session B 修改
```

并在回退 session A 时只撤销 A 的变更。

不能继续用“每个 session 一个 shadow repository”作为项目模式的主模型。每 session 仓库只能回答“这个 session 的某个检查点是什么”，无法可靠表达多个 session 在同一个项目树上的共同历史。

### 3.3 多根路径

工作区根目录和附加目录分别分配稳定的 `rootId`。Shadow Git 内部使用合成命名空间保存内容，例如：

```text
roots/<rootId>/<relativePath>
```

用户看见的仍是实际路径；Shadow Git 的合成路径只用于避免多个根目录中的同名文件互相覆盖。所有变更记录使用：

```text
rootId + relativePath
```

而不是把绝对路径直接作为持久化身份。

## 4. 版本边界和来源记录

### 4.1 工作区状态快照

Shadow Git 的基本单位是工作区状态快照。每次快照至少包含：

```text
workspaceId
capturedAt
treeRef / commitId
roots
tracked path list
capture reason
```

`capture reason` 用于诊断和恢复，不作为用户界面概念。初期先在这些边界采集：

1. 工作区首次启用 Shadow Git；
2. Agent turn 开始前；
3. Agent turn 完成、失败或被中止后；
4. 用户点击回退、重新生成或 fork 前；
5. 应用启动后需要校正工作区状态时。

这意味着初期不承诺实时记录每一次用户按键。用户在两次采集之间的修改会在下一次边界采集时进入 Shadow Git；回退前必须先采集当前状态，不能使用过时的 shadow tree。

后续可以增加低频后台采集，但它只优化历史完整度，不改变回退语义。

### 4.2 Agent turn 绑定

每个实际参与当前 session 对话的 Agent turn 记录：

```text
sessionId
turnId
beforeTree
startedAt
afterTree
completedAt
terminal status
conversation start/end boundary
provider boundary
```

Profer 同时记录该 turn 的已知文件变更。对于 Claude provider-native snapshot、Pi 受控 Write/Edit 和未来可识别的其他工具，记录每个变化的：

```text
rootId
relativePath
base version
agent version
sessionId
turnId
operation sequence
source/evidence
```

`beforeTree` 和 `afterTree` 是工作区事实；变化归属记录是 Profer 语义。两者都需要，不能只保留其中一层。

### 4.3 用户修改和其他 session 修改

用户和其他 session 的变化不需要伪造一个 Agent turn。Shadow Git 先记录状态变化，Profer 在后续 Agent turn 的 before/after 边界之间把可识别的 Agent 操作关联到当前 session，其余变化归为外部变化。

当两个 Agent session 同时运行时，Shadow Git 写入必须由工作区级写入队列串行化，确保每个状态快照有明确顺序。Agent 执行本身可以并行；只有“读取当前树、写入快照、记录边界”不能并发互相覆盖。

若一次 turn 的全量 diff 同时包含当前 session 和其他来源，不能把整份 diff 归给当前 session。优先使用工具级 before/after 事实拆分；没有足够事实的部分只能作为未确认变化保留，回退时不主动删除。

## 5. 回退算法

### 5.1 回退目标

用户选择一条当前原 session 的 Agent 消息后，内部解析为该 session 的一个 turn 边界。回退目标同时包含：

- Profer 对话保留到目标消息；
- provider transcript 保留到对应运行时边界；
- 当前 session 在目标边界之后的文件变化集合；
- 目标 session 的派生缓存失效范围。

fork session 不属于该目标 session 的回退范围。

### 5.2 不使用 reset

禁止把工作区直接执行成：

```text
git reset --hard <target>
```

也禁止把某个旧 shadow tree 整体复制回用户工作区。两者都会抹掉目标边界之后的用户修改和其他 session 修改。

回退执行的是“逆向应用当前 session 的变化”：

```text
当前工作区
- 当前 session 在目标边界之后的已确认 patch
= 回退后的工作区
```

变化按逆序处理。每个 patch 使用 Agent 修改前的内容作为 base、Agent 修改后的内容作为 agent、回退时重新采集的内容作为 current，尝试把 `agent → base` 的逆向 patch 应用到 current。

### 5.3 非重合修改

如果用户或其他 session 修改了 Agent 修改区域之外的内容，逆向 patch 只移除 Agent 区域，其他内容保留。

示例：

```text
Agent 修改第 10～20 行
用户修改第 80～90 行
```

回退后 Agent 的第 10～20 行回到 base，第 80～90 行仍保留。

这就是“文件已被修改也应该被回退修改”的含义：判断单位是当前 session 的确认 patch，而不是整个文件 hash。

### 5.4 重合修改

如果当前内容与 Agent patch 在同一区域发生重合：

- 能明确拆出的非重合 hunk，继续逆向应用；
- 无法确认归属的重合 hunk 保留 current；
- 不能为了恢复整文件而覆盖用户或其他 session 的内容；
- 回退结果记录实际成功撤销和保留的范围。

用户不在回退前处理冲突。回退后默认不弹第二个技术对话框。下一轮 Agent 运行时，在用户不可见的内部上下文里告知模型：本次回退已撤销当前 session 能确认的变化，部分重合区域仍保留，后续应以当前文件内容为准。

这段内部说明不是用户消息，不写入正常对话 transcript，也不作为新的可见历史。

### 5.5 创建、删除和重命名

- Agent 新建文件：如果当前仍能确认文件内容属于该 Agent patch，逆向操作删除该文件；如果已经被用户或其他 session 修改，保留当前文件并只撤销可拆出的部分。
- Agent 删除文件：使用 Agent 删除前的内容恢复文件；如果删除后用户或其他 session 重新创建或修改了同一路径，先按当前 patch 做局部判断，不能直接覆盖。
- 重命名：优先记录为删除旧路径 + 新路径创建的关联操作；只有两边都能确认属于当前 session 时才执行完整逆向，否则分别按路径 patch 处理。

## 6. 对话、运行时 session 和缓存

### 6.1 Profer session 保持不变

回退继续当前原 session，不创建新的 session ID。需要同步改变的是：

- Profer 展示 JSONL 的保留边界；
- Claude 的 provider continuation 或 resume 边界；
- Pi session artifact 的物理 branch/truncated path；
- message UUID 到 runtime entry 的映射；
- 当前 session 的 turn/change index；
- 回退状态和内部恢复结果。

fork session 的 transcript、runtime artifact、change index 和缓存不改。fork 对源 session 的历史引用仍然按照 fork 自身的 artifact 和边界处理。

### 6.2 回退事务顺序

回退必须由主进程中的 session/workspace 操作串行执行，避免同一 session 正在写 JSONL 或同一工作区正在写 shadow tree。顺序为：

1. 拒绝或等待当前 session 正在运行的 turn；
2. 读取目标 session 和目标 turn，确认它不是 fork session 的外部引用；
3. 采集当前工作区状态到 Shadow Git；
4. 生成当前 session 目标边界之后的逆向 patch 计划；
5. 暂存工作区恢复前的保护快照和操作 journal；
6. 应用非重合 patch，并保留无法确认的重合部分；
7. 原子更新 Profer transcript 和 provider transcript/branch；
8. 删除目标边界之后的当前 session 变更索引；
9. 失效并重建当前 session 的派生缓存；
10. 写入回退后的工作区快照和结果 journal；
11. 释放锁，让原 session 可以继续。

任何一步失败都必须能根据 journal 判断下一步恢复动作。不能出现“对话已截断、文件操作没有记录”这种不可诊断状态。

### 6.3 缓存规则

回退改变了当前 session 的历史边界，因此目标位置之后生成的缓存不能继续复用。至少需要失效：

- provider continuation 与目标后历史绑定的缓存；
- 当前 session 的上下文拼装缓存；
- 当前 session 的消息索引和 turn 索引；
- 由目标后消息派生的标题、摘要、用量和状态缓存；
- 与目标后文件状态绑定的内部文件索引。

Shadow Git 的对象和其他 session 的缓存不删除。回退完成后，当前 session 下次继续时按保留的历史和当前实际工作区重新写缓存。若 provider transcript 不能在原 artifact 上安全截断，则清掉旧 continuation，以同一个 Profer session ID 根据保留历史重建运行时 session。

## 7. 重新生成

重新生成复用同一套内部回退能力，但减少用户可见步骤：

```text
确认重新生成？
→ 静默回到原用户请求之前
→ 撤销当前 session 从该请求开始的已确认文件变化
→ 截断对话和 provider continuation
→ 失效并重写缓存
→ 在原 session 中自动重新发送原用户请求
```

用户不需要看到中间的回退预览、文件清单、模式选择或两次确认。重新生成过程中如果发生局部重合，按普通回退规则保留无法确认的区域，并把结果静默提供给下一轮模型上下文。

## 8. UI 约束

主路径只保留一次确认：

```text
确认回退？
取消    回退
```

不显示：

- 消息 UUID；
- “只回退对话 / 只恢复文件 / 同时回退对话和文件”；
- “生成预览”；
- Shadow Git、commit、patch、owner、revision 等内部词汇；
- 要求用户判断文件冲突的选项。

回退结束后使用现有轻量结果反馈。成功时只告诉用户回退已完成；存在部分重合时可以用简短结果提示说明有部分文件变化保留，并把详情放在既有诊断或后续入口中，不阻塞用户继续对话。

## 9. 分阶段实施

### Phase 0：冻结旧行为并建立兼容层

目标是把现有数据和入口摸清，不改变用户行为。

- 为工作区生成稳定 Shadow Git 身份和目录布局；
- 复用并抽取 `pi-checkpoint-git.ts` 中可复用的 Git 命令、对象和路径安全逻辑；
- 旧 Pi checkpoint 继续读写，新增 Shadow Git 记录旁路状态；
- 为 Claude、Pi、managed、project 和 attached roots 写清楚路径映射；
- 增加工作区级操作队列和 journal 骨架；
- 不删除 D4 文件，不修改当前回退 UI。

验收：用户项目 `.git` status、index、branch 和 commit 完全不变；应用重启后可以找到并读取 Shadow Git 工作区状态。

### Phase 1：完整记录工作区历史

目标是让 Shadow Git 覆盖用户、Agent 和多 session 的工作区状态。

- 在首次启用、turn 前后、回退/fork 前采集状态；
- 记录工作区 tree、root 映射、路径清单和采集原因；
- 排除 Profer 自身目录与高噪声目录；
- 对应用无法读取的文件记录不可读状态，不把缺失误判成删除；
- 对用户项目现有未提交内容先导入 Shadow Git，不修改用户 Git；
- 支持进程重启、采集失败重试和部分采集 journal。

这一阶段只记录，不改变回退和重新生成行为。

验收重点：手动修改、Agent 修改、多个 session 修改按时间边界进入同一工作区 Shadow Git；不能只测试 Agent Write/Edit。

### Phase 2：建立 Agent turn 变更归属

目标是把 Shadow Git 的内容历史和当前 session 的 Agent 变化连接起来。

- turn 开始和结束绑定 before/after tree；
- 接入 Claude file-history 证据和 Pi 现有 mutation tracker；
- 将受控文件写入关联到 sessionId、turnId 和操作顺序；
- 对 Bash、未知 MCP、无法读取 before/after 的变化保留事实但标记未确认；
- 记录 session、turn、fork 和 workspace 的关系；
- 迁移旧 Pi checkpoint 时只建立可证明的边界，不把旧整树检查点伪装成新 patch 归属。

验收重点：同一文件先用户改、后 Agent 改；两个 session 改不同区域；两个 session 改同一区域；Agent 新建、删除、重命名文件。

### Phase 3：只接入文件逆向 patch

目标是先验证 Shadow Git 的核心回退语义，暂不同时截断对话。

- 为指定 session/turn 生成逆向 patch；
- 支持非重合 hunk 的局部恢复；
- 支持创建、删除和重命名的基本情况；
- 对重合区域保留 current，并生成内部结果 journal；
- 写入恢复前保护快照，支持崩溃恢复；
- 不使用整文件 hash 变化作为跳过条件；
- 不使用 `reset --hard` 或整树复制。

这一阶段可以通过内部测试入口验证，不先暴露新的用户流程。

### Phase 4：接入当前 session 回退

目标是把文件逆向 patch 和现有 Claude/Pi 对话回退绑定。

- UI 改为一次“确认回退”；
- Claude 保留 provider-specific transcript/resume 处理；
- Pi 保留 branch entry 定位和物理 JSONL 截断；
- 文件恢复和对话截断使用同一个回退 journal；
- 回退后当前 session ID 保持不变；
- fork session 的 transcript、文件归属和缓存不受源 session 回退影响；
- 结果只通过轻量反馈给用户，细节用于内部诊断和下一轮模型上下文。

### Phase 5：接入重新生成和缓存重建

- 重新生成调用同一回退事务，目标边界定位到原用户请求之前；
- 清理目标后当前 session 的 continuation、索引和派生缓存；
- 保留 Shadow Git 内容对象和其他 session 数据；
- 按回退后历史自动重建当前 session 缓存；
- 回退结果通过不可见上下文传给重新生成后的 Agent。

### Phase 6：收敛旧实现

只有新底座已经覆盖真实数据并通过迁移验收后，才处理旧 D4 和 per-session Pi checkpoint：

- 停止新流程写入旧统一 rewind service；
- 保留必要的历史读取和迁移；
- 清理没有调用者的 D4 gateway/host/protocol；
- 删除旧的整树恢复路径；
- 明确旧会话没有新归属记录时的兼容行为；
- 不能用一次大范围删除替代逐步迁移。

## 10. BDD 验收场景

### 工作区底座

- Given 用户项目已有未提交修改，When 启用 Shadow Git，Then 用户 `.git` 的 status、index、branch 和 commit 不变。
- Given 两个 session 在同一工作区运行，When 两轮分别完成，Then 两轮状态进入同一个工作区 Shadow Git，且 session 边界可查询。
- Given 应用在 turn 后退出，When 重新启动，Then 能加载最后一个完整工作区状态和未完成 journal。

### 局部回退

- Given Agent 修改 A 区域、用户修改 B 区域，When 回退 Agent session，Then A 回到 Agent 修改前，B 保留。
- Given Agent 新建文件后用户未改，When 回退，Then 文件被删除。
- Given Agent 新建文件后用户继续修改，When 回退，Then 用户当前内容保留，不能整文件删除。
- Given Agent 删除文件后用户重新创建不同内容，When 回退，Then 不覆盖用户重新创建的内容。
- Given session A 和 session B 修改同一区域，When 回退 A，Then 可确认的 A 变化撤销，重合区域保留，B 的其他变化保留。
- Given 某变化只有全量 diff、没有可确认的 session 归属，When 回退，Then 不把它伪装成当前 Agent patch。

### 会话和 fork

- Given当前 session 已 fork 出 B，When回退源 session A，Then B 的 Profer transcript、provider artifact、文件归属记录和缓存不被截断。
- Given回退改变了 A 的历史边界，When A 下一轮继续，Then A 使用回退后的历史和当前工作区重新生成缓存。
- Given Pi transcript 是 append-only tree，When回退，Then只截断 A 的主路径并保留可继续的原 session ID。
- Given Claude provider continuation 无法安全复用，When回退后继续，Then清除旧 continuation 并按保留历史重建。

### 重新生成

- Given用户点击重新生成，When确认后，Then用户只看到重新生成流程，不看到内部回退预览和文件模式选择。
- Given重新生成时有未解决的文件重合，When新一轮开始，Then模型在不可见上下文中获知保留区域，并基于当前文件继续。

## 11. 明确不做的事

- 不把用户项目 `.git` 当作 Shadow Git；
- 不向用户暴露 Shadow Git 的 commit、ref 和 patch 模型；
- 不用整树 reset 代替 session 级逆向 patch；
- 不因整个文件 hash 变化就放弃该文件的局部回退；
- 不因文件变化来源暂时无法确认，就把整份变化归给当前 Agent；
- 不承诺撤销 Bash、网络、数据库、部署和外部服务副作用；
- 不让 fork session 跟随源 session 的回退；
- 不在没有迁移数据和真实场景验收之前删除旧 checkpoint 数据。

这份设计的第一交付物不是“新的回退弹窗”，而是可重启、可查询、不会碰用户 Git 的工作区 Shadow Git 底座。只有当它能够同时记录用户、Agent 和多个 session 的真实状态后，回退才有资格按 session patch 工作。

## 12. Phase 0 实施状态（2026-11-08）

Phase 0 已完成，且**没有接线到任何运行时路径**：新增的底座没有任何调用点，旧的 Pi checkpoint、Claude snapshot 和现有回退 UI 行为完全不变。

### 12.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `packages/session-store/src/shadow-git/types.ts` | 共享契约：`ShadowRoot`、`ShadowCaptureResult`、`ShadowJournalEntry`、`ShadowWalkResult` 等 |
| `packages/session-store/src/shadow-git/git-command.ts` | 异步 git 执行层：spawn 参数数组、`--git-dir/--work-tree` 注入、`GIT_INDEX_FILE`、超时/输出上限，失败一律返回 `ok:false` |
| `packages/session-store/src/shadow-git/roots.ts` | `roots/<rootId>/<relativePath>` 合成命名空间、rootId/相对路径校验、附加目录稳定 id、根去重 |
| `packages/session-store/src/shadow-git/exclusions.ts` | 目录/文件排除规则与安全的「路径包含」判定 |
| `packages/session-store/src/shadow-git/walk.ts` | 单根异步枚举：显式栈、不跟随符号链接、体积/条目上限、不可读记录 |
| `packages/session-store/src/shadow-git/tree-builder.ts` | 每根一个临时 index → 子树 → `read-tree --prefix=roots/<rootId>/` 合成一棵树；commit/ref/diff |
| `packages/session-store/src/shadow-git/journal.ts` | 采集 journal：原子写（temp + fsync + rename）、坏文件留证、上限 200 条且不丢 pending |
| `packages/session-store/src/shadow-git/queue.ts` | 按 workspaceId 分链的串行队列（模块级共享，跨实例单写入者） |
| `packages/session-store/src/shadow-git/repository.ts` | 一次采集的编排：队列 → journal.begin → walk → tree → commit → ref → journal.complete |
| `apps/electron/src/main/lib/workspace-shadow-git.ts` | Electron 装配：`~/.profer/workspace-shadow/<workspaceId>/repo.git`、根集合解析、排除路径、capture/readState 入口 |

### 12.2 关键实现决策与偏差

1. **没有改 `pi-checkpoint-git.ts`，而是新建异步 Git 层。** 旧层的 `spawnSync` 会在采集大目录时阻塞主进程事件循环，而且它按 session 组织路径，无法表达多根。Phase 0 只做新增旁路，旧层继续服务 Pi checkpoint；「抽取」以「新模块成为后续唯一共享层」的方式落地，避免在用户未提交改动仍在进行时动旧文件。
2. **多根合成不走 `git add` 的路径改写，而走三个临时 index**：每根一个 index 得到子树，再用 `read-tree --prefix` 合并。bare 仓库里 `read-tree --prefix` 必须同时传 `--work-tree`，否则报 `this operation must be run in a work tree`；这条约束已在实现和测试里固化。
3. **历史用父链 + 单个 `refs/profer/shadow-workspaces/<workspaceId>/head`**，而不是每快照一个 ref。工作区底座需要可追溯的历史，父链比 ref 集合更符合 git 语义；`pi-checkpoint-git` 的「按 ref 删除即回收」取向在这里不适用。
4. **根不可用（未挂载/被删除/权限不足）时整次采集失败**，不生成空树。空树在后续 diff 里等价于「这个根的文件全被删除」，会把不可见误记成删除。
5. **`partial` 的语义是「只恢复、不删除」**：超限文件、不可读目录、条目/体积截断都会把该根标记为不完整；这正是设计 3.1 与 Phase 1 要求的「不把缺失误判成删除」的落点。单个超大文件只标记 partial，不再中断后续目录枚举（早期实现有这个 bug，已由集成测试兜住）。
6. **排除 `.profer`/`.claude`/`.context`/`.runtime`/`node_modules`/`dist` 等噪声目录，但不排除 `src`、`vendor`、`docs`。** 误排源码的代价是「用户以为有快照却恢复不出来」，不可感知，所以宁可少排。
7. **根路径先 realpath 再进 tree。** macOS 的 `/var` → `/private/var` 会让「附加目录是否嵌在主根内」判定失效，也会让 rootId 在两种写法间抖动；`deriveAttachedRootId` 因此基于规范化路径哈希。rootId 是 UUID 或 `attached-<16 hex>`，不暴露实际路径。

### 12.3 已知边界（留给后续 Phase）

- **采集尚未接线**：`captureWorkspaceShadow` 没有调用点，首次启用/turn 边界/回退前的采集属于 Phase 1。因此当前不会有任何磁盘写入，也不会创建 `workspace-shadow/` 目录。
- **managed 模式的会话产物**：managed 会话目录 `<工作区根>/<sessionId>` 同时承载 Agent 工作文件和 Profer 会话产物（JSONL 等）。目前只靠目录名排除，尚未按会话逐项列出产物路径。
- **会话级附加目录**（`sessionMeta.attachedDirectories`）随会话变化，属于 Phase 2 的归属范围；Phase 0 只纳入工作区级附加目录。
- **每次采集重建临时 index**：语义正确，但会重新哈希全部文件；增量 index 缓存（复用 stat 信息 + 显式 drop 失效条目）留到采集频率确定后优化。
- **journal 只保留 200 条**：超过后按「旧的 completed/failed 先丢、pending 不丢」修剪，长期历史以 git 父链为准。

### 12.4 验证

- `packages/session-store`：`bun test` 70 pass / 0 fail（含 3 个新测试文件 41 条）；`bun run typecheck` 通过。
- `apps/electron`：`bun test src/main/lib/workspace-shadow-git.test.ts` 4 pass；`bun run typecheck` 通过。
- 覆盖到的验收点：用户项目 `.git` 的 status/HEAD 在采集前后逐字不变；重启后（新实例）能读回 head commit 与 tree；两个根合成 `roots/<rootId>/...`；并发采集串成一条父链；根不可用时采集失败且不污染最近一次成功。
- 既有回退相关测试（`pi-file-checkpoint.test.ts`、`agent-rewind-pi.test.ts`）47 pass，未受影响。

### 12.5 dev 实例真机验证（2026-11-08）

验证脚本：`scripts/verify-shadow-git-dev.ts`（读真实 `~/.profer-dev` 索引，只写 `<configDir>/workspace-shadow/`，默认拒绝对正式配置动手）。

| 工作区 | 模式 | 文件数 | 首次采集 | 重复采集 diff | 仓库体积 |
| --- | --- | --- | --- | --- | --- |
| learning | project | 21 | 156ms | 空（稳定） | 416K |
| default | managed | 24 | 217ms | 空（稳定） | 2.6M |
| CDUTAI | project | 4866 | 6566ms | 空（稳定） | 96M |

三次采集都验证了：用户仓库 `git status` 与 `HEAD` 逐字不变；新进程读回 head/tree 一致；连续两次采集 tree 相同。

真机测试发现并修复的两个真实缺陷：

1. **嵌套仓库被静默丢弃。** 工作区里只要存在自带 `.git` 的目录（`learning/.pi` 就是），`git add <该目录内文件>` 会**退出 0 却不加入任何条目**：21 个文件只有 3 个进了 tree，而 `failures` 为空、`partial=false`——是最危险的「成功但丢数据」。改为 `hash-object -w --no-filters` 写对象 + `update-index -z --add --index-info` 登记，绕开工作树路径规则；已补回归测试（嵌套仓库文件必须进基线，其 `.git` 内部仍排除）。
2. **managed 工作区把 Profer 私有数据当用户文件采集。** `default` 工作区初次采到 563 个文件，其中 509 个是 `.migration-backup/`，另有 `agent-presets.json`、`mcp.json`、`skills/`、`workspace-files/` 和可视化缓存 `viz-fragments/`。改为「按该工作区根下的绝对路径」排除（`workspace-shadow-exclusions.ts`），而不是按目录名全局排除——否则用户项目里的同名 `sessions/`、`skills/` 会被误伤。修复后 `default` 采集 24 个文件，全部是会话目录里真实的用户可见产物（HTML/脚本/图片/Markdown）。

性能结论：**增量索引必须在 Phase 1 接线前完成**。当前每次采集都重建索引并重哈希全部文件，CDUTAI 4866 个文件耗时 6.5s；按 turn 前后各一次计算，每轮对话要重复哈希约 13s 的 I/O。增量方案已明确：持久化每根的「路径 → (size, mtime, sha)」清单，只对 stat 变化的文件重新 `hash-object`，其余复用 sha 直接 `update-index`；清单原子落盘，解析失败时整份作废并回退全量重建（宁可慢一次，不可静默漏变化）。

### 12.6 Phase 1-A 增量索引 + 启动对账（2026-11-08）

**增量索引**（`shadow-git/manifest.ts` + `tree-builder.ts` + `repository.ts`）：

- 清单记录每根「路径 → size / mtime / ctime / ino / blob sha」，采集成功后整份原子替换（temp + fsync + rename）；失败时保留旧清单，下次宁可多哈希。
- 只对 stat 身份变化的文件重新 `hash-object`，其余复用上次的 sha 直接 `update-index`。
- 清单损坏 / 形状非法：整份作废并重命名为 `.corrupt-<ts>`，本次回退全量哈希，绝不复用可疑 sha。
- 多存 ctime 与 inode 的原因：编辑器保存多为「写临时文件再 rename」（换 inode），`touch -r` 能改回 mtime 但改不掉 ctime；这两项把「同尺寸同 mtime 的修改被漏掉」压到实际不可能。
- **tree 与当前 head 一致时不产生新提交**：Agent 大部分 turn 不写文件，空 diff 提交既污染历史又让后续按 turn 定位边界更难。

**实测（dev 数据，CDUTAI 4866 文件）**：

| 场景 | 耗时 | 重哈希 | 复用 |
| --- | --- | --- | --- |
| 首次（无清单） | 2336ms | 4866 | 0 |
| 有清单、工作区未变 | ~330ms | 0 | 4866 |
| 有清单、多轮重启 | ~330ms/次，0 新提交 | 0 | 4866 |

顺带把仓库初始化做成「标记文件 + HEAD 存在性」检查：`init + rev-parse + 5 次 config` 从每次采集都做降为只做一次（约省 80ms 固定开销）。

**启动对账**（`main/lib/workspace-shadow-reconcile.ts`，`main/index.ts` 在窗口显示后延迟 8s 触发）：

- 只处理**已经存在底座**的工作区（首次建立底座仍属于「工作区首次启用」的显式路径，避免每次开应用对所有大项目全量哈希）；
- 串行、纯旁路，失败只记日志，不影响界面；同一时刻只允许一轮。
- 日志形如 `[Shadow Git] 启动对账完成: 3/3 成功，0 失败，918ms`。

**重启端到端验证**（真实 dev 实例，两次重启 + 一次探针文件）：

| 时刻 | 事件 | 结果 |
| --- | --- | --- |
| 20:04:28 | 重启，工作区未变 | 复用同一 commit、同一 tree，无空提交 |
| 20:05:19 | 写入 `shadow-restart-probe.md` 后重启 | 新 commit `9c22403f`，tree 22 文件，探针在 tree 中 |
| 20:05:54 | 删除探针后重启 | 新 commit `7b5e2db0`，tree 回到 21 文件、与原 tree 逐字相同，探针不在 tree |

三次对账均为 `3/3 成功`，父链连续，用户工作区未被写入。

### 12.7 Phase 1-B：turn 边界采集（2026-11-08）

编排器里只增加两个调用点，采集逻辑全部在新模块 `main/lib/workspace-shadow-turns.ts`：

- `beginWorkspaceShadowTurn(workspaceId)`：在 `sendMessage` 取得执行权之后、`try` 之前调用；
- `endWorkspaceShadowTurn(workspaceId)`：在 owner finally 的终态交付之后调用（成功/失败/停止都经过）。

**关键时序约束（踩过一次才会知道）**：`begin` 在常见路径必须返回 `undefined` 而不是 promise。编排器里有大量「取得执行权后同步可见」的断言与行为（`isActive` 立即为 true、持久 Run 同步 queued）。如果每轮都 `await` 一个已经 resolve 的 promise，这些时序全部推迟一个微任务，会让 4 个既有编排器测试直接失败——那不只是测试问题，是把同步占用语义改掉了。因此：

```ts
const pending = beginWorkspaceShadowTurn(workspaceId)
if (pending) await pending
```

只有两种情况返回 promise：
1. 工作区还没有底座（首个 turn 必须先把现有内容导入基线）；
2. 上一轮 `turn-after` 还在后台跑（必须等它落盘，否则两轮写入会被并进同一份快照）。

为了让第 2 种判断可靠，排队登记必须**同步**发生：`captureWorkspaceShadow` 改为把「打开仓库 + 采集」整段排进工作区队列（`runWorkspaceShadowTask`），并让仓库提供不重复排队的 `captureExclusive`。否则 `end()` 返回时 pending 计数还是 0，下一轮会误以为队列空闲。

**为什么 before 不在每轮都采**：上一轮的 turn-after 就是本轮的之前状态。每轮开头再采一次只会多 300ms 并产生一个空提交（tree 相同时已经跳过提交）。代价是「工作区首次启用」这一轮必须阻塞等待（真实项目几百毫秒到几秒），之后每轮几乎零等待。

**真机验证**（dev 实例，pocket WS 驱动真实 turn）：

| 步骤 | 结果 |
| --- | --- |
| 新建会话并发一轮消息 | turn 启动，`begin` 未产生额外延迟（工作区已有底座、队列空闲） |
| 运行中通过 `stop_agent` 停止 | journal 新增 `turn-after`（20:58:46），commit 仍是 `3128c536`、24 文件 |
| 树未变化时的提交行为 | 复用同一 commit，不产生空 diff 提交 |

说明：这次 turn 的模型请求在当前环境下没有返回（dev 日志里 GitHub 检查也是 `ECONNREFUSED 127.0.0.1:443`，本地代理不可用），所以走的是「用户停止」终态——正好覆盖了失败/停止路径必须也补 `turn-after` 的要求。

**测试**：

- `workspace-shadow-turns.test.ts`（4 条）：首个基线返回 promise 并落 journal；有底座且空闲返回 `undefined`；`end` 后 `begin` 能等到 turn-after 落盘；工作区未知/非法时安静返回。
- `agent-goal-runtime-bridge.test.ts` 新增 3 条：`begin` 在持久 Run 登记前同步调用、失败终态后 `end` 恰好一次；入口拒绝（内核不匹配）不触发采集；`begin` 需要等待时 Run 登记被推迟到采集完成之后。
- 既有编排器测试 42 条、bridge/host-seams 63 条全部通过，未改变同步占用语义。

### 12.8 Phase 2：turn 变更归属（2026-11-08）

把「工作区里真的变了什么」和「runtime 说自己写了什么」交叉起来，落成可查询的 turn 记录。

**分层**

- `packages/session-store/src/shadow-git/attribution.ts`：纯逻辑 + git diff + JSONL 存储，不依赖 Electron。
- `main/lib/workspace-shadow-turns.ts`：turn 收尾时把采集、diff、记录串成一个队列任务。
- `agent-orchestrator.ts`：只负责收集证据（路径 + 事件流顺序）并在终态把它交给采集层。

**为什么要交叉，而不是二选一**

只信树差异：Bash、未知 MCP、外部进程、用户手改都会让工作区变化，一律算成 Agent 改动，回退时就会抹掉用户自己的编辑。
只信证据：Bash 生成的文件、被重命名/删除的路径根本不会出现在 tool_use 里，回退会漏。
所以两条都记：差异是**事实**，证据是**归属**，交集才是 `confirmed`，其余是 `unconfirmed`。这个字段就是 Phase 3 决定「能撤销什么」的唯一依据。

**before 从哪来**

不在 turn 开始时另读一次状态，而是让采集结果自带 `previousCommitId` / `previousTreeSha`。原因：读状态和采集之间会插进别人的队列任务，后读到的「before」可能已经不是这次的父提交。仓库内部本来就要解析父提交，顺手带出来是零成本的。

**证据来源按 runtime 分流**

| runtime | 来源 | 说明 |
| --- | --- | --- |
| Pi | adapter 的 `onFileWrite` | 受控写入的精确路径，Bash 提升出来的写入也带 `source: 'bash'` |
| Claude | 流里的 `tool_use` 入参 | `Write`/`Edit`/`MultiEdit`/`NotebookEdit` → `file_path`/`notebook_path` |

两边都采会把同一次写入记两遍（Pi 的 tool_use 路径可能是相对路径，无法按字符串去重）。分流之后每条写入只出现一次，`seq` 就是事件流顺序。
Bash 刻意不进 Claude 的工具表：从命令行文本猜路径会把 `echo > a` 之类误判成受控写入，而它改了什么只有树差异知道。

**记录形状**（`<shadowDir>/turns.jsonl`，追加写）

```jsonc
{
  "schemaVersion": 1,
  "workspaceId": "...", "sessionId": "...", "turnId": "<用户消息 uuid>",
  "turnIdSource": "user-message" | "capture",
  "runtime": "pi",
  "beforeCommitId": "...", "afterCommitId": "...",
  "changes": [
    { "rootId": "...", "path": "src/a.ts", "absolutePath": "/…/src/a.ts",
      "status": "modified", "attribution": "confirmed",
      "evidenceSeq": [1, 3], "evidenceSource": "edit" }
  ],
  "unchangedEvidence": [ { "path": "...", "seq": 2, "reason": "no-net-change" | "outside-roots" } ],
  "partial": false
}
```

- 追加写而不是读改写：多个会话的收尾可能并发，读改写会互相覆盖。
- `turnId` 必须能和 JSONL 消息对上，因此优先用用户消息 uuid；拿不到时（IM/Pocket 未透传）用采集 id 兜底，并把 `turnIdSource` 记成 `capture`，不能让上层以为边界是精确的。
- `unchangedEvidence` 记「说了要写但树里没有」的路径：写入失败、写完又改回去、写到采集排除路径，三种情况都值得留下痕迹。
- `partial` 为 true 时（不可读目录/超限文件），`deleted` 不能当删除证据用。
- 没有 diff 也落记录，`note` 写清原因：知道「这个 turn 没有可用边界」本身就是事实。

**采集与记录必须是同一个队列任务**

最初把记录写在采集 promise 的 `.then` 里，测试里立刻暴露问题：`waitForWorkspaceShadowIdle` 只等采集队列，记录还在队列之外跑，于是「队列空闲」不再等价于「这个 turn 记完了」。进程退出或下一轮等待都会看到半个 turn（有提交、没有归属）——这正是回退最依赖的那条链。现在整段（打开仓库 → 采集 → diff → 追加记录）在同一个 `runWorkspaceShadowTask` 里。

**验证**

```text
packages/session-store: bun test                86 pass / 0 fail（13 文件）
  shadow-git-attribution.test.ts                11 pass
    · diff 解析（A/M/D、NUL 分隔、R/T 跳过、中文与空格文件名）
    · 证据命中 → confirmed；只有树差异 → unconfirmed
    · 证据在根外 → outside-roots；/private 变体视为同一路径
    · 同一路径多次写入保留全部 seq
    · 真实仓库：改/增/删后 diff 状态正确，previousCommitId 来自上一次提交
    · 树未变化时 diff 为空且不产生空提交
apps/electron: workspace-shadow-turns.test.ts    7 pass
    · turn-after 落盘后写入 diff×证据记录（added + confirmed）
    · 无会话身份 → 采集照做但不写归属
    · 无用户消息 uuid → turnIdSource=capture
编排器相关 4 个测试文件                        76 pass
根 typecheck                                    16 个包全 0
```

**dev 真机**：通过 pocket WS 建会话发一轮消息后 `stop_agent`，`~/.profer-dev/workspace-shadow/<workspace>/turns.jsonl` 出现一条记录，`sessionId` / `turnId` / `runtime` / before / after 都对；该轮没有文件写入，因此 `changes` 为空、`beforeCommitId === afterCommitId`（tree 未变不产生新提交）。这一轮跑在加 `turnIdSource` 之前的 bundle 上，字段本身由单测覆盖。

**Phase 2 剩余（未做）**

- `fork-before` 采集点与 session/turn/fork 关系记录；
- 会话级附加目录（`sessionMeta.attachedDirectories`）纳入采集；
- Claude file-history 的 before/after **内容**证据并入 turn 记录（目前它只存在于 rewind store，Phase 3 生成 patch 时再取）；
- 旧 Pi checkpoint 迁移时只建立可证明边界。

### 12.9 Phase 2-B1：fork 边界与会话级附加目录（2026-11-08）

**会话级附加目录进采集**

`resolveWorkspaceShadowRoots(workspace, { sessionAttachedDirectories })` 现在把会话自己的附加目录并入根集合（`kind: 'attached'`，rootId 由路径哈希派生，跨 turn 稳定），并沿用工作区级的去重/嵌套过滤：重复路径、嵌在主根内的目录、以及和工作区级附加目录重复的都只留一份。

编排器从 `sessionPort.getMeta(sessionId).attachedDirectories` 取这份列表，**同时**传给 `begin` 和 `end` —— 采集和记录必须用同一份根集合，否则记录里的路径含义会失真。

**根集合会变，所以记录必须带根快照**

会话级附加目录随会话增删，这带来两类必须显式处理的假象：

- 目录被移除 → 整棵子树从 tree 里消失，diff 里全是 `deleted`。那是「我们不再看它」，不是「Agent 删了它」。
- 目录被加入 → 整棵子树都是 `added`。那是「刚开始看」，不是「Agent 新建」。

处理方式是拿上一个边界的根集合做差：

- `previousRootIds` 从 journal 里按 `previousCommitId` 找回（那次采集记过 roots，不需要额外存储）；
- 被移除的根：其条目直接从 `changes` 剔除，记进 `rootSetChanges.removed`；
- 被新增的根：条目保留，但标 `rootIntroduced: true`，Phase 3 不能据此删除整棵树。

归属记录同时存 `roots: [{ rootId, rootPath, kind }]` 快照：只有 rootId 的话，回退时无法把 `roots/<rootId>/a.ts` 还原成真实文件。

**fork 边界**

`recordWorkspaceShadowFork` 在分叉成功后由 `forkAgentSession` 触发（动态 import，避免 `agent-session-manager ↔ workspace-shadow-turns` 的加载期循环）：

- 采集一次 `fork-before` 边界；
- 关系单独写 `<shadowDir>/forks.jsonl`（`sourceSessionId` / `newSessionId` / `commitId` / `upToMessageUuid`），不等新会话第一条 turn 再回填 —— 新会话可能一直不发言；
- 分叉后的**第一条** turn 记录带 `forkOf`，后续不带（关系已在 forks.jsonl，重复写只是噪声）。

放在分叉**之后**做的原因：分叉只改 Profer 会话数据（已在排除范围），工作区文件不变，前采后采是同一棵树；而采集失败不该影响分叉本身的结果。

**顺带修掉一个归属缺口**：远程（Pocket/IM）`send_message` 未带 uuid 时，宿主现在生成一个 `randomUUID()`。这个 uuid 同时是消息身份（乐观气泡去重）和 turn 身份（`rewindTurnId` / 归属记录），缺失会让 Pi 的 `rewindTurnId` 退化成 `turn-<时间戳>`、让归属记录只能退到采集 id。

**验证**

```text
packages/session-store  89 pass / 0 fail（13 文件）
  shadow-git-attribution.test.ts 14 pass（新增：根集合增删、首个 turn 不判定、fork 关系多写入取最后一条）
apps/electron           82 pass（4 个文件）
  workspace-shadow-turns.test.ts 10 pass
    · 会话附加目录纳入采集：rootIntroduced + confirmed，absolutePath 是 realpath
    · 取消附加目录：整根消失不进 changes，rootSetChanges.removed 记录
    · fork：forks.jsonl 有 commitId；新会话第一条带 forkOf，第二条不带
  workspace-shadow-git.test.ts 6 pass
    · 会话级附加目录并入根集合，重复/嵌套/与工作区级重复都去重
根 typecheck            16 个包全 0
```

**dev 真机（claude 会话实分叉）**

```text
23:13:10 journal: fork-before 3128c536
forks.jsonl: {sourceSessionId: 2c6dfe1d…, newSessionId: 9d492c1a…, commitId: 3128c536…}
9d492c1a 第 1 条 turn 记录: forkOf={sourceSessionId, commitId}, turnIdSource=capture
9d492c1a 第 2 条 turn 记录: turnId=0884cdbf…, turnIdSource=user-message, forkOf 缺省
   → 该 uuid 确实存在于会话 JSONL（join 链路成立）
```

Pi 会话的分叉在 dev 上未跑通（历史条目缺 entry ID 映射），因此真机验证用的是 Claude 会话；Pi 分叉走的是同一条 `forkAgentSession` 收尾路径，差别只在 `forkAgentSessionUnlocked` 内部。

### 12.10 Phase 2-B2：内容证据并入 + 真实 turn 暴露的证据缺口（2026-11-08）

**先说踩到的坑（比新增功能更重要）**

用 DeepSeek 渠道 + `deepseek-flash` 跑了一轮真实 turn，模型调 `Write` 写了一个文件，树差异正确记到了 `added`，但归属是 `unconfirmed`、`evidenceSeq` 为空。

原因不是采集没跑，而是**证据来源假设错了**：`onFileWrite` / `onFileMutation` 是 Profer 自己包装的受控写入才触发的回调，而 OpenAI 兼容渠道下的 Pi 会把写入交给 `Write` 这类工具执行，两个回调都不触发。于是「明明写了，却说自己没写」。

修复：tool_use 入参解析对**两个 runtime 都跑**（工具表同时列了 `Write`/`write`、`Edit`/`edit`、`MultiEdit`/`multi_edit`、`NotebookEdit`），回调触发时不再新增证据，而是**补全同一条**：换成绝对路径、补上内容引用。去重按 `toolCallId + 路径归一`（`note.md` 与 `/w/note.md` 视为同一文件，`/w/a.ts` 与 `/w/ab.ts` 不误判）。

这个缺口只有真实 turn 能暴露：单测里我自己写的假 adapter 走的就是回调路径，永远是绿的。

**内容引用并入**

- `ShadowTurnEvidenceItem` 增加 `beforeRef` / `afterRef`（内容对象库的 id）；
- `onFileMutation` 触发时把 `beforeBackup.contentRef` / `afterBackup.contentRef` 挂到证据上；
- 归属记录的每条 change 汇总成 `beforeRefs` / `afterRefs`（去重、按出现顺序）。

只记 id、不复制内容：同一个文件已经在 rewind 对象库里存过一份，再存一份会让存储翻倍，而且两份内容的生命周期不同步。没有内容证据时字段缺省，不写空数组——空数组会被下游误读成「内容为空」。

一个需要记住的语义边界：新建文件的 `beforeRef` 可能是空内容的 sha256（`e3b0c442…`），它和「文件原本存在但为空」在引用层面不可区分。判定「这是新建」必须看 change 的 `status: 'added'`（来自树差异），不能只看引用。

**旧 Pi checkpoint 的边界**

新增 `boundarySource: 'shadow-git'` 必填字段。旧的 `pi-file-checkpoint` 整树基线**永远不会**被换算成归属记录：它只证明「某一刻的整棵树」，不证明「哪次 turn 改了哪个文件」。迁移期下游要能区分「有归属」和「只有旧检查点」，不能靠「记录里没有 changes」去猜。

**验证**

```text
packages/session-store  92 pass / 0 fail（13 文件）
  attribution 17 pass（新增：内容引用去重、无引用不写空数组、boundarySource）
apps/electron           85 pass（4 文件）
  agent-goal-runtime-bridge 32 pass（新增 3 条：Write/write/Edit 取路径、Bash 不进表、路径归一）
根 typecheck            16 个包全 0
```

**dev 真机（DeepSeek 官方渠道 + deepseek-flash，两轮对比）**

```text
修复前 ad97ed60：changes=[{status:added, attribution:unconfirmed, evidenceSeq:[]}]
修复后 3f340161：changes=[{
  status: added, attribution: confirmed,
  evidenceSeq: [1], evidenceSource: 'write',
  beforeRefs: ['e3b0c442…'], afterRefs: ['737c97aa…']
}]
journal: turn-after 2df51588，tree 26 文件（比上一轮多 1）
```

两轮都 `turnIdSource: user-message`，且该 uuid 能在会话 JSONL 里找到。

### 12.11 Phase 3：文件逆向 patch（2026-11-08）

**入口与边界**

`packages/session-store/src/shadow-git/reverse-patch.ts`（核心，不依赖 Electron）+ `apps/electron/src/main/lib/workspace-shadow-restore.ts`（编排）+ `restore-journal.ts`（崩溃可见性）。按设计只给内部入口，不动用户流程。

**判定顺序（顺序本身就是安全策略）**

1. `attribution !== 'confirmed'` → 不动（Bash/外部进程/用户手改都在这一档）
2. `record.partial` 且 `status === 'added'` → 跳过（partial 语义 = 只恢复不删除）
3. 当前路径 `unknown`（读不到/非普通文件/是符号链接） → 保留 current
4. 边界对象读不到 → 整条跳过（不能把「读不到」当「没这个文件」）
5. 当前 blob sha == Agent 产物 sha → 直接恢复
6. 不同 → 三方合并（base=after, ours=current, theirs=before），冲突或无法合并 → 保留 current

**三条实现红线（都是真实会毁数据的地方）**

- 文件内容一律走字节流：`cat-file` / `merge-file -p` 的输出直接落盘再读。`GitCommandResult.stdout` 是 UTF-8 字符串，GBK/Latin-1 文件走一遍会被整段替换成 U+FFFD，而合并还会被判成 clean-merge，问题被完全掩盖。
- 相等判断用 blob sha（`hash-object --no-filters -- <path>`），不读全文：大文件不会把主进程内存打爆，也不受 `MAX_OUTPUT_BYTES` 限制。
- 写盘原子化 + 保留模式：临时文件 → chmod → rename。rename 保留的是临时文件的权限，不在 rename 前 chmod 会把 0600 的私密文件变成 0644。

**独立审查（子会话）发现的 7 条实测问题，全部已修**

| # | 问题 | 修法 |
| --- | --- | --- |
| 1 | 读失败被当成「文件不存在」，`deleted` 分支直接覆盖用户文件 | `CurrentState` 三态（file/absent/unknown），只有 ENOENT/ENOTDIR 算 absent；能 stat 但算不出摘要也归 unknown |
| 2 | 「before 读不到」与「before 里没这个文件」不可区分，`modified` 分支当删除处理 | `ls-tree` 区分「路径不存在」与「commit 不可读」，后者整条跳过（`boundary-unreadable`） |
| 3 | 非 UTF-8 文本经 stdout 解码后整文件被 U+FFFD 破坏 | `merge-file` 也用 `stdoutFile` 落盘，全程字节 |
| 4 | `record.partial` 完全没被读取 | partial 时禁止 `added` 的删除动作 |
| 5 | 文件模式全部丢失（0755→644、0600→644） | 从 `ls-tree` 取 mode，恢复用 before 的 mode，改写保留当前 mode |
| 6 | 单文件 fs 错误抛出 → 整轮中断 + journal 永远 pending | 每条变化独立 try/catch → keep-current（`write-failed`）；facade 无论如何都写结论 |
| 7 | `maxMergeBytes` 在整文件读入内存后才检查 | 先 `stat`/`cat-file -s` 判大小，超限直接 keep-current |
| 8 | 判定与写盘之间可被覆盖（TOCTOU） | 写盘前比对 `dev/ino/size/mtime`，变了回落 `concurrent-modification` |

两条审查确认非缺陷：CRLF / BOM / 末行无换行由 `git merge-file` 正确处理；`..` 路径被 git 拒绝，无法跨 root 读 blob。

**已知缺口（Phase 4/6 处理，不是当前 bug）**

- 重命名没有配对（`--no-renames` 只产 D+A）：若用户改过新路径，会出现「新旧两份」。设计 §5.5 要求两边都确认才做完整逆向，留到有 rename 配对时实现。
- 崩溃中断的保护快照存在，但没有「自动续做」：`restore-journal.jsonl` 会留 `interrupted` 供诊断，文件状态靠保护快照人工核对。

**验证**

```text
packages/session-store  107 pass / 0 fail（14 文件）
  shadow-git-reverse-patch.test.ts 15 pass
    · 六个正向场景（改后未动/新建/新建后改/删除/删除后重建/非重合合并）
    · 冲突保留 current 且不写冲突标记
    · unconfirmed 不撤销、dryRun 不写盘
    · 权限不足不覆盖、边界不可读整条跳过、GBK 字节不变
    · partial 不删除、0755 保留、路径变目录不报错
apps/electron            89 pass（5 文件）
  workspace-shadow-restore.test.ts 4 pass
    · 删除 Agent 新建文件 + journal pending→completed + 保护快照
    · rewind-before 早于 rewind-after
    · dryRun 不写盘不写 journal
    · 无归属记录时拒绝执行
根 typecheck            16 个包全 0
```

**为什么每次回退要跑两遍判定**：第一遍（dryRun）把计划写进 journal 的 `pending`，第二遍才真正写盘。多花一次只读计算，换来「进程被杀后知道原本打算动哪些文件」。回退是低频、高风险的写操作，这个交换值得。

**dev 真机尚未验证**：Phase 3 是内部入口，dev 上没有触发路径；真实数据验证放在 Phase 4 接入回退流程时一起做。目前所有结论来自真实 git 仓库 + 真实文件系统的集成测试。

**真机验证（2026-11-09，dev 实例）**

脚本 `scripts/verify-shadow-restore-dev.ts`（不在 dev 配置里注册工作区，避免污染用户索引）：

```text
生命周期 10 项断言全 pass（probe 目录 ~/.profer-dev/agent-workspaces/shadow-p3-probe/）
  restored-verbatim 且模式保持 0744（没被 rename 打回 0644）
  clean-merge 两边保留 / conflict-kept-current 且无冲突标记
  edited-after-turn / recreated-after-turn / partial-evidence / boundary-unreadable
  journal: rewind-before(#2) 早于 rewind-after(#3)，pending.outcomes 非空
  二次运行全 already-restored（幂等）
真实 dev 数据（只读 dryRun 压测，3 次运行结果一致）
  2 工作区 / 7 条记录 / change 2（confirmed 1）/ 抛错 0 / boundary-unreadable 0
dev 重启两次
  启动对账 4/4 成功、0 失败（846ms / 843ms），重启前后记录统计与 turns.jsonl mtime 不变
```

**真机暴露的缺陷（已修）**：Phase 2-B1 之前的归属记录**没有 `roots` 快照**（7 条真实记录里 3 条），`workspace-shadow-restore.ts` 直接 `record.roots.map(...)` 会抛 TypeError。修法分两层：

- 读取边界补齐：`readShadowTurnAttributions` 把缺失的 `roots`/`changes` 归一成空数组（磁盘上的历史行不会自己长出字段，下游不该各自防御 undefined）；
- 编排层显式判定：`changes` 为空直接早退（不采保护快照、不写 journal）；`roots` 为空但有变化时拒绝执行并说明「无法安全定位文件」。

这条缺陷只在真实历史数据上才会出现——临时目录造出来的记录永远带齐字段，这是必须跑真机的原因。

### 12.12 Phase 4：把文件回退接进当前 session 回退（2026-11-09）

**改动面**

| 文件 | 变化 |
| --- | --- |
| `packages/shared/src/types/agent-rewind.ts` | `RewindPlan` 增加可选 `shadowTurns?: string[]` |
| `apps/electron/src/main/lib/workspace-shadow-rewind.ts`（新） | 目标 → 需要撤销的 turn；逐轮执行的封装 |
| `agent-rewind-service.ts` | 新增可选 `ports.shadow`；计划带 `shadowTurns` 时走工作区回退，跳过旧的文件内容通道 |
| `agent-rewind-host.ts` | resolver 用工作区历史产出文件计划；`shadow.apply` 接进端口 |
| `RewindDialog.tsx` | 改为一次确认；打开即准备；文件不可用静默降级 |

**关键决策**

- **文件来源只剩工作区历史**：旧 D4 证据链（tool_use → 内容引用）不再驱动写盘。它既不知道「用户后来改过」，也无法做非重合合并，越早停用越安全。legacy 端口保留但不再被 shadow 计划触达（测试里一旦调用就抛错）。
- **`shadowTurns` 而不是 `targetRevision`**：工作区回退不需要「目标版本的整份内容」，它在执行时按 before/after/current 现算。计划里假装有目标内容，会诱导后续实现走整文件覆盖。
- **从新到旧撤销**：turn N 的 `before` 就是 turn N-1 的 `after`；倒着撤完等于最早那个 turn 的 `before`。反过来会把中间态当基线。
- **中途失败就停**：后一轮的边界依赖前一轮的实际结果，带不确定状态继续撤会推到没人预测得了的位置；失败转成 `recovery-required` 并保留恢复记录，不谎报成功。
- **执行器缺失时拒绝执行**：计划要求动工作区但宿主没接 `ports.shadow`，报 `CAPABILITY_UNAVAILABLE`，而不是「只截断对话、文件没动」。
- **不给会骗人的按钮**：工作区回退不支持撤销、不支持按文件剔除，能力上报直接关掉（`supportsUndo/supportsRefine=false`），`undo`/`refine` 显式拒绝。旧的恢复流程只能把对话和按文件存的备份放回去，文件是三方合并改的——撤销会留下「对话回去了、文件没回」的半恢复状态。

**UI（设计 §8）**

主路径只有「确认回退？取消 / 回退」。去掉三选一、去掉「生成预览」、去掉目标 UUID 与文件清单。打开即准备；文件回退不可用（该会话还没记录过文件变化、工作区没接底座、目标早于记录起点）时静默降级成只回退对话，并在确认框里说明「本次只回退对话，文件保持不变」。结果只给一句轻提示，重合保留的文件用「N 个文件保留了你后来的修改」带过。

**验证**

```text
apps/electron  rewind + shadow 相关 82 pass / 0 fail（14 文件）
  agent-rewind-shadow.test.ts 6 pass
    both 计划带 shadowTurns、只调 shadow、legacy 文件端口一次没碰
    对话截断与文件回退共用同一个 recovery（journal applying→committed）
    工作区回退失败 → recovery-required，不谎报成功
    conversation 模式不带 shadowTurns
    能力上报关掉 undo/refine；refine 与 undo 显式拒绝
  workspace-shadow-rewind.test.ts 5 pass
    before-turn / after-turn / message 三种目标的边界换算
    同一路径多轮改动只出现一次；partial 的新建不删；unconfirmed 不动
    目标不存在、无记录时明确不可用（不猜边界）
  RewindDialog.test.tsx 3 pass
    只有一次确认；文案里没有内部词汇；同时交代「文件一起撤销」与「用户修改保留」
根 typecheck 16 包全 0；apps/electron build:main 通过；dev 重启后启动对账 4/4
```

**尚未验证**：真实点击回退的端到端路径。dev 远程 API 的 token 由 safeStorage 加密，脚本无法代用户发起对话或点击；AI 侧能验证到「计划正确、执行器接线正确、失败会如实上报」，最后一步需要人在界面上点一次。

### 12.13 Phase 4 收尾：调试通道、真机端到端、以及一个会删用户文件的前提错误（2026-11-09）

**1. 调试通道（自动调试入口 V0）**

`apps/electron/src/main/lib/debug-channel.ts`：`http://127.0.0.1:7791`，仅 dev、仅 loopback、每次启动随机 token（`<configDir>/debug-channel.json`，0600，请求头 `x-profer-debug-token`）。

| 端点 | 用途 |
| --- | --- |
| `GET /health` | 进程存活 |
| `GET /sessions` | 有归属记录的会话（含 turn 数、最后一轮 turnId） |
| `GET /attributions?sessionId=` | 某会话每轮的变化明细（状态/证据/根） |
| `POST /sessions` | 建会话（评测、自动验证用） |
| `POST /send` | 发一条消息，跑真实一轮 |
| `POST /rewind` | 走真实回退服务：`prepare`（`execute:false`）或 `prepare+execute` |
| `POST /restore-shadow` | 只做文件逆向 patch（不动对话） |

为什么需要它：会话截断要动内存里的 SDK 消息与 resume 边界，只有主进程跑一遍才算验证过。安全边界是「打包版没有这段代码 + 只监听 loopback + 随机 token + 路径白名单」，没有任意文件读写、没有命令执行。

**2. 真机端到端（dev，真实 Claude 会话）**

```text
建会话 → 发消息 → Agent 创建 p4-claude-probe.md（归属 recorded: added/confirmed）
回退到会话开始（mode=both）
  plan:  shadowTurns=['<user-msg-uuid>']  files=[delete p4-claude-probe.md]
         supportsFiles=true  supportsUndo=false
  exec:  status=committed  files.deleted=['p4-claude-probe.md']
  结果:  文件从磁盘消失；会话 JSONL 6 行 → 0 行
三方合并（真实 Claude 会话）
  基线上写 LINE1/2/3 → Agent 改第 1 行 → 模拟用户改第 3 行 → 回退
  结果:  entries=[(restore, clean-merge)]，最终 LINE1 baseline / LINE2 baseline / LINE3 user
```

**3. 真机暴露的前提错误（已修，重要）**

原先 `beginWorkspaceShadowTurn` 复用「上一轮 turn-after 就是本轮 before」，只在「用户不在两轮之间动文件」时成立。用户在两轮之间新建的文件不会被任何 turn-after 看到，于是：

- 树差异把「用户建的文件」记成 `added`（Agent 新建）；
- 撤「新建」= 删除文件 → **会删掉用户自己的文件**。

这是端到端跑出来的，单元测试造不出这个形状（临时目录里的 before/after 总是连续的）。两处修复：

1. **每轮开头都采 `turn-before`**（新增 capture reason）。代价实测 ~200ms/轮，换归属与合并建立在事实之上。ADR 记录里那句「before 不每轮采」作废。
2. **逆向后备判定**：即便记录是 `added`，只要证据带出了写入前的内容引用（`beforeRefs`），就标 `preexisting: true`，回退一律 `keep-current`（`preexisting-file`），绝不按「新建」删除。这是第二道防线——第一道（采集）失效时也不删用户文件。

**4. 边界只算一次**

会话层的 turn 标识是 `${sessionId}-T{n}`，归属记录里是用户消息 uuid。两套词表各解一次必然错位（真机第一次就错位了：文件回退静默不可用）。改为 `rewindBoundaryIndex(turns, target)`（从 `agent-rewind-claude` 导出）算一次「最后保留那轮的下标」，文件侧只按 `fromTurnIndex` 切片。

**5. 仍不可用：Pi 会话的对话回退**

`ports.session.read` 只认 `claude`（Pi 返回 undefined），所以 Pi 会话连 `mode:'files'` 都会被 `SESSION_NOT_FOUND` 挡住。Pi 的 transcript 截断（主 JSONL + `-pi-harness.jsonl` + resume 边界）还没实现，Phase 5 处理。

**验证**

```text
packages/session-store  109 pass / 0 fail（14 文件）
apps/electron（rewind+shadow）82 pass / 0 fail
根 typecheck            16 包全 0
dev                     重启后启动对账 4/4；调试通道 7791 可用；真实回退端到端通过
```

**遗留**：验证过程中建了几条标题以 `P4` 开头的测试会话，留在 dev 会话列表里未清理。

### 12.14 Pi 会话回退（主战场，2026-11-09）

Claude 之前是唯一能回退对话的 runtime，而 Pi 才是主要使用场景。这一步把 Pi 补成第一等公民。

**为什么必须物理截断**

Pi 的上下文由它自己的 session 文件决定（`piSessionDir` 下的 `*.jsonl`：首行 `{type:"session",id}`，其后每行是 `{id,parentId,...}` 的树）。SDK 的 `SessionManager.branch(entryId)` **只改内存 leaf**，不落盘（`dist/core/session-manager.js:1069`，且 entry 不可修改/删除）。只调 branch，重启后 leaf 会回到文件末尾 —— 回退等于没做。所以：

- 只保留 `header + 从根到分支点的祖先链`，其余行移入 `<file>.rewind-backup-<ts>`；
- 原子写（临时文件 + rename），解析失败/entryId 不存在一律不写；
- 坏行跳过并计数，不让一行坏数据毁掉整个文件。

**接线**

- `packages/agent-provider-pi/src/pi-transcript-rewind.ts`（新，252 行）：`findPiSessionFile` / `rewindPiTranscript`；
- `agent-rewind-host.ts` 的 `ports.session.read/resolveTarget/writeConversation` 放开 Pi；`writeConversation` 顺序固定为「先解析分支点（只读）→ 截 Profer JSONL → 截 Pi 文件 → 写 meta」，解析失败时不会留下半截状态；
- 分支点来自 `pi-tracker.json` 里 `turnId（用户消息 uuid）→ terminalEntryId`。

**顺带修的两个真 bug**

1. `rewind-evidence.ts`：新建文件的 `before` 曾用空 `Uint8Array` 表示 absent，宿主按真值判断得到「存在但空」的版本 → 归属记录带上 `beforeRefs` → `preexisting:true` → 回退永远保留、不删文件。改为 absent 只由 `kind` 表达。
2. 边界换算：Pi 一轮可能有多条 assistant 消息，`boundaryIndex+1` 会按 assistant 下标算轮次，导致整段漏撤。改为按用户轮 uuid 定位。

**真机 e2e（dev 通道，runtime=pi）**

```text
会话 0fd0e69d：turn1 建 p5-pi-probe.md
  回退前：文件 12B / Profer JSONL 5 行 / Pi 文件 8 行
  plan(session-start,both)：shadowTurns 1、files delete 1、removed 4
  execute：committed，deleted 1
  回退后：文件消失 / Profer 0 行 / Pi 1 行（仅 header）+ backup
  续聊：同一 sessionId 继续，新 turn 记录正常（Profer 5 行 / Pi 8 行）
消息级回退（会话 a15a2f07，3 轮）
  plan removed turn3 6 条、files delete p5m-3.md
  execute committed：Profer 19→11、Pi 20→14（leaf = turn2 终态）
  续聊建 p5m-4.md 成功（Profer 18 / Pi 20）
```

**遗留**

- Pi 的 undo 仍显式报错（不静默）；截断备份文件没登记进 recovery，撤销需人工恢复；
- 回退目标是「轮内中间 assistant」时只能保留整轮（锚点是轮终态）；
- 截断后 tracker/会话绑定里残留旧条目（只被已删消息引用，无害）；
- Pi 自身 append 与回退之间没有 provider 级锁。

### 12.15 Pi 原生：写入权归 Profer（2026-11-09）

上一版（§12.14）是「SDK 写、Profer 事后截断并校验」，这等于不掌握写入权，所以才需要「条数不符就还原」。这一版把关系倒过来。

**SDK 侧证据**：`SessionManager.inMemory(cwd, opts, entries)` 构造 `persist=false`，`_persist()` 首行 `if(!this.persist||!this.sessionFile)return`（`dist/core/session-manager.js:740/1274`）。对照实验：`open()` 与 `inMemory + parseSessionEntries` 的 `buildContextEntries()` 逐字节相等；inMemory 上 append 后文件 mtime 不变。**SDK 可以完全不写盘。**

**做法**
- 新增 `pi/session-file-store.ts`：Profer 独占写正式文件（header + 追加 entry），`flush()` 幂等，镜像 SDK「无 assistant 前不落盘」语义，并处理旧版本 header 迁移回写；
- adapter 改用内存态会话，在「工具结果 / 正常结束 / 异常 / 中断 / 消费方提前退出」五个时间点 flush；
- 回退 = 按 Profer 保留历史**纯重建** Pi 文件：删掉派生校验与备份还原（留着就是两套真相）；
- 崩溃只剩「正在跑的那一条工具调用」可能丢；实测一个 turn 内多次 flush（`+6/+2/+2`），不是轮末一次性写。

**跨 runtime 从「失败可见」改为「无法产生」**
- 判据唯一来源 `resolveAgentRuntimeChannelConflict`（shared），入口：`agent-orchestrator.ts:1519`、`agent-runtime-host.ts:872`、meta 写入 `agent-session-ui-projection-publisher.ts:47`；
- UI：`ModelSelector` 增加 runtime 维度，跨内核渠道置灰并写明「仅支持 Claude 引擎」，键盘导航跳过；
- 已存在的混血会话**不静默修复、不删除**：启动后只读审计（`agent-transcript-audit.ts`）上报（dev 267 会话中 54 个条数不一致，10 个跨内核）。
- 用户可见文案：`该模型不能用于当前会话: 当前会话使用 Pi 引擎，所选渠道「…」只支持 Claude 引擎；请新建会话后再选择`。

**真机 e2e**：pi 会话发一轮 → Pi `+7`，Profer 对话 4 = Pi 4；跨内核发送被拒且 Pi 文件未变；`rewind both/session-start` → committed、Pi 仅 header、无 backup、无「派生条数不符」；续聊正常（Profer 6 = Pi 6）。

**遗留**：既有 54 个历史偏差只上报未修（UI 诊断入口未接线）；`piEntryBindings` 语义过期会误截；Pi 独有内容（system/thinking/compaction）无法从 Profer 历史重建。

### 12.16 Phase 5 第一刀：回退后的一次性上下文与缓存修复（2026-11-09）

重新生成/编辑重发的「事务复用」在 Phase 4 已经成立（renderer 先 execute 回退，再发同一条用户消息）。这一刀补的是**回退之后**：模型凭什么相信当前工作区、以及哪些派生数据必须跟着退。

**1. provider continuation 的消费时机（真 bug）**

`resumeAtMessageUuid` 原来在 `sendMessage` 的 step 4 就被清掉，然后才去建 provider 查询。如果本轮在「provider 真正 resume 之前」失败（凭证、SDK 二进制、分支点无效），边界已经丢了：下一次发送会直接 resume provider 自己的 session 末尾——**被截断的历史静默回来**。现在改成：

- step 4 只读不清；
- `readAgentStreamNext` 吐出第一条 runtime 消息（= provider 已接受 `resumeSessionAt`）时才清，且只有值仍等于本轮读到的那个才清（避免清掉并发写入的新边界）；
- resume 失败恢复（`prepareResumeFallbackRecovery`）改用「按截断后的 Profer 历史回填」，同时清掉 `resumeAtMessageUuid`，不留一个没有对应 provider 会话的截断点。

**2. 不可见上下文（`agent-rewind-notice.ts`）**

回退可能因为用户改动而保留文件（三方合并 `keep-current`、`edited-after-turn`、`preexisting-file`）。模型看不到这个动作，会按「回退前自己写了什么」继续推理。现在：

- `afterExecute` 端口在回退写盘后生成 `AgentRewindNotice`（保留路径去重排序、上限 20 条、带真实总数），写进 `AgentSessionMeta.pendingRewindNotice`；
- 下一轮 `promptMode === 'standard'` 时拼成 `<workspace_rewind_notice>` 段落，**只进 runtime prompt**，Profer 的 JSONL / UI / 投影都看不到；
- 与 resume 边界同一时机消费（首条 runtime 消息后清除），失败 run 不会吃掉它；
- `recovery-required` 不生成 notice：语义是「没撤完」，不能给模型一个「已经回到已知状态」的假前提。

**3. 派生缓存修复（`agent-rewind-cache.ts`）**

逐个核过现有「缓存」，真正会残留的只有两处，其余都是每次现读：

| 数据 | 结论 |
| --- | --- |
| 上下文拼装 | `buildContextPrompt` 每次读 JSONL，无需重建 |
| 导航索引 | 内存缓存，按 `size:mtimeMs`；显式 `invalidateAgentSessionNavigationIndex` |
| 回溯水位 `lastAnalyzedTurn` | 单调计数；回退删掉尾部轮次后必须拉回，否则新轮次永远追不上（`turns.length <= lastAnalyzed` 一直跳过） |
| 标题 | 不动。自动命名首轮即定稿，回退不应静默改掉用户认得的会话名（用户仍可手动重新生成） |
| 用量 | 存在 assistant 消息里，随截断一起消失，无独立缓存 |
| 文件索引 | 渲染层 diff/消息刷新已在 Phase 4 接线；preview 每次从磁盘读 |
| Pi harness 账本 | 只追加遥测，不进模型上下文，裁剪反而丢证据 |

**验证**

```text
新增 agent-rewind-notice.test.ts        9 pass（notice 生成/截断/标签逃逸；prompt 不含内部词）
新增 agent-rewind-cache.test.ts         4 pass（水位只降不升、幂等、索引失效、会话已删不抛）
agent-rewind-service.test.ts           12 pass（afterExecute 在 committed journal 之后；抛错不改判 committed；recovery-required 也跑）
agent-rewind-*.test.ts + orchestrator-rewind 等 14 文件 81 pass / 0 fail
agent-session-manager*     66 pass / 0 fail
根 typecheck 16 包全 0
```

**真机 e2e（dev 通道，2026-11-09 14:50）**

```text
会话 A（pi/deepseek-flash）建 p5-notice-probe.md → 回退 session-start/both
  result: committed，deleted 1
  meta:   pendingRewindNotice{deletedCount:1}
  下一轮: log「注入回退上下文: 保留文件 0 个，撤销 1 个」→ 首条消息后 notice 清空
会话 B（pi）建 p5-kept-probe.md → 手工追加 USER-EDIT → 回退 session-start/both
  result: committed，conflicts=[.../p5-kept-probe.md]，文件保留（LINE1/2/3 + USER-EDIT）
  notice: keptPaths 含该文件，keptCount 1
  下一轮: Pi 会话文件里实际出现 <workspace_rewind_notice> 段落（含保留路径）→ 之后清空
会话 C（claude/claude-haiku-5-5）两轮：暗号 ALPHA-7731 → 改成 BETA-0000
  回退到 turn1 的 assistant（message 目标）：resumeAtMessageUuid=985a5231…
  下一轮问「暗号是什么」→ 回答 ALPHA-7731（不是 BETA-0000）
  → provider resume 真的截断了 turn2，已删历史没有回来；run 结束后 resumeAt 清空
```

**没做/边界**

- 新 runtime 链（`PROFER_RUNTIME_DESKTOP=1`、`agent-runtime-entry` 的四条 headless 入口）**不读** `resumeAtMessageUuid`，也不注入 notice。这是新链尚未下沉回退能力的既有缺口（Phase 6），本轮没有顺带改；桌面默认仍走旧编排器。
- 「重新生成 = 回退 + 重发」仍是两次 IPC：中间崩溃会留下「已截断、未重发」。真正的事务化要等 submitAfterRewind 端口接线。
- 标题不重建是产品取舍，不是遗漏（见上表）。

### 12.17 新 runtime 链：热启动与回退上下文（2026-11-09 15:10）

审查时发现的前提问题：新链（`agent-runtime-entry` / `agent-runtime-host`）**根本没有续写缝隙**，不只是「少了下沉回退」：

- `createRuntimeEntryQuery` 只挂 `persister`，从不把 `meta.sdkSessionId` 传成 `runtimeSessionId`；
- `runtimeSessionId` 的唯一来源是 `input.runtimeSessionId`（实际只有 Goal 隔离会话会传）；
- provider 因此拿不到 `resumeSessionId`：Pi 在 `pi-agent-adapter.ts:2103` 直接开新会话，Claude 同理；
- `packages/agent-runtime/src/coordinator.ts` 全文不读历史（`ports.getMessages` 未被使用）。

结果是新链每一轮都是「无历史冷启动」——真机上表现为「它忘了上一轮」，且 provider 侧缓存每轮重建。

**做法（`agent-runtime-host.ts` + `agent-runtime-entry.ts`）**

1. `ElectronAgentRuntimeQueryOptions` 增加 `runtimeSessionId` / `resumeSessionAt` / `promptPrefix` / `promptOverride`；
2. 入口只读一次 meta：非隔离会话 `runtimeSessionId = meta.sdkSessionId`，隔离会话仍用 `input.runtimeSessionId`；
3. `resumeAtMessageUuid` → `providerInput.resumeSessionAt`（只在有 resume 时生效）；`pendingRewindNotice` → `promptPrefix`（只拼进本轮 prompt，`persistedUserMessage` 仍是原始用户输入）；
4. 首条 `assistant` / `user` 消息后消费一次性状态（与旧链同口径），失败 run 不会吃掉边界；
5. resume 失效（`No conversation found`）且本轮尚未开始：清 `sdkSessionId` + `resumeAtMessageUuid`，用旧链同一份 `buildRecoveryPrompt` 重建一次；第一次失败不向调用方投递错误。已开始产出工具副作用的轮次不重试。

**验证**

```text
新增 agent-runtime-entry-warm-start.test.ts  4 pass
  热启动 + notice 注入 + 首条消息后消费；隔离会话忽略回退状态；
  resume 失效重建一次且首次失败不外泄；非 resume 失败原样重放
agent-runtime-* / workspace-guard / unread-callsites（--isolate）218 pass
真机（dev + PROFER_RUNTIME_HEADLESS=1，pi/deepseek-flash）
  两轮：暗号 GAMMA-1234 → 第二轮答 GAMMA-1234；Pi 会话文件数 262 → 262（没有新建）
  跨链：旧链回退产生 notice → 重启到新链 → Pi 会话文件里出现同一段 <workspace_rewind_notice>，meta 随后清空
```

**仍未做（新链文件回退）**

`beginWorkspaceShadowTurn` / `endWorkspaceShadowTurn` 与工具级 `pushShadowEvidence` 只接在旧编排器里。新链没有归属记录 → 文件回退在新链上显式不可用（不是静默降级）。补齐它需要把「turn 前后采集 + 工具写入证据」下沉到 `runRuntimeHeadlessEntry`，属于下一步。
