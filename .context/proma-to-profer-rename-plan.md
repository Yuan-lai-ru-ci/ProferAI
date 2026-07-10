# Profer 全面去 proma 化重构计划（B 阶段）

> 状态：规划中 / 分批推进
> 创建：2026-07-10
> 关联：A 阶段（userData 隔离 + copy 迁移）已完成，见 `apps/electron/src/main/index.ts` 顶部。

---

## 1. 背景

Profer 于 2026-06-21 从开源 Proma 改名，但只改了「门面」（productName、appId、exe 名、UI 标题、`~/.profer` 配置目录、注册表 device_id 命名空间）。代码层仍大量残留 `proma`：

- **包名 scope `@proma/*`**：7 个 workspace 包，源码引用 **417 处**（+ 各 package.json deps + `bun.lock`）。
- **运行时 `proma` 字符串**：光 `apps/electron/src/*.ts` 就 **527 处**，横跨 CSS 类名、自定义协议、localStorage key、资源目录名、哨兵常量等。

> ⚠️ 关键认知：**这些改名对「两个软件能同时开」没有任何贡献**——那个问题已由 A 阶段的 userData 隔离解决。B 阶段是纯粹的**命名规范收敛 / 品牌一致性**重构，收益是「代码里不再看到 proma」，不是修 bug。因此可以慢慢来、分批做、每批独立验证。

## 2. 目标

把项目里的 `proma` 标识按类别、分批替换为 `profer`，做到：
- 每批**独立可验证、可回滚**，绝不与其它改动耦合；
- 涉及运行时状态的批次**带向后兼容/迁移**，不给存量用户制造新的「数据失联」坑；
- 全程构建/类型/样式不破。

## 3. 铁律（每批都遵守）

1. **一批一分支一 PR**：每个批次单独提交，标题标明批次号，便于二分定位回归。
2. **先机械替换、后跑全套验证**：`typecheck` + `build` + 关键路径手测，全绿才合。
3. **区分「纯标识」与「有状态标识」**：
   - 纯标识（包名、CSS 类、内部常量）→ 直接改，无兼容负担。
   - 有状态标识（localStorage key、协议 token、磁盘/注册表路径）→ **必须评估存量数据**，要么保留读旧+写新的兼容层，要么写一次性迁移。
4. **不碰 A 阶段的 userData setPath**，直到 B 全部完成再统一收尾（见批次 5）。

---

## 4. 批次划分（建议按此顺序）

### 批次 1：包名 `@proma/*` → `@profer/*`（最低风险，先做）

**为什么先做**：纯开发期标识，运行时零影响，机械性最强，做完能立刻消除最大一块（417 处）视觉噪音。

**7 个包**（改各自 `package.json` 的 `name` + 所有引用方的 `dependencies` + import 语句）：

| 包 | 源码引用数 | 备注 |
|---|---|---|
| `@proma/shared` | 360 | 最大头，改动集中在 import 与类型引用 `import('@proma/shared')` |
| `@proma/core` | 25 | |
| `@proma/project-core` | 22 | |
| `@proma/session-core` | 19 | |
| `@proma/ui` | 8 | |
| `@proma/cli` | 1 | |
| `@proma/electron` | 1（自身定义） | **改这个会让 `app.getName()` 变为 `@profer/electron`** → userData 默认路径变化，见批次 5 |

**改动点清单**：
1. 7 个 `packages/*/package.json` 与 `apps/*/package.json` 的 `"name"` 字段。
2. 所有 `package.json` 里对 `@proma/*` 的 `dependencies` / `devDependencies` 引用。
3. 所有源码 `from '@proma/xxx'`、`import('@proma/xxx')` 类型引用（可脚本批量 sed，但需 review 假阳性）。
4. 根 `package.json` 的 scripts：`"dev": "bun run --filter='@proma/electron' dev"` 等所有 `--filter='@proma/...'`。
5. `tsconfig*.json` 的 `paths` / `references`（若有按包名映射）。
6. `.github/` CI 工作流里任何 `--filter=@proma/*` 或包名硬编码。
7. `electron-builder.yml` 的 `files` glob（若按包名匹配 node_modules）。
8. **重新生成 `bun.lock`**：`bun install`，确认 workspace 链接正确。

