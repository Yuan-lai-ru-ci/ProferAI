# GPT with Taste 行为层适配

## 2026-11-20 行为指导修正

用户反馈 GPT 实际回复仍过分谨慎。原有一句式 User Steer 没有保留上游的工作方法，本次将其替换为具体的判断、接续和读者优先指导：

- 已有授权足够就行动，普通缺口用上下文、材料和合理默认解决；只有影响目标、权限、重大成本、不可逆后果或验收的未知才问。
- 追问、纠错和失败反馈接续原任务；找到原因或路径后继续修复、实现和验证，不反复确认已定事项。
- 检查针对真实失败路径，不为假想风险增加前置检查、无必要 hash、静默兜底或防御性代码；不改变旧用法的入口、数据含义或适用条件。
- 保持证据支持的结论强度；删掉无助于使用者行动的自证、重复边界和防御性结尾。
- 核心说明设计服务于已明确的实施请求；内置 `brainstorming` 更新为 1.1.0，取消固定的分段确认、再次批准实施和自动提交文档流程。真实计划模式、角色限制和用户要求的审批仍有效。用户自己维护的 Skill 副本和预设未改。

验收：7 个相关文件 **111 pass / 0 fail**；Prompt Builder **38 pass / 1 fail**，其中已有的预设继承文案断言在修改前也失败（其他并行工作正调整委派预设规则）。Electron typecheck、diff check 通过。测试检查实际文案/装配、轻量与 compact、追加消息和 Skill 加载通道，不代表模型输出质量已得到证明。

同一 fixture 标准提示词 raw 为 6860 字符，去除配置路径差异后为 6748。长度预警从 6500 调到 7000，明确允许本次必要内容，不再用删掉方法换取低字数。User Steer 的新增内容在消息侧，不计入该 system 字符数。

生效需要运行包含本次改动的新构建并新建会话；打包 Skill 种子会经现有全局 Skill 同步流程加载，已复制成用户自定义版本的 Skill 不会因此被覆盖。当前会话已注入的旧规则不会被文件修改倒替换。本轮未打包或替用户启动应用。

以下 2026-11-15 数字与说明保留为历史记录，当前文案以本节为准。

## 目标与范围

将 GPT with Taste 的结果所有权、普通判断、持续执行、协作结果吸收、工程/视觉质量与读者优先原则纳入 Profer。此版是精简中文行为适配，不是原始配方逐字移植，也不是上游插件安装。

- 上游：<https://github.com/NB-Corp/gpt-with-taste>
- 本轮核对版本：`079fb262b4d7932515ba4e6341fd57b6f2122f4a`
- 来源：`recipe/main.md`、`sub.md`、`independent.md` 与 User/Sub/Agent Steer；参照 Pi/Claude 宿主文档。
- 许可证：MIT。适配模块头部保留行为文本来源的 copyright 和 permission notice；未引入上游 TOML helper、插件安装器或 Pi 传输实现。

不增加依赖、模型调用、Renderer 页面、preload 或 IPC；不更改用户预设、权限、工具注册、任务图和协作状态机。

## 所有权和接入

通用执行、表达与交付规则统一在 `agent-prompt-core.ts`；`agent-behavior-recipe.ts` 只保存角色责任、质量增量与事件提醒。Builder 不再额外叠加整段 Taste 行为配方。Pi/Claude 的通用验证规则、独立交付段和交互说明已并入核心；AskUserQuestion 结构与运行时/产品事实保留在原模块。全局记忆段压缩措辞，但保留来源、敏感信息、先读后写、跨会话证据、透明性与禁止扩大采集等约束。

| 层 | 输入与产出 |
| --- | --- |
| Prompt Builder | 接收宿主 `behaviorRole`，在 standard system prompt 装配角色契约；light 不携带完整配方 |
| 角色解析 | 主会话为 main；有真实委派/父会话元数据为 sub；`delegationRelation=independent` 优先判为 independent，不解析任务正文自述 |
| 旧编排器 | 初轮/恢复使用同一角色；standard 新输入和运行中追加消息携带 User/Sub Steer；light 与 `/compact` 跳过 |
| 新 runtime | turn prompt 使用同一角色和文案，standard 用户消息携带 User/Sub Steer；运行中追加消息复用同一 helper |
| 协作结果 | 自动续跑、`wait_for_delegations`、`get_delegation_results` 只在包含 completed 结果时附加提醒；sub 使用子任务提醒，independent 不叠加 Steer |

普通 launch、list、running、failed、interrupted、cancelled 状态不被新逻辑重新解释成完成。混合批次包含 completed 时，提醒要求判断每份结果，不代表整个批次成功。

Profer 使用现有用户消息/工具结果通道传递提醒，而不是上游 Pi `context_with_system` 的隐藏 request-local projection。原始用户消息持久化保持原文，但 provider transcript、框架自动续跑消息和工具结果可能保留上下文；不要把这版描述为上游完全不落盘的传输协议。

Claude SDK 自建的原生临时子 Agent 不经过 Profer 协作会话元数据，此版没有另外接入上游 `SubagentStart` 插件。角色与结果事件覆盖针对 Profer 原生协作会话，两种 provider 共享。

## 启用与回滚

新构建的 standard 运行默认启用；无设置页开关。进程环境设置 `PROFER_AGENT_TASTE=0` 后重启 Profer，可关闭角色、质量增量与新增 Steer，不改变核心执行规则和权限门禁。**去重后此开关不再代表回到整合前的完整提示词**：通用规则已经合入核心，旧版对比需使用之前的代码构建，而不是仅切换此变量。

开发验证可使用：

```bash
PROFER_AGENT_TASTE=0 bun run dev
```

这只是启动示例，本轮未启动开发环境。不要在运行中修改环境变量来切换同一会话。开关无法删除 provider 历史中已有的上下文；测试关闭效果应重启并新建会话。恢复时取消该变量并重启。

## 验收与限制

自动测试覆盖角色解析、回滚、light/compact、不修改原文、runtime system/user 装配、旧链队列和协作状态。相关测试使用 `bun test --isolate`；Electron 使用 `bun run typecheck`。

2026-11-15 去重整合验收：7 个相关测试文件 **131 pass / 0 fail**（含 Pi task prompt、两条运行链、追加消息、协作和角色/回滚）。同一测试 fixture 的 standard 字符数从上一版 **7462 降到 6492**（减少 970，约 13%），light 为 274；融合前工作树为 6978。原有 `standard.chars < 6500` 门槛保持不变并通过。字符数不是 provider tokenizer 的 token 计数，不代表完整生产上下文固定为此长度。Electron `bun run typecheck` 与 `git diff --check` 通过。测试日志保存在本次会话的 `taste-dedup-tests.log`。

通用规则只保留一份、角色/质量段不再复述执行底线、关闭增量后核心授权和验证约束仍保留，均有回归断言。未修改预设中的用户已有 WIP、Renderer、preload 或 IPC。

未启动开发环境、未做真实模型 A/B、未打包发布。单测验证的是装配与状态契约，不证明模型实际回答质量已提高。

建议人工评估使用前后两版构建，在相同模型和任务下比较：明确执行任务是否持续到交付；子任务是否守边界；结果回收是否得到综合判断；文章是否保留原始事实；UI 任务是否实际核对呈现。当前开关只能比较整合核心之上的质量/角色/事件增量。记录真实输入输出后再决定保留、改写或删除配方段落。
