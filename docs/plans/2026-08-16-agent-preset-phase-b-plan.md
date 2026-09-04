# Phase B 计划 — Agent Preset 与 Pi Harness 深化

> 历史计划：其中“验证兜底/Harness 自动续轮”子功能已于 2026-08-19 按用户决定移除，Agent 知识库引用/读取也已下线。保留本文仅作历史记录；当前代码以不自动追加验证轮次、Chat 保留资料库为准。
> 记录日期:2026-08-16
> 上游会话:preset 能力提升 + pi runtime 提示词 + harness 改进（历史记录）
> 当前实现：预设能力保留；Harness 自动续轮和 Agent 知识库能力已移除

## 一、已完成基线(勿重复)

- **pi-harness.ts**:读回验证扩展到源码(需发生在写入之后)、follow-up 动态列出未验证文件清单、路径规范化(cwd 解析 + Windows 大小写/分隔符)、事件顺序判定
- **agent-prompt-builder.ts**:「验证 Harness 会自动兜底」明示 + 工具名 runtime-aware(任务图/预设工具/团队记忆按 Pi `mcp__` 前缀或 Claude 裸名生成)
- **预设导出/导入 JSON 文件**:shared 信封类型 + manager `serializeAgentPresetsForExport`/`importAgentPresets`(整体校验原子性、重名追加「（导入）」后缀)+ IPC 对话框 + 预设页导出/导入按钮
- **Pi 侧预设工具 hint** 改用前缀名;`automation/SKILL.md` 补 runtime 工具名说明(version 1.0.10)
- 版本已 bump:shared 0.1.34、electron 0.15.47
- 测试:66/66 通过(harness/preset-manager/prompt-builder/pi-builtin-tools/eval)
- 冒烟资产:`apps/electron/scripts/agent-session-smoke.ts`(真实端到端,含解密诊断、候选渠道探测、取证与清理)

## 二、Phase B 任务清单

### B1. Harness 感知与边界（历史方案，已废止）

> B1 的 Harness 续轮、诊断和双 runtime 对齐方案已整体移除；仅保留 Agent 自行完成最小验证的提示词规范。

1. ✅ **续轮身份标注（2026-08-16 完成）**:harness follow-up 注入时同步推送 `system/subtype=harness_follow_up` 系统消息（含未验证文件清单），经 orchestrator 持久化到 JSONL;UI 渲染为「系统验证兜底」提示卡（SDKMessageRenderer `HarnessFollowUpNotice` + session-core/renderer 双侧分组逻辑），不再可能被误认为用户自己发的消息。冒烟已取证（系统消息落盘 ✅）。
2. ✅ **验证命令判定细化（2026-08-16 完成）**:新增 `INSTALL_COMMAND_PREFIX`（npm/bun/pnpm/yarn install 族永远不算验证）+ `referencesWrittenPath`（命令引用本轮写入路径 = 定向验证）+ `VALIDATION_KEYWORD_PATTERN`（tsc/test/lint 等验证语义命令仍算验证）;不引用写入路径的泛化命令（如全仓 `bun run build`）不再误判为「已验证」。eval corpus 扩到 18 例。
3. **bash 写文件盲区(先记录,评估后再改)**:`echo > file`、`mv`、MCP 产品工具写文件不在 write/edit 名单,模型可从这些路径写文件而不触发兜底。若需覆盖:解析 bash 重定向目标,或给产品 MCP 写工具登记到 harness。
4. ✅ **输入解析防护（2026-08-16 完成）**:`readPath` 字段枚举扩到 `path/file_path/filePath/filepath` + 空值守卫;写入/读取工具调用缺全部已知路径字段时打哨兵日志（Pi SDK 改名不再静默失效）。
5. ✅ **Claude runtime 对齐（2026-08-16 完成）**:harness 判定引擎保持运行时中立（pi-harness.ts 增加 `AgentHarness*` 中立别名，双 runtime 共用同一判定口径与 eval corpus）。新增 `claude-harness.ts` 追踪器：Claude SDK 消息流喂入工具事实——assistant 的 tool_use 块按 tool_use_id 建映射，user 的 tool_result 块回填 outcome（`is_error` → 失败写入不计入变更），replay 回放消息一律忽略；`claude-agent-adapter` 在正常终态 result 上评估 harness：未验证写入 → 先推 `harness_follow_up` 系统消息（UI「系统验证兜底」+ 持久化白名单复用 B1-1 链路），再经消息通道注入只做验证的续轮提示，result 打 `_keepChannelOpenForHarnessFollowUp` 注解让编排层不启动 drain 超时且不进轻量空闲态；错误类结果（subtype error_*/max_turns/prompt_too_long）与用户软中断（aborted_streaming/aborted_tools）按 Pi 语义 markTerminalFailure/markBlocked。诊断事件 runtime 字段扩为 `pi|claude`（schema v2）。Claude 侧提示词新增「Claude Agent Runtime」段落并明示「验证 Harness 会自动兜底」（与 Pi 侧对齐）。冒烟脚本 harness 段扩展为双 runtime 全验证，新增 `--claude` 候选前置参数。