**兼容风险**：低。无运行时状态。唯一联动是 `@proma/electron` 改名会改变 `app.getName()`（详见批次 5，建议**把 electron 包改名放到最后或与批次 5 合并**，其余 6 个包先改）。

**验证清单**：
- [ ] `bun install` 无 workspace 解析错误
- [ ] `bun run --filter='@profer/electron' typecheck` 全绿
- [ ] `bun run build`（main/preload/renderer/cli/resources）全部成功
- [ ] `grep -rn "@proma/" apps packages --include=*.ts --include=*.tsx | grep -v node_modules` 归零（electron 包名若延后则只剩它）
- [ ] dev 启动应用，核心流程（新建会话、发消息、工作区切换）正常

**回滚**：`git revert` 整个 PR；`bun.lock` 一并回退。

---

### 批次 2：CSS 类名 / DOM 标识 `proma-*`

**范围**：`proma-code-block--mermaid`、`proma-screenshot-sheet`、`proma-move`、`proma-preview`、`proma-frontend` 等前端类名/选择器。

**风险点**：类名是 **TS/TSX 与 CSS/样式文件两处约定**，改一处漏一处 → 样式静默失效（不报错、只是难看）。必须成对改。

**改动点清单**：
1. 全量列出：`grep -rhoE "proma-[a-z-]+" apps/electron/src | sort -u`，逐个归类（哪些是 CSS 类、哪些是协议/资源，后者归批次 3）。
2. 对每个 CSS 类：同时改 `.tsx`/`.ts` 里的 `className`/`querySelector` 与对应的 `.css`/`styled` 定义。
3. 注意动态拼接的类名（模板字符串 `\`proma-${x}\``）——grep 可能漏，需搜 `proma-` 前缀拼接。

**验证清单**：
- [ ] `grep -rn "proma-" apps/electron/src` 仅剩批次 3/4 归属项
- [ ] 逐个受影响组件目测：mermaid 代码块、截图面板、预览、拖拽等样式正常
- [ ] 明暗主题都检查

**回滚**：单 PR revert。

---

### 批次 3：自定义协议与资源标识（有兼容负担，谨慎）

**范围**：
- `proma-file://` 自定义协议（**15+ 处**）：`registerSchemesAsPrivileged`、`protocol.handle('proma-file', ...)`、CSP 头（`screenshot-service.ts` 的 `img-src ... proma-file:`）、preload 暴露的注册 API、`local-file-protocol.ts` 里生成 URL 的 `\`proma-file://${token}\``。
- 资源目录 / 前缀：`proma-logos`（44 处，多为 logo 资源路径）、`proma-frontend` 等。

**风险点**：
1. **协议改名必须「全同步」**：privileged 注册、handler 注册、CSP 白名单、preload API、URL 生成——**漏任何一处，本地文件/图片/PDF 内联预览直接白屏**。改完必须逐一手测预览。
2. `proma-file://` 生成的 URL 是**会话内临时 token**（`local-file-protocol.ts` 每次生成），不落盘，所以协议改名**无跨会话兼容问题**——重启即用新协议，不需要迁移。这是可以放心改的前提。
3. `proma-logos` 若是打包进 app 的资源目录名，改名要同步 `electron-builder.yml` 的 `extraResources` / `files` 与代码里的读取路径。

**改动点清单**：
1. 定义一个常量（如 `PROFER_FILE_SCHEME = 'profer-file'`）替代散落字面量，一处改全局生效（顺带降低未来再改名成本）。
2. 全局替换 `proma-file` → `profer-file`：注册、handler、CSP、preload、URL 生成，共 15+ 处，逐一核对。
3. `proma-logos` 等资源：同步代码读取路径 + 打包配置。

**验证清单**：
- [ ] 本地图片内联预览正常（走 `profer-file://`）
- [ ] PDF 内联预览正常
- [ ] 截图/分享面板图片正常（CSP 未拦截）
- [ ] logo 在各处正常显示
- [ ] `grep -rn "proma-file\|proma-logos" apps` 归零

**回滚**：单 PR revert（无数据迁移，回滚零风险）。

---

### 批次 4：状态 key / 哨兵常量（有状态，需兼容或迁移）

