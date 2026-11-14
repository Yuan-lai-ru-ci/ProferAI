# Profer 文档索引

> 本目录收录 Profer 桌面端的设计、计划、调研与操作指南。
> 最近核对：2026-11-14（补齐现存文档入口；状态只描述文档生命周期，具体实现仍以源码、测试和发布记录为准）。
>
> **约定**
> - 目录分类：`guides/`（随代码维护的操作/契约文档）、`design/`（设计）、`plans/`（实施计划）、`research/`（调研）、`archive/`（生命周期已终结）。
> - 命名：设计/计划/调研文档统一 `YYYY-MM-DD-<topic>.md`；常青指南不加日期。
> - 新计划按 `default-skills/brainstorming`、`default-skills/writing-plans` 的约定写入 [`plans/`](./plans/)。
> - 归档文档在正文顶部保留 `归档状态` 标注，**不代表当前产品能力**。

---

## 常青指南（`guides/`，随代码持续维护）

| 文档 | 内容 |
|------|------|
| [`guides/plugins.md`](./guides/plugins.md) | 通用插件宿主 API、安装授权与生命周期契约 |
| [`guides/skill-routing.md`](./guides/skill-routing.md) | Skill 可用范围与任务推荐的分离、双运行时门禁 |
| [`guides/profer-remote-service.md`](./guides/profer-remote-service.md) | 桌面端远程服务（HTTP + WebSocket）使用说明 |
| [`guides/windows-execution-acceptance-guide.md`](./guides/windows-execution-acceptance-guide.md) | Windows 执行能力（ShellSnapshot / ProcessHandle）验收指南 |
| [`guides/oss-ci-packaging-and-signing.md`](./guides/oss-ci-packaging-and-signing.md) | OSS CI 构建、签名输入与发布边界；线上 Secrets/证书状态须另行核验 |

## 设计（`design/`）

| 文档 | 状态 |
|------|------|
| [`design/2026-07-22-project-start-page-design.md`](./design/2026-07-22-project-start-page-design.md) | 已实现 |
| [`design/2026-06-20-proactive-center-design.md`](./design/2026-06-20-proactive-center-design.md) | 部分实现（Automation Recommendation MVP 已落地；Proactive Center / Monitor 未完成） |
| [`design/2026-10-27-scrollbar-spec.md`](./design/2026-10-27-scrollbar-spec.md) | 交互规范；随 renderer 实现变化复核 |
| [`design/2026-11-07-rail-view-header-spec.md`](./design/2026-11-07-rail-view-header-spec.md) | 设计规格；实施状态以对应组件和测试为准 |

## 计划（`plans/`）

| 文档 | 状态 |
|------|------|
| [`plans/2026-09-07-xai-grok-adaptation-design.md`](./plans/2026-09-07-xai-grok-adaptation-design.md) | 已实现 |
| [`plans/2026-09-28-settings-subdivision-plan.md`](./plans/2026-09-28-settings-subdivision-plan.md) | 已实施 |
| [`plans/2026-08-30-ollama-local-channel.md`](./plans/2026-08-30-ollama-local-channel.md) | 已落地并附验证记录 |
| [`plans/2026-09-27-profer-agent-fabric-design.md`](./plans/2026-09-27-profer-agent-fabric-design.md) | 架构确认，Phase 0/1 已落地，端到端冒烟待手工验收 |
| [`plans/2026-09-03-agent-preview-design.md`](./plans/2026-09-03-agent-preview-design.md) · [implementation](./plans/2026-09-03-agent-preview-implementation.md) | 已实现；两篇为设计/施工历史记录，验收须回到当前源码/测试 |
| [`plans/2026-08-27-cross-platform-process-monitoring.md`](./plans/2026-08-27-cross-platform-process-monitoring.md) | 平台适配实现存在；操作系统级验收状态需现场确认 |
| [`plans/2026-08-20-agent-planning-todo-tools.md`](./plans/2026-08-20-agent-planning-todo-tools.md) | 已实现；历史施工计划 |
| [`plans/2026-09-05-capability-gating-unification.md`](./plans/2026-09-05-capability-gating-unification.md) | registry 实现存在；完整工具/发行版矩阵仍需验收 |
| [`plans/2026-06-02-im-model-switch-design.md`](./plans/2026-06-02-im-model-switch-design.md) | 设计（IM 模型切换） |
| [`plans/2026-10-19-workspace-project-mode-design.md`](./plans/2026-10-19-workspace-project-mode-design.md) | Project Mode 设计/历史取舍；细节被后续会话自包含方案修订 |
| [`plans/2026-11-03-workspace-project-mode-implementation.md`](./plans/2026-11-03-workspace-project-mode-implementation.md) | 主链路已实现；历史规格 I3 已被会话自包含设计取代 |
| [`plans/2026-10-27-model-reasoning-capability-matrix.md`](./plans/2026-10-27-model-reasoning-capability-matrix.md) | 能力矩阵记录；模型/Provider 更新后需复核 |
| [`plans/2026-10-30-task-origins-and-session-dispatch-design.md`](./plans/2026-10-30-task-origins-and-session-dispatch-design.md) · [`delivery`](./plans/2026-11-01-task-origins-and-session-dispatch-delivery.md) | 设计与交付快照；不是当前 runtime 入口 |
| [`plans/2026-11-04-project-session-self-contained.md`](./plans/2026-11-04-project-session-self-contained.md) | 已实施记录；当前路径与布局以 `packages/session-store` 为准 |
| [`plans/2026-11-07-agent-rewind-d4.md`](./plans/2026-11-07-agent-rewind-d4.md) · [`simple-git`](./plans/2026-11-08-rewind-simple-git.md) | Rewind 方案演进记录；simple-git 方向由 Shadow Git 方案取代，不作为现行实施入口 |
| [`plans/2026-11-08-shadow-git-design.md`](./plans/2026-11-08-shadow-git-design.md) · [`changes`](./plans/2026-11-09-shadow-git-changes.md) · [`handoff`](./plans/2026-11-09-shadow-git-handoff.md) | Shadow Git 设计、审查清单、历史交接；未完成项必须回到当前 todo/源码核验 |
| [`plans/2026-11-09-runtime-default-chain-plan.md`](./plans/2026-11-09-runtime-default-chain-plan.md) · [`handoff`](./plans/2026-11-09-runtime-default-chain-handoff.md) | 新 Runtime 默认链方案与交接快照；以当前实现及后续提交为准 |