### B2. 预设能力深化(用户选定方向)

1. **内置预设模板扩充**:研究/写作/翻译/PPT 等场景预设,开箱即用(复用 default-skills 心智;提示词段可直接借鉴已沉淀的 Skill 内容)。
2. ✅ **预设继承/派生（2026-08-16 完成）**:自定义预设可基于内置预设派生(`basePresetId`，仅限内置 ID，天然免循环派生)。只存差异：promptSections 基座在前+子追加、suppressPromptSections/disabledToolGroups 取并集、标量字段子定义则覆盖否则继承。`getAgentPreset` 统一在读取时合并（orchestrator/两种 runtime 工具/IPC 自动受益），内置升级自动跟随。支持切换基座与脱离基座（`basePresetId: null` = 冻结当前生效配置为独立预设）；复制派生预设保留基座；导出/导入携带 basePresetId（导入侧校验内置 ID）；readConfig 净化非法基座。UI 表单加「派生基座」选择器 + 列表「基于「X」」徽标；Claude/Pi 双侧工具 schema 同步。
3. ✅ **更细粒度能力裁剪（2026-08-16 完成，单工具级）**:评估后做「单工具禁用」黑名单式（与 disabledToolGroups 统一心智，不做字面白名单——组禁用与单工具叠加语义最简）。shared 新增 `AGENT_PRESET_GROUP_TOOL_NAMES` 事实表（四组 24 工具短名，跨 runtime 统一口径：Claude 裸名 / Pi `mcp__server__tool` 末段）+ `filterDisabledTools` 纯函数；`AgentPreset.disabledTools` 全链路（manager 校验/净化/合并并集/脱离冻结/导出导入 + Claude 五个 inject 注入点 + Pi `buildPiBuiltinTools` 统一过滤 + 双侧工具 schema + UI 组内单工具勾选）。**命令级白名单（Bash 命令级）本轮不做**：需跨 runtime 接入 permission 层与 WSL 包装，与 permissionMode（plan 模式已含只读命令判定）重叠，成本高收益薄，留作远期评估。
4. **Phase 2 共享市场(远期)**:复用 Skills 市场机制,预设导出/导入文件格式(profer-agent-presets v1)是天然载体。

### B3. 一致性补全遗留（历史记录）

1. **Agent 知识库能力已于 2026-08-19 移除**：Chat 继续保留通用资料库；Agent 不再提供资料引用、session allowlist、读取工具、相关 IPC/preload 或资料预览入口，旧 session 索引读取时会清理遗留字段。
2. ✅ **AskUserQuestion 的 Pi 侧注册（2026-08-16 确认已打通）**:调查确认 Pi 侧提问闭环已端到端存在，无需修复——`buildPromaProductToolDefinitions` 注册 `AskUserQuestion`（questions 入参 + 执行返回 `{answers}`），统一 `canUseTool` 恒走 `askUserService.handleAskUserQuestion`（横幅阻塞 + `respondToAskUser` 注入 answers，经 `restorePiInput` 合并回参数）；提示词段「不确定性处理」为 runtime 中立文案（两 runtime 同名同 schema），无需按 runtime 分支。补取证单测 `pi-agent-adapter.test.ts`（3 用例：注册契约 / answers 注入返还 / deny 抛错），并导出 `buildPromaProductToolDefinitions` 供测试引用。
3. ✅ **pdf skill YAML frontmatter 告警（2026-08-16 完成）**:`default-skills/pdf/SKILL.md` description 未加引号,含「: 」触发 YAML "Nested mappings are not allowed in compact mappings";已加双引号并 bump version 1.0.4→1.0.5（契约要求）。注意:老工作区已有副本不会被自动覆盖（2026-08-14 起只做「缺失即注入」），需用户经元 Skill 手动同步。
4. **newapi 中转渠道 403**:GPT/Claude 渠道被服务端套餐限制(「仅 Plus 及以上套餐可用」),属用户账户侧,非代码问题。

### B4. 测试资产固化

1. `agent-session-smoke.ts` 保留为可复用冒烟资产。启动三要素(已注释在脚本头):打包到 `apps/electron` 根、用 `.bun` 规范 exe 路径启动、`app.setPath('userData', '@profer/electron-dev')`——Electron 43 app-bound safeStorage 解密身份要求,**且需 dev 应用先退出**(profile 单例锁)。
2. 冒烟脚本的取证逻辑已修正:Pi transcript 的 tool 块类型是 `toolCall`(非 `tool_use`);harness 续轮两种文案(源码「尚未进行验证」/ 文档「尚未验证结果」)。
3. 可选:`--probe-only` 诊断模式保留(解密环境自检,数秒出结果)。

