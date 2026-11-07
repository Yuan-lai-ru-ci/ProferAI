/**
 * Active View Atom - 主内容区视图状态
 *
 * 控制 MainArea 显示的内容：
 * - conversations: 对话视图（Chat/Agent 模式内容）
 * - planning: 规划中心（Todo / 日程 / 定时任务，分区由 planningTab 决定）
 * - agent-skills: Agent 技能（Skills/MCP/预设）全屏管理视图
 * - agent-memory: Agent 记忆（工作区长期记忆）全屏视图
 * - user-profile: 我的画像（跨工作区用户画像）全屏视图
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export type ActiveView = 'conversations' | 'planning' | 'agent-skills' | 'agent-memory' | 'user-profile' | 'user-profile-files'

/** 当前活跃视图（持久化到 localStorage，刷新后保持当前页面） */
export const activeViewAtom = atomWithStorage<ActiveView>('profer-active-view', 'conversations')

/** 用户画像一级卡片进入二级文件管理页时的目标文件。 */
export const globalProfileFileAtom = atom('user-profile.md')