## 调研（`research/`）

Codex Visualize / Skills 机制核验系列（2026-10-04 ~ 10-05），按时间顺序阅读：

1. [`research/2026-10-04-codex-visualize-comparison.md`](./research/2026-10-04-codex-visualize-comparison.md)（早期判断）
2. [`research/2026-10-04-codex-open-source-harness.md`](./research/2026-10-04-codex-open-source-harness.md)（harness 核验）
3. [`research/2026-10-04-codex-source-verified-visualize-and-skills.md`](./research/2026-10-04-codex-source-verified-visualize-and-skills.md)（源码逐文件核验，结论以此为准）
4. [`research/2026-10-05-visualization-charset-fix.md`](./research/2026-10-05-visualization-charset-fix.md)（中文乱码修复）

## 归档（`archive/`）

| 文档 | 归档状态 |
|------|---------|
| [`archive/2026-08-07-tablet-settings-design.md`](./archive/2026-08-07-tablet-settings-design.md) | 已废弃（tablet 线 2026-09-11 退役） |
| [`archive/2026-08-16-agent-preset-phase-b-plan.md`](./archive/2026-08-16-agent-preset-phase-b-plan.md) | 历史计划（Harness 自动续轮等已移除） |
| [`archive/2026-08-16-session-handoff.md`](./archive/2026-08-16-session-handoff.md) | 历史交接快照 |
| [`archive/2026-08-24-student-pptx-design.md`](./archive/2026-08-24-student-pptx-design.md) | 已被取代 |
| [`archive/2026-08-24-student-pptx-implementation.md`](./archive/2026-08-24-student-pptx-implementation.md) | 已被取代 |
| [`archive/2026-08-24-student-pptx-v1-freeze.md`](./archive/2026-08-24-student-pptx-v1-freeze.md) | 已冻结 |
| [`archive/2026-10-05-goal-flow-alignment-handoff.md`](./archive/2026-10-05-goal-flow-alignment-handoff.md) | 已交付（合并 eea0292f） |
| [`archive/team-workspace-file-management.md`](./archive/team-workspace-file-management.md) | 已废弃（团队运行时 2026-10-11 移除） |

---

## 相关入口

- 仓库根 `README.md` / `README.zh-CN.md`：产品介绍与快速开始
- 仓库根 `AGENTS.md` / `CLAUDE.md`：项目约束、架构说明与开发命令
- `apps/electron/resources/tutorial.md`：客户端内教程真源（`tutorial/tutorial-v2.md` 为同步稿）
- `docs/assets/`：README 与文档引用的图片资源

## 生命周期约定

- 本索引列出 `docs/` 当前全部 Markdown 文件；新增/重命名文档时同步更新此表。
- `plans/` 与 handoff 是有日期的设计/交付证据，不自动等于当前 backlog；明确写出 `superseded`、后继文档或仍待验收项。
- 交付记录中的分支、提交、未提交状态和测试数字只代表记录当时，不作为当前状态。当前状态要现场对照代码、测试、Git 与 Release。
- `archive/` 保留决策与历史证据，不作为当前能力说明；常青操作/协议契约放在 `guides/`。
