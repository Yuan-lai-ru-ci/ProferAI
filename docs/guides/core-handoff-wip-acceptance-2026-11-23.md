# 新核优先、旧核兜底：WIP 集成验收

验收日期：2026-11-23（北京时间）。本记录针对本次本地集成快照，不代表安装包、发布或现用数据接管已完成。

## 运行契约

- 默认使用新 Core，关闭设备共享不停止本机执行。
- 保留旧桌面执行链。完全退出后以 `PROFER_LOCAL_CORE_MODE=legacy` 启动同一版本，可用于排障；移除该变量并重启恢复默认新核。
- 旧核在业务模块初始化前取得同根执行锁；已有 Core 持锁时拒绝启动，不抢占、不删锁。新核接管后断连不交还旧 writer，也不自动重发结果不明的写操作。
- `PROFER_LOCAL_CORE_MODE=independent` 仍是显式独立 Core 接入方式，Windows 独立入口门禁未开放。
- 切核前备份；同版本测试通过不表示任意旧版二进制支持新版数据。

## 本次失败清扫

1. 过期商业账号重启恢复遇到临时 503 时，保持 generation 不变才安排后台重试；覆盖后续成功、logout/dispose 与迟到响应。
2. 旧 writer 测试逐文件明确 legacy，不改变产品默认；源码抽取 fixtures 补齐模式和 usageRecorder 依赖，协作 mock 补齐现有导出。
3. 更新渠道目录归属断言，覆盖远程、独立本机和旧核；执行真实 Tab 重命名 handler，验证双击/菜单、裁剪标题及单次提交。
4. Goal 停止测试区分逻辑终态与 provider 资源退出：可控 finally gate 证明逻辑停止后仍保留 owner，等待 `stopAndWait()` 后才断言释放。未改 Goal 业务、未提前放锁、未增加 sleep。
5. 教程实际导航名称与设置页同步；受影响包 patch 与锁文件同步，Electron 保留当前待交付 `0.17.1-beta.2`。

## 实际验证

命令在仓库根执行，构建和运行日志保留在验收会话工作台。

| 层级 | 命令/操作 | 实际结果 |
|---|---|---|
| 全仓测试 | `bun test --isolate --timeout 30000` | **8408 pass / 11 skip / 0 fail**，8419 tests / 1019 files / 30562 assertions，230.18s |
| 全仓类型 | `bun run typecheck` | 全部通过 |
| 锁文件 | `bun install --frozen-lockfile --ignore-scripts` | 通过，未升级外部依赖 |
| 格式 | `git diff --check` | 通过 |
| Main/preload | OSS/commercial main、app/plugin preload、persistence worker 独立 bundle | 通过，OSS 输入图不含商业桌面账号实现 |
| Renderer | OSS 与 commercial 隔离 Vite build + 原有 edition 校验 | 两版通过 |
| 启动预算 | 按现有入口图口径统计 | OSS 3729.26 KiB / gzip 1140.16 KiB；commercial 3732.40 KiB / gzip 1141.34 KiB，均在 4096 / 1280 KiB 内 |
| Core 成品运行目录 | `build-runtime.ts --out <隔离目录>` + `smoke-runtime.ts <隔离目录>` | 通过；仓库外空 HOME/PATH，HTTP/WS 鉴权、事件恢复、Pi/native/WASM、SIGTERM 正常退出 |
| Electron 新旧交接 | 真实 Electron、隔离旧工作区及会话，依次新核→旧核→新核 | 三次 main-loaded/window-created，无 bootstrap-failed；writer 归属正确，历史保留，Core ID 相同，退出码0且执行锁释放 |
| 静态呈现 | 真实 React SSR + 构建 CSS，经正式文件预览 | 深浅主题、390/1100px 的 Core 设置、导航、Tab 样本及 EmptyState 检查；不是原生交互验收 |
| 默认 Skill 医生 | `bun run skill:doctor` | 0 error / 2 warning / 33 info；非本轮修改的 brainstorming 描述与 in-app-browser 版本不一致警告仍在 |

11 个 skip：Windows 独立入口/helper/PowerShell 8 项、当前平台大小写路径 2 项、npm Bun shim 环境 1 项。跳过不计为通过。

## 验收边界

- 未推送、发布、生成安装包、替换现用安装或迁移现用数据。
- 未执行 Windows 双普通账户、helper 成品或双机局域网验收。
- 未执行原生 GUI 人工点击、真实系统剪贴板、真实模型付费请求；本次 runtime 用例使用隔离配置和测试 transport。
- 静态样本不能证明真实 Tab 测宽/溢出、惯性滚动和焦点事件；Core 分段选择器的小命中区仍保留原设计。

## 原始证据入口

主会话：`/Users/mac/.profer/agent-workspaces/profer/80d25d25-ef38-4578-8f07-6778d711f46b/.context/wip-acceptance/`

- `full-suite-commit.log` / `full-suite-commit.exit`
- `typecheck-final.log`、`lockfile-check.log`、`fixes-independent.log`
- `bundles-final.log`、`renderer-{oss,commercial}-final.log`、`startup-budgets.log`
- `core-build-final.log`、`core-runtime-smoke-final.log`
- `electron-handoff-final.log`、`electron-handoff-summary.json`、`electron-handoff-smoke.py`

协作修复与原始失败证据：
- Core：`b97e1afb-0af1-4502-9ba1-8c393590178d/.context/` 下的账号红绿日志、`goal-report.md` 与确定性 drain 红绿日志。
- Main：`675e48c9-e6d7-4e17-ab28-526be82eec2f/.context/` 下的 `followup-final-report.md`、`final-main-test.log`。
- UI：`3f73f0fb-9837-4f3f-bcfb-5370d05918eb/.context/` 下的测试修复 diff、完整日志、`ui-static-visual-review.md` 与静态 HTML。

上述协作目录均位于 `/Users/mac/.profer/agent-workspaces/profer/`。主会话已重读关键 diff，独立执行最终全仓测试、类型、构建、成品 smoke 和 Electron 交接验证。
