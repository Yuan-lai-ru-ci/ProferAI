/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Chat/Agent 模式内容）
 * - automations: 定时任务列表视图
 * - agent-skills: Agent 技能（Skills/MCP）全屏管理视图
 */

import { atomWithStorage } from 'jotai/utils'

export type ActiveView = 'conversations' | 'planning' | 'agent-skills'

/** 当前活跃视图（持久化到 localStorage，刷新后保持当前页面） */
export const activeViewAtom = atomWithStorage<ActiveView>('profer-active-view', 'conversations')