## 三、约束与规范提醒

- 三层一致(工具注册/提示词段/能力裁剪)一律走 shared 唯一事实表(`AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP` 等),禁止新工具组不登记
- `default-skills/` 任何改动必须同步 bump 该 Skill frontmatter version
- 受影响包 patch 版本 bump(shared / electron)
- 注释与日志中文、保留专业术语;文档同步(CLAUDE.md/README.md)需经用户允许
- 状态管理 Jotai;本地 JSON 优先,不引入数据库

## 四、验收口径

- `bun run typecheck`(shared + electron)通过
- 相关单测通过;涉及 harness 决策变化时同步更新 `test/fixtures/pi-harness-eval-cases.json` 与汇总断言
- 涉及真实行为的改动,用 `agent-session-smoke.ts` 补一轮端到端取证(渠道需有效)

## 五、本轮（2026-08-16 接手）进展快照

> 以上关于 Pi/Claude Harness 续轮、诊断、`harness_follow_up` 系统消息和对应冒烟取证的内容均已废止（2026-08-19）。Agent 自行验证规范保留，系统不再自动发起验证模型调用。

- **完成**:预设继承/派生（basePresetId）、单工具级裁剪（disabledTools + 组内工具事实表）、AskUserQuestion Pi 侧注册、pdf skill YAML；**Harness 自动续轮与 Agent 知识库均已移除**
- **改动文件**:`pi-harness.ts`（运行时中立说明 + `AgentHarness*` 别名）、`claude-harness.ts`（新增，Claude 消息流→工具事实追踪器）、`claude-agent-adapter.ts`（observe + 终态评估 + 续轮注入 + 诊断落盘）、`agent-orchestrator.ts`（识别 `_keepChannelOpenForHarnessFollowUp` 免 drain 超时）、`pi-harness-diagnostics.ts`（runtime 字段 `pi|claude`，schema v2）、`agent-prompt-builder.ts`（Claude Runtime 段落 + 兜底文案）、`claude-harness.test.ts`（新增 10 用例）、`agent-prompt-builder.test.ts`（补 electron mock + Claude 段落断言）、`pi-harness-diagnostics.test.ts`（schema v2 + runtime 透传）、`agent-session-smoke.ts`（harness 段双 runtime + `--claude` 前置）、`pi-harness.ts`（判定细化 + 系统消息构建器）、`pi-agent-adapter.ts`（follow-up 推送系统消息 + 导出 `buildPromaProductToolDefinitions`）、`agent-preset-manager.ts`（派生合并/校验/脱离基座/单工具校验净化）、`shared/types/agent-preset.ts`（`basePresetId` + `mergeAgentPreset` + `AGENT_PRESET_GROUP_TOOL_NAMES` + `disabledTools` + `filterDisabledTools`）、`agent-preset-tools.ts` + `pi-builtin-tools.ts`（双侧工具 schema 同步 + Pi 统一过滤）、Claude 侧五个注入点（task-graph/memory-archive/team-memory/collaboration/automation 按短名过滤）、`AgentPresetSettings.tsx`（基座选择器 + 徽标 + 组内单工具勾选）、`shared/types/agent.ts`（`pending_paths`）、`session-core/src/group.ts` + `SDKMessageRenderer.tsx`（分组/渲染「系统验证兜底」）、`SDKMessageRenderer.test.ts`（新增）、`pi-agent-adapter.test.ts`（新增，B3-2 取证）、`pi-builtin-tools.test.ts`（补 electron mock + 派生/单工具契约用例）、`default-skills/pdf/SKILL.md`（YAML 引号 + version 1.0.5）、`agent-session-smoke.ts`（落盘取证 + 派生合并/单工具裁剪自检）
- **验证**:shared/session-core/electron typecheck 全过;目标单测 108/108（新增 claude-harness 10 用例：写入→follow-up、失败写入忽略、读回/验证语义 Bash 闭环、错误结果与 max_turns 失败终态、软中断 markBlocked、replay 忽略、无结果不追踪、follow-up 单次触发;diagnostics schema v2 + runtime 透传;prompt-builder Claude 段落断言）;**端到端冒烟**：B1-5 前一轮已取证派生合并 ✅ + 单工具裁剪 ✅ + 第一轮真实会话 ✅；本轮改动未跑真实冒烟（Claude harness 续轮需有效 Claude runtime 渠道，`--claude` 前置探测已就绪，上游 API 若可用即可取证）
- **版本**:历史快照版本信息保留，当前版本以仓库 `package.json` 为准
- **遗留**:B1-3 bash 写文件盲区、B2-1 内置预设模板扩充（继承/单工具机制已就位，扩充内容可直接受益）、B2-3 命令级白名单（Bash 命令级，评估后暂缓：与 permissionMode 重叠）、B4 冒烟资产固化说明已随脚本更新。文档同步（CLAUDE.md/README.md）仍需用户允许后另做。
