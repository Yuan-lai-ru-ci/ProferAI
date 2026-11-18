# 主进程 bundle 的模块约束与发版门禁

> 2026-11-19 建立，起因是 v0.16.27 全通道发布后「双击无窗口、进程直接退出」。
> 相关报告：`workspace-files/.context/2026-11-19-v0.16.27-startup-crash-postmortem.md`（工作区级，不在本仓库）。

## 1. 硬约束

**主进程 `dist/main.cjs` 是 CJS bundle；对纯 ESM 包只能 `await import()`，不能静态 `import`。**

`apps/electron/package.json` 的 `build:main` / `build:main-commercial` 用 esbuild 打包，并把这些包标成 `--external`：

```
@anthropic-ai/claude-agent-sdk
@earendil-works/pi-coding-agent
@earendil-works/pi-agent-core
@earendil-works/pi-ai
```

external + 静态 `import` 的结果是 bundle 顶层出现 `require("@earendil-works/pi-coding-agent")`。这些包的 `exports` 只有 `import` 条件（纯 ESM），Electron 在**加载 `dist/main.cjs` 的第一时间**解析这个 require 就抛：

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in
  .../node_modules/@earendil-works/pi-coding-agent/package.json
```

应用因此走不到创建窗口那一步——用户看到的是「双击没反应」。

### 正确写法

```ts
// 需要 SDK 能力时：运行时动态 import，让 Electron 的 ESM loader 处理
const { parseFrontmatter } = await import('@earendil-works/pi-coding-agent')
```

参考实现：`src/main/lib/skill-routing.ts`（`createSkillRoutingSnapshot`、`probeSkillFrontmatterError`）。
反例（0.16.27 的事故点）：曾经在 `src/main/lib/skill-doctor.ts` 顶部写 `import { parseFrontmatter } from ...`。

> `import type { ... } from '@earendil-works/pi-*'` 是安全的：类型导入在编译后被擦除，不产生 require。

## 2. 为什么 typecheck / 单测 / 构建都拦不住

| 门禁 | 为什么放过 |
|---|---|
| `bun test` | 测试直接在 Bun 的 ESM 环境跑 TS，静态 import 该包完全合法 |
| `tsc --noEmit` | 类型解析走 `types` 条件，与 `require` 条件无关 |
| esbuild 构建 | external 只是原样保留 require 语句，构建本身成功 |
| 包结构 / 签名 / 更新元数据校验 | 只看产物形态，不启动应用 |

结论：**“能构建、能签名、能上传”与“能启动”是两件事，必须分别断言。**

## 3. 现在的三道门禁

### 3.1 构建期：`verify-build-target`

`node scripts/verify-build-target.cjs <oss|commercial> dist/main.cjs`

- 读 `dist/main.meta.json`（esbuild 产物），取出所有 `external + kind=require-call` 的 specifier；
- 对每个 specifier 执行 `require.resolve()`——与 Electron 加载产物时的解析行为一致；
- 命中 `ERR_PACKAGE_PATH_NOT_EXPORTED` 直接失败，并打印包名与原因；
- `pkg/subpath` 形式（如 `@earendil-works/pi-ai/compat`）同样覆盖，不再依赖硬编码包名白名单；
- metafile 缺失时退回 bundle 源码扫描（可能包含字符串字面量，仅作兜底）。

由 `build:main*` 之后的 `verify:build-target:<target>` 调用，`scripts/dist.ts` 的构建链第一步就带它。

### 3.2 打包后：启动冒烟 `verify:startup`

`bun run verify:startup`（实现在 `scripts/startup-smoke.ts`）

1. 定位解包产物：macOS `out*/[<arch>/]Profer.app`、Windows `out*/win-unpacked/Profer.exe`；
2. 用临时 `--user-data-dir` + `PROFER_CONFIG_DIR` 拉起应用（不碰用户真实配置）；
3. 通过 `PROFER_STARTUP_PROBE_FILE` 让主进程写探针（`src/main/lib/startup-probe.ts`）：
   `main-loaded`（bundle 求值走到 `index.ts` 顶部）→ `window-created`（主窗口已创建）；
4. 判定：出现 `window-created` 才算通过；命中 `ERR_PACKAGE_PATH_NOT_EXPORTED` / `App threw an error during load`、bootstrap 抛错、或超时没建出窗口，一律失败。

接入点：

- macOS 本地发版 `scripts/dist.ts`（`dist:mac*`、`push-mac-release.cjs`）打包与验证之后；
- Windows 发版链 `release:verify:windows` / `:unsigned`（`push-release.cjs` 使用）；
- OSS CI：macOS job 经 `dist:mac` 自动带上，Windows job 有独立 “Startup smoke” 步骤。

跳过开关 `--skip-startup-smoke` 只用于排查构建流程，不能用于正式出包。

### 3.3 手工自检（30 秒）

```bash
cd apps/electron && bun run build:main && \
  grep -c 'require("@earendil-works/pi-coding-agent")' dist/main.cjs   # 期望 0
```

想要更真实的现场：`bun run dev`，如果出现 `App threw an error during load` 就是同一类问题。

## 4. 新增 external 依赖时的检查清单

1. 看目标包的 `package.json`：`exports` 是否存在 `require` 条件（`"type": "module"` 且只有 `import`/`default` 即为纯 ESM）；
2. 纯 ESM → 主进程里只能 `await import()`，并确认调用点在异步函数里；
3. 若不是纯 ESM 且不希望它进 bundle，别忘了同步 `electron-builder.yml` 的 `files`，否则打包后 `Cannot find module`；
4. 跑 `bun run verify:build-target:<target>`，再跑一次 `bun run verify:startup`。

## 5. 事故索引

| 时间 | 事件 |
|---|---|
| 2026-11-18 21:37 | `e065abe6` 在 skill-doctor 引入静态导入 |
| 2026-11-18 23:44–2026-11-19 00:12 | v0.16.27 四套包发布（门禁全绿，无一步启动产物） |
| 2026-11-19 00:35 | 本机安装后无法启动，手动回退 0.16.26 |
| 2026-11-19 01:12–01:14 | 四条更新通道 + GitHub Release 回滚 |
| 2026-11-19 01:25 | 移除静态导入（`509669c5`） |
| 2026-11-19 | v0.16.28：恢复 `frontmatter-invalid` 诊断（走 `await import`）+ 通用构建门禁 + 启动冒烟 |
