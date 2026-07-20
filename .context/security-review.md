# Profer v0.14.23 安全与质量审查报告

**审查时间**: 2026-07-18 16:39  
**审查版本**: v0.14.20 → v0.14.23 (未提交)  
**审查范围**: 工作树 47 个文件改动 + 5 个新增文件

---

## 🔴 高风险问题（需立即处理）

### 1. 版本号跳跃异常

**现象**:
- `apps/electron/package.json`: `0.14.20` → `0.14.23`
- 跳过了 3 个版本号（0.14.21, 0.14.22 未使用）
- 最新 commit 是 `d30d3456 chore: bump version to 0.14.20`

**风险**:
- 版本号不连续会导致用户困惑
- 可能与自动更新系统的版本比较逻辑冲突
- 如果 0.14.21-0.14.22 被其他分支占用，会造成版本冲突

**建议**: 回退到 `0.14.21`，除非有明确理由跳版本

---

### 2. 工作树状态混乱 ⚠️ **严重**

**现象**:
```
Your branch and 'origin/main' have diverged,
and have 25 and 1 different commits each, respectively.
```

- 本地领先远程 25 个 commit
- 远程领先本地 1 个 commit: `d8dbc8fc release: v0.14.5 [auto-release]`
- **这个远程 commit 的版本号是 0.14.5，远早于当前的 0.14.20**

**根本原因**: 远程仓库可能被强制回滚过，或者有平行的发布分支

**风险分析**:
1. **版本历史混乱**: v0.14.5 出现在 v0.14.20 之后，说明远程仓库历史不连贯
2. **潜在的代码丢失**: 如果直接 pull，可能引入冲突或丢失本地改动
3. **自动发布系统可能失控**: `[auto-release]` 标签表明这是自动触发的

**建议**:
1. **先强制推送覆盖远程** (确认本地 25 个 commit 是有效的):
   ```bash
   git push origin main --force-with-lease
   ```
2. **或者创建新分支保留当前工作**:
   ```bash
   git checkout -b backup/pre-paperpipe-integration
   git push origin backup/pre-paperpipe-integration
   ```

---

### 3. 计费中间件大幅改动（可能影响收入）

**改动**: `server/src/middleware/credit-gate.js`

**新增逻辑**:
- **DB 故障容错**: 正常时 DB 查询失败放行（可用性优先）
- **连续失败 ≥5 次（60s 内）** → 切换为拒绝模式（计费安全优先）

**风险分析**:

✅ **好的方面**:
- 防止 DB 故障时无限放行导致免费使用
- 有自动恢复机制

⚠️ **潜在问题**:
1. **60s 窗口可能太长**: 如果 DB 瞬断（1-2 秒），前 4 次失败会被放行，第 5 次才拒绝
2. **无持久化**: 进程重启后计数器归零，攻击者可以通过频繁重启容器绕过
3. **单实例假设**: 如果多容器部署（负载均衡），每个容器独立计数，实际阈值被放大
4. **缺少告警**: 没有推送通知或日志聚合，可能长时间不知道 DB 故障

**代码示例问题**:
```javascript
// 风险：_consecutiveFails 和 _denyMode 是模块级变量
// 多个请求并发时，计数可能不准确（虽然 Node.js 是单线程，但异步并发仍可能有问题）
let _consecutiveFails = 0
let _firstFailTime = 0
let _denyMode = false
```

**建议**:
1. 缩短窗口到 10-15 秒
2. 达到阈值时发送 webhook/邮件告警
3. 考虑用 Redis 共享计数器（多容器场景）
4. 添加测试用例覆盖这个逻辑
5. **立即部署后监控计费日志，确认没有异常放行**

---

### 4. 新增公开 API 端点（可能泄露定价信息）

**新增**: `server/src/routes/public/plans.js`

**暴露的数据**:
```javascript
GET /v1/public/plans  // 无需鉴权
{
  plans: {
    standard: { monthlyRmb: X, yearlyRmb: Y, welcomeBonus: A, dailyDrip: B },
    plus:     { monthlyRmb: X, yearlyRmb: Y, welcomeBonus: A, dailyDrip: B },
    pro:      { monthlyRmb: X, yearlyRmb: Y, welcomeBonus: A, dailyDrip: B }
  },
  vip: { price: X, discount: Y, extraDrip: Z }
}
```

**风险评估**:

⚠️ **潜在问题**:
1. **定价透明化**: 竞争对手可以实时监控你的定价策略
2. **缺少 CORS 控制**: 任何网站都可以调用这个接口
3. **缺少 Rate Limiting**: 可能被爬虫高频请求
4. **暴露内部配置**: `dailyDrip`, `welcomeBonus` 等运营参数全部可见

