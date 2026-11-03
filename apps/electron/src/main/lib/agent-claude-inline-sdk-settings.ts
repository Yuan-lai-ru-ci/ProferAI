/**
 * Claude SDK 内联设置（project 模式）的唯一构造来源。
 *
 * 为什么单独成模块：旧编排链（`agent-orchestrator.ts`）与 runtime 链的 provider preparation
 * （`agent-runtime-provider-preparation.ts`，覆盖 headless / 自动化 / remote / 桌面新链）都要下发
 * **同一组**设置。若 provider preparation 直接 import 编排器，会经过 `agent-service.ts` 的
 * 加载期循环（service 顶层 `new AgentOrchestrator(...)`），bun test 里表现为 TDZ ReferenceError。
 * 这里只保留纯函数与一个 type import，两个消费方共用同一实现，不复制判定。
 */
import type { ClaudeAgentQueryOptions } from '@profer/agent-provider-claude'

/**
 * project 模式下需要内联下发的 SDK 设置（flag settings 层）。
 *
 * 要解决的问题：Claude Agent SDK 只从 **cwd** 下的 `.claude/settings.json` 读项目设置。project 模式下
 * cwd 是用户项目根，而 Profer 自己那份写在中央 storageDir，于是 `plansDirectory` /
 * `autoMemoryDirectory` / `skipWebFetchPreflight` 全部对 SDK 惰性——自动记忆可能按 cwd 默认目录
 * 写进 `<root>/.claude/...`，违反「不污染项目」的不变量。
 *
 * 这里返回的对象必须与 `<storageDir>/.claude/settings.json` 的内容一致（同一来源、同一键），
 * 否则文件读者与内联读者会看到不同的计划目录。managed 下文件就在 cwd，返回 `undefined`，
 * 让 SDK 完全按旧路径读文件（行为与改造前逐字一致）。
 */
export function buildClaudeInlineSdkSettings(input: {
  /** 仅 project 存储模式需要内联；managed 依赖 cwd 下的设置文件。 */
  projectMode: boolean
  /** 与 `settings.json` 的 `plansDirectory` 同值；`undefined` 表示该键不存在（跨盘符无合法相对路径）。 */
  plansDirectory?: string
  /** 与 `settings.json` 的 `autoMemoryDirectory` 同值；无工作区时 `undefined`。 */
  autoMemoryDirectory?: string
}): ClaudeAgentQueryOptions['settings'] | undefined {
  if (!input.projectMode) return undefined
  return {
    ...(input.plansDirectory !== undefined && { plansDirectory: input.plansDirectory }),
    skipWebFetchPreflight: true,
    ...(input.autoMemoryDirectory !== undefined && { autoMemoryDirectory: input.autoMemoryDirectory }),
  }
}
