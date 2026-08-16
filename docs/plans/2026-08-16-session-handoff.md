# 会话交接快照(2026-08-16) — 新会话/子代理接手起点

> 用途:主线上下文过长时,新 agent 读本文件即可无损接手,无需回读对话历史。
> 关联文档:`docs/plans/2026-08-16-agent-preset-phase-b-plan.md`(Phase B 任务清单,以它为准)

## 1. 本轮已完成的改动(全部未提交,与用户既有 WIP 共存于工作树)

| 文件 | 改动 |
|---|---|
| `apps/electron/src/main/lib/pi-harness.ts` | 读回验证扩到源码(须写入后)、动态 follow-up 列未验证文件、路径规范化(cwd/大小写/分隔符)、事件顺序判定 |
| `apps/electron/src/main/lib/agent-prompt-builder.ts` | 「验证 Harness 会自动兜底」明示;工具名 runtime-aware(任务图/预设/团队记忆) |
| `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` | harness 传 `cwd`(1 行) |
| `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` | preset_create/copy hint 改前缀名(2 处) |
| `packages/shared/src/types/agent-preset.ts` | 导出/导入信封类型 + `toAgentPresetExportEntry` + 2 个 IPC 通道 |
| `apps/electron/src/main/lib/agent-preset-manager.ts` | `serializeAgentPresetsForExport` / `importAgentPresets`(原子校验、重名「（导入）」后缀) |
| `apps/electron/src/main/ipc.ts` + `src/preload/index.ts` | EXPORT_PRESETS / IMPORT_PRESETS(主进程对话框) |
| `apps/electron/src/renderer/components/agent-skills/AgentPresetSettings.tsx` | 导出/导入按钮 + 结果提示 |
| `apps/electron/default-skills/automation/SKILL.md` | runtime 工具名说明,version 1.0.9→1.0.10 |
| 测试 | pi-harness / pi-harness-eval(+fixture) / agent-prompt-builder / agent-preset-manager 新增用例 |
| 版本 | shared 0.1.33→0.1.34;electron 0.15.46→0.15.47 |
| `apps/electron/scripts/agent-session-smoke.ts` | 新增:端到端冒烟资产(见 §4) |
| `docs/plans/2026-08-16-agent-preset-phase-b-plan.md` | 新增:Phase B 计划 |

## 2. 验证状态

- typecheck:shared + electron 通过
- 单测:目标 5 文件 66/66 通过;全量 616 pass / 27 fail,**失败全是既有环境问题**(沙箱 EPERM spawn、Pi SDK 0.80.9 vs 冒烟期望 0.82.1、electron mock hooks),不在本次改动模块
- **真实端到端已取证通过**:deepseek-v4-flash + Pi runtime,模型真实调用了 `mcp__agent-presets__preset_list`/`preset_create`(落盘成功),harness 在模型写文件不验证后**自动注入续轮并列出文件路径**,模型读回验证回复「验证通过」(transcript: `~/.profer-dev/sdk-config/sessions/pi/*_01a0094e-*.jsonl`)

## 3. 关键环境知识(踩过的坑)

- **Electron 43 safeStorage 是 app-bound 加密(v10 头),绑定含 userData 路径**。任何旁路 Electron 实例解渠道密钥必须:`app.setName('profer-dev')` + `app.setPath('userData', %APPDATA%\@profer\electron-dev)` + 打包产物放 `apps/electron` 根 + 用 `.bun` 规范 exe 路径启动;**且 dev 应用须先退出**(profile 单例锁)。否则 `decryptToken` 静默回退明文(实为密文)→ 服务端 401 回显密文尾 4 位。
- 沙箱限制:Electron 需 `danger-full-access` 提权运行;测试用 `cmd /c` 避免 pwsh stderr 误报;PowerShell 写文件勿用 `Set-Content`(会把 UTF-8 写成 GBK)。
- 用户机器渠道状态:newapi-1 与 17d5fd4c(DeepSeek)key 有效;GPT/Claude 中转渠道被 newapi 套餐限制 403(账户侧)。

## 4. 冒烟脚本用法(apps/electron 下)

```
bunx esbuild scripts/agent-session-smoke.ts --bundle --platform=node --format=cjs \
  --outfile=.smoke-runner.cjs --external:electron --external:@anthropic-ai/claude-agent-sdk \
  --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core --external:@earendil-works/pi-ai
<.bun 规范路径>\electron.exe --disable-gpu --no-sandbox .smoke-runner.cjs   # 或 --probe-only 只做解密诊断
```

## 5. 未完成/待办

- 见 Phase B 计划文档 B1~B4(优先:B1-1 续轮身份标注、B1-2 验证命令误判、B3-1 Claude 知识库工具缺失)
- 文档同步(CLAUDE.md/README.md)需用户允许后修改