✅ **合理性**:
- 如果官网需要动态显示定价，这个接口是必需的
- 定价本身是公开信息，不是核心机密

**建议**:
1. 添加 CORS 白名单（只允许官网域名）
2. 添加速率限制（同 IP 每分钟最多 10 次）
3. 如果定价敏感，考虑官网构建时静态化，不暴露实时接口
4. 只返回用户可见的字段（隐藏 `dailyDrip`, `welcomeBonus` 等内部参数）

---

### 5. 大型功能未测试（论文知识库 paperpipe 集成）

**改动范围**:
- 新增 `kb-paperpipe.ts` (522 行)
- 新增 `kb-workbench-service.ts` (120 行)
- 新增 `server/src/routes/services/paperpipe.js` (~300 行)
- 删除 `kb-chunker.ts`, `kb-embedder.ts`
- 修改 7 个 IPC handler
- UI 大幅重构: `KnowledgeBasePanel.tsx` (145 行 → 325 行)

**状态**: ✅ 代码已完成，❌ **未做端到端测试**

**风险**:
1. **运行时错误**: 类型声明正确不代表运行时不会崩溃
2. **API 格式不匹配**: 服务端返回字段可能与客户端期望不一致
3. **数据迁移缺失**: 本地旧论文不会同步到服务端，用户升级后无法搜索
4. **性能问题**: 大 PDF 上传可能超时（MinerU 解析慢）
5. **状态同步问题**: 本地 workbench.json 与服务端 paperpipe 数据可能不一致

**建议**:
1. **必须先测试再提交**: 启动 dev 环境，测试一遍完整流程
2. 如果时间紧迫，可以拆分提交（类型修复先提，功能暂存）
3. **测试清单**（见 `.context/todo.md`）:
   - arXiv 论文导入
   - 本地 PDF 上传
   - 论文搜索
   - 收藏/标签/笔记功能
   - 删除论文
   - MCP 工具调用

---

## 🟡 中风险问题（建议修复）

### 6. 配置系统改造未验证兼容性

**改动**: 新增 `server/src/db/config-store.js` (261 行)

**影响**:
- `MAX_GRANT_AMOUNT`, `DAILY_GRANT_CAP` 等硬编码常量改为从 DB 读取
- Admin 充值接口调用 `getConfig('admin.dailyGrantCap')` 动态获取限额

**风险**:
1. **DB 中配置缺失**: 如果 DB 没有初始化这些配置，会返回 `undefined` 导致判断失效
2. **类型不安全**: `getConfig()` 返回类型未明确，可能返回字符串而非数字
3. **性能回退**: 每次充值都查 DB，原来是常量（内存）
4. **首次部署失败**: 生产服务器 DB 如果没有这些配置记录，充值功能会挂掉

**建议**:
1. 检查 `config-store.js` 是否有默认值兜底
2. 添加类型断言或 schema 校验
3. 考虑缓存配置（首次查询后缓存到内存，定时刷新）
4. **部署前先在生产 DB 插入配置记录**

---

### 7. 知识库 UI 大幅重构（可能影响用户体验）

**改动**: `KnowledgeBasePanel.tsx`

**新增功能**:
- 工作台状态（收藏、标签、笔记、阅读进度）
- 批量选择/操作
- 筛选/排序（按收藏、标签、日期）
- 笔记自动保存（防抖）

**风险**:
1. **复杂度激增**: 从 145 行 → 325 行，Bug 概率增加
2. **未测试**: UI 交互逻辑未验证（搜索、筛选、笔记保存等）
3. **状态同步**: 本地状态（workbench.json）与服务端（paperpipe）的一致性未验证
4. **性能问题**: 大量论文（>1000）时，筛选/排序可能卡顿

**建议**: 端到端测试，重点测试边界条件（空列表、大量论文、网络失败）

---

### 8. 渠道测试增加超时限制

**改动**: `channel-manager.ts`

**新增**:
```typescript
const CHANNEL_TEST_TIMEOUT_MS = 15_000
function withTimeout(init: RequestInit): RequestInit {
  return { ...init, signal: AbortSignal.timeout(CHANNEL_TEST_TIMEOUT_MS) }
}
```

**风险**:
- **Node.js 版本依赖**: `AbortSignal.timeout()` 需要 Node.js ≥17.3.0
- 如果用户运行旧版本 Node.js（如 16.x），会报错 `AbortSignal.timeout is not a function`
- Electron 内置的 Node.js 版本可能不支持