**范围**：
- `proma-user-profile`（localStorage key，2 处：`AppShell.tsx` 读、`index.html` 首屏读）。
- 其它可能的 localStorage/sessionStorage key、内部哨兵常量（如历史上出现过的 `proma-built-in` 分组哨兵——需确认是否仍在用）。
- `app.getPath('temp')/proma-installers` 临时目录名（`installer-downloader.ts`、`storage-service.ts`）——temp 目录，无兼容负担，可直接改。

**风险点**：
1. `proma-user-profile` 是 **localStorage 缓存**，真实数据在 `~/.profer/user-profile.json`。直接改 key → 老缓存失联 → **首屏闪一次**（随即从 IPC 重载），无数据丢失。可接受，但更优雅是读时兼容旧 key：`localStorage.getItem('profer-user-profile') ?? localStorage.getItem('proma-user-profile')`，写时只写新 key，一两个版本后移除旧读。
2. 任何落盘/注册表的 key 改名都要走「读旧+写新」兼容层或一次性迁移，参考 A 阶段 userData 迁移与 `migrateFromPromaIfNeeded()`。

**改动点清单**：
1. 列全所有 `localStorage`/`sessionStorage` 的 `proma*` key。
2. 逐个：加兼容读（可选）+ 改写入 key。
3. `index.html` 内联脚本的首屏读取同步改。
4. temp 目录名 `proma-installers` → `profer-installers`（直接改，无兼容）。

**验证清单**：
- [ ] 冷启动（清 localStorage）首屏正常
- [ ] 从「旧 key 有值」状态升级：首屏不报错、profile 正常恢复
- [ ] 安装器下载/清理走新 temp 目录正常
- [ ] `grep -rn "proma" apps/electron/src` 仅剩批次 5 归属项

**回滚**：单 PR revert；若加了兼容读，回滚不影响旧数据。

---

### 批次 5：收尾 —— app 身份正本清源 + 撤除 A 阶段冗余

**前提**：批次 1 里 `@proma/electron` → `@profer/electron` 若已改，则本批与之合并；否则在此完成。

**做什么**：
1. 把 `apps/electron/package.json` 的 `name` 改成 `@profer/electron`（或加 `"productName": "Profer"`）。此后 `app.getName() === '@profer/electron'`，**默认 userData 自然就是 `%APPDATA%\@profer\electron`**。
2. **复核 A 阶段的 `setPath('userData', ...)`**：改名后 setPath 的目标与默认路径一致，`setPath` 变成冗余但无害的保险。**建议保留**（显式优于隐式，且防未来再被 productName 逻辑绕回去），仅更新注释说明「现在与默认一致，留作保险」。
3. **迁移逻辑 `migrateUserDataFromPromaIfNeeded()` 必须保留**：存量用户数据仍在 `@proma/electron`，这段一次性迁移长期需要（可加一个「迁移完成」标记文件，多版本后再考虑移除）。
4. 根 scripts / CI 的 `--filter='@proma/electron'` → `@profer/electron` 同步（若批次 1 未含）。
5. 全局终检：`grep -rn "proma" apps packages --include=*.ts --include=*.tsx --include=*.json | grep -v node_modules` 应仅剩**注释/文档/迁移兼容代码**里对历史 `proma` 的合法引用。

**验证清单**：
- [ ] 全套 build + typecheck 绿
- [ ] **打包生产版**，全新机器 & 存量数据机器分别启动：数据在、能与原版 Proma 同时开
- [ ] `app.getPath('userData')` 打印确认 = `@profer/electron`
- [ ] device_id、登录态、会话、自动任务全部正常

**回滚**：本批涉及 app 身份，单独 PR，充分灰度后合并。

---

## 5. 全局注意事项

- **合法保留的 `proma`**：迁移兼容代码里对 `@proma/electron` / `~/.proma` / 旧 key 的引用是**故意保留**的，终检时白名单排除，不要「清干净」把兼容层删了。
- **`~/.proma` vs `~/.profer`**：配置目录早已迁移（`config-paths.ts` + `migrateFromPromaIfNeeded`），B 阶段**不要动**这块，只处理代码标识。
- **顺序建议**：批次 1（除 electron 包）→ 2 → 3 → 4 → 5（含 electron 包改名）。每批合并后跑一次完整回归再开下一批。
- **不赶**：这是规范收敛，不是修 bug。任何一批没把握就停下单独 grill。

## 6. 进度追踪

各批次进度见 Proma 任务列表（本计划配套创建的批次任务）。

