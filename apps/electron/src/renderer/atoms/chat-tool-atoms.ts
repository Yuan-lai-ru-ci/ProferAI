/**
 * Chat Tool Atoms - Chat 工具状态管理
 *
 * 管理 Chat 模式下可用工具的列表和开关状态：
 * - chatToolsAtom: 从主进程加载的所有工具信息（唯一状态源，来自 chat-tools.json）
 * - activeToolIdsAtom: 当前实际启用的工具 ID（enabled AND available）
 */

import { atom } from 'jotai'
import { coreTargetsAtom, ownsCoreChat } from './core-target-atoms'
import type { ChatToolInfo } from '@profer/shared'

/** 从主进程加载的所有工具列表（唯一状态源） */
export const chatToolsAtom = atom<ChatToolInfo[]>([])

/**
 * 派生：当前实际启用的工具 ID 列表
 *
 * 条件：后端配置开关打开 AND 工具已配置可用
 */
export const activeToolIdsAtom = atom<string[]>((get) => {
  // 桌面工具配置不是用户在当前 Core 上的选择，不能跨所有者继承。
  if (ownsCoreChat(get(coreTargetsAtom))) return []
  const allTools = get(chatToolsAtom)
  return allTools
    .filter((t) => t.enabled && t.available)
    .map((t) => t.meta.id)
})

/** 派生：是否有任何工具启用 */
export const hasActiveToolsAtom = atom<boolean>((get) => {
  return get(activeToolIdsAtom).length > 0
})

/** Core 工具尚无独立目录/选择传输，不能调用桌面配置接口。 */
export const chatToolsUnavailableReasonAtom = atom(get => {
  const target = get(coreTargetsAtom)
  if (!ownsCoreChat(target)) return null
  return target.targets.find(item => item.id === target.currentId)?.capabilities?.includes('chat.tools')
    ? '当前 Core 的 Chat 工具目录尚未接入'
    : '当前Core暂不支持Chat工具'
})
export const chatKnowledgeUnavailableReasonAtom = atom(get => ownsCoreChat(get(coreTargetsAtom)) ? '当前Core暂不支持Chat知识库' : null)