**建议**: 
1. 检查 Electron 版本对应的 Node.js 版本
2. 添加 polyfill 或改用 `new AbortController()` + `setTimeout()`
3. 兼容写法:
   ```typescript
   function withTimeout(init: RequestInit): RequestInit {
     const controller = new AbortController()
     const timeout = setTimeout(() => controller.abort(), CHANNEL_TEST_TIMEOUT_MS)
     init.signal?.addEventListener('abort', () => clearTimeout(timeout))
     return { ...init, signal: controller.signal }
   }
   ```

---

### 9. Kimi API 测试模型改动

**改动**: `channel-manager.ts`
```typescript
case 'kimi-api':
-  testModel = 'kimi-k2.6'
+  testModel = 'k3'
```

**风险**:
- 如果 Kimi API 还没有正式发布 `k3` 模型，测试会失败
- 用户可能看到 "模型不存在" 错误

**建议**: 确认 Kimi API 文档，验证 `k3` 是否可用

---

## 🟢 低风险问题（可延后处理）

### 10. 教程文档大幅简化

**改动**: `apps/electron/resources/tutorial.md`
- 从 73 行 → 34 行
- 删除了 Erlich Liu 的原版教程保留说明

**影响**: 用户可能觉得教程不够详细

**建议**: 如果删除了重要内容，考虑在官网补充

---

### 11. 未清理的临时文件

**untracked files**:
```
.context/handoff.md
.context/paperpipe-diagnosis.md
.context/todo.md
apps/electron/.context/
scripts/fix-bridge-*.py (4 个)
server/scripts/deploy-website.sh
server/src/db/config-store.js (已列入新增)
server/src/routes/account/config.js (已列入新增)
server/src/routes/admin/config.js (已列入新增)
server/src/routes/public/ (已列入新增)
```

**影响**: 污染工作树，不影响功能

**建议**: 提交前清理或加入 `.gitignore`

---

### 12. CRLF 警告（Windows 换行符）

**现象**: 多个文件出现 `LF will be replaced by CRLF` 警告

**影响**: 
- Git diff 可能显示整个文件改动（实际只是换行符）
- 跨平台协作时可能产生冲突

**建议**: 
1. 统一项目 `.gitattributes`:
   ```
   * text=auto
   *.js text eol=lf
   *.ts text eol=lf
   *.json text eol=lf
   ```
2. 或者在 `.git/config` 中设置:
   ```
   [core]
       autocrlf = input
   ```

---

## 📊 总体评估

| 维度 | 评分 | 说明 |
|------|------|------|
| **代码质量** | ⭐⭐⭐⭐☆ | 架构合理，但复杂度高 |
| **测试覆盖** | ⭐⭐☆☆☆ | 核心功能未测试 |
| **安全性** | ⭐⭐⭐☆☆ | 计费逻辑有风险，公开 API 需加固 |
| **兼容性** | ⭐⭐⭐☆☆ | 版本分叉、Node.js 版本依赖 |
| **可维护性** | ⭐⭐⭐⭐☆ | 文档齐全，但改动过大 |
| **发布准备度** | ⭐⭐☆☆☆ | 未测试 + 版本混乱 + Git 分叉 |

**综合建议**: 🔴 **不建议直接发布，需先解决高风险问题**

---

## ✅ 提交前必做清单

- [ ] **回退版本号到 0.14.21**（或明确跳版本理由）
- [ ] **处理 Git 分叉**:
  - [ ] 查看远程 `d8dbc8fc` commit 内容
  - [ ] 决定是强制推送覆盖远程，还是合并
- [ ] **端到端测试论文知识库**（至少完整走一遍流程）
- [ ] **审查 credit-gate.js 容错逻辑**，考虑缩短窗口 + 添加告警
- [ ] **为 /v1/public/plans 添加 Rate Limiting + CORS**
- [ ] **检查 config-store.js 默认值**，确保兼容性
- [ ] **验证 AbortSignal.timeout 兼容性**（Node.js 版本）
- [ ] **确认 Kimi API 支持 `k3` 模型**
- [ ] **清理临时文件**（.context/*.md, scripts/fix-bridge-*.py）
- [ ] **部署前在生产 DB 初始化配置**

---

## 🎯 建议的提交策略

### 方案 A: 分阶段提交（推荐）

```bash
# 0. 先处理 Git 分叉
git fetch origin
git log HEAD..origin/main  # 确认远程 commit
# 如果确认本地 25 个 commit 有效，强推覆盖远程:
git push origin main --force-with-lease

# 1. 回退版本号
# 手动编辑 apps/electron/package.json: 0.14.23 → 0.14.21

# 2. 先提交低风险改动（类型修复、教程更新）
git add apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git add apps/electron/resources/tutorial.md tutorial/tutorial-v2.md
git add apps/electron/package.json
git commit -m "fix: 补充类型导入 + 精简教程 + bump to 0.14.21

- 修复 ipc.ts 缺失的 SkillFileContent/SkillFileNode 类型导入
- 修复 preload/index.ts 缺失的 WorkspaceMemorySummary 等类型导入
- 精简教程文档（删除过时内容）
- 版本号: 0.14.20 → 0.14.21

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

# 3. 测试论文知识库，通过后再提交
(unset CLAUDE_CONFIG_DIR; bun run dev)
# 测试通过后:
git add apps/electron/src/main/lib/kb-*.ts
git add apps/electron/src/main/lib/config-paths.ts
git add apps/electron/src/renderer/components/knowledge-base/
git add server/src/routes/services/paperpipe.js server/index.js
git commit -m "feat: paperpipe 服务端集成 + 论文工作台

- 新增 kb-paperpipe.ts (522行): 代理到服务端 paperpipe-bridge
- 新增 kb-workbench-service.ts (120行): 本地收藏/标签/笔记/进度
- UI 重构 KnowledgeBasePanel: 批量操作/筛选/排序/笔记自动保存
- 删除 kb-chunker.ts, kb-embedder.ts (paperpipe 替代)
- 精简 kb-service.ts: 433 → 66 行 (仅保留 fallback)

混合方案:
- arXiv 论文 → paperpipe 服务端 (LaTeX 源码 + FTS5 搜索)
- 本地 PDF → MinerU 解析 + 上传 paperpipe
- 搜索: 服务端 FTS5 优先, fallback 本地关键词
- 工作台状态: 本地存储, 不同步服务端

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

# 4. 服务端改动单独提交（需先测试 + 加固）
# ⚠️ 提交前必须:
#   - 审查 credit-gate.js 逻辑
#   - 为 /v1/public/plans 添加 Rate Limiting
#   - 在生产 DB 初始化配置
git add server/src/db/config-store.js server/src/db.js server/src/db/schema.js
git add server/src/routes/admin/*.js server/src/routes/account/config.js
git add server/src/routes/public/plans.js server/index.js
git add server/src/middleware/credit-gate.js
git commit -m "feat(server): 动态配置系统 + 公开套餐 API + 计费容错

- 新增 config-store.js (261行): 系统配置 DB 持久化
- Admin 接口改用动态配置 (dailyGrantCap, maxGrantAmount)
- 公开套餐定价接口 /v1/public/plans (供官网调用)
- credit-gate 容错: DB 连续失败 ≥5 次切换拒绝模式

⚠️ 部署注意:
1. 先在生产 DB 初始化配置 (见 config-store.js CONFIG_SCHEMA)
2. 添加 Rate Limiting 到 /v1/public/plans
3. 监控计费日志, 确认容错逻辑正常

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"

# 5. 渠道管理改动
git add apps/electron/src/main/lib/channel-manager.ts
git commit -m "feat: 渠道测试超时 + Kimi k3 支持 + 套餐额度查询

- 添加 15s 超时到渠道测试请求
- Kimi API 测试模型: kimi-k2.6 → k3
- 新增套餐额度查询接口 (queryKimiPlanQuota 等)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### 方案 B: 暂存风险改动，只提交安全部分

把论文知识库和服务端配置改动暂存到新分支，先发布稳定版本:

```bash
# 1. 保存当前工作到新分支
git checkout -b feature/paperpipe-integration
git add -A
git commit -m "WIP: paperpipe integration + config store"
git push origin feature/paperpipe-integration

# 2. 回到 main，只提交低风险改动
git checkout main
git cherry-pick <类型修复的 commit>
git cherry-pick <教程更新的 commit>
git push origin main

# 3. 等测试通过后，再 merge feature 分支
```

---

## 🚨 紧急修复建议（如果立即要发布）

如果必须在今天发布，建议只提交以下安全改动：

1. **类型修复** (ipc.ts, preload/index.ts) — 不影响功能，纯修复
2. **版本号回退到 0.14.21** — 避免版本号混乱
3. **处理 Git 分叉** — 强推覆盖远程的错误 commit

**暂不发布**:
- 论文知识库 paperpipe 集成（未测试）
- 服务端配置系统（需要 DB 迁移）
- 计费中间件改动（需要监控验证）
- 公开套餐 API（需要加固）

---

## 🔗 相关文档

- 交接文档: `.context/handoff.md`
- 任务清单: `.context/todo.md`
- 诊断报告: `.context/paperpipe-diagnosis.md`
- 工作区 note: `~/.profer/agent-workspaces/profer/workspace-files/.context/note.md`
