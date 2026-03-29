/**
 * Tips 管理模块 — 平台感知的使用技巧
 *
 * 区分 macOS / Windows 平台，提供随机轮换的小贴士。
 * Tips 内容可后续手动扩充。
 */

export type Platform = 'mac' | 'windows'

export interface Tip {
  id: string
  text: string
  /** 适用平台，'all' 表示通用 */
  platform: Platform | 'all'
}

/** 检测当前平台 */
export function getPlatform(): Platform {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')) {
    return 'mac'
  }
  return 'windows'
}

/** 所有 Tips 数据 */
export const TIPS: Tip[] = [
  // macOS 专用
  { id: 'mac-shortcut-new', text: '按 ⌘+N 快速创建新对话', platform: 'mac' },
  { id: 'mac-shortcut-search', text: '按 ⌘+K 快速搜索历史对话', platform: 'mac' },
  { id: 'mac-shortcut-settings', text: '按 ⌘+, 打开设置', platform: 'mac' },

  // Windows 专用
  { id: 'win-shortcut-new', text: '按 Ctrl+N 快速创建新对话', platform: 'windows' },
  { id: 'win-shortcut-search', text: '按 Ctrl+K 快速搜索历史对话', platform: 'windows' },
  { id: 'win-shortcut-settings', text: '按 Ctrl+, 打开设置', platform: 'windows' },

  // 通用
  { id: 'tip-thinking', text: '开启思考模式，让 AI 展示推理过程', platform: 'all' },
  { id: 'tip-agent-file', text: 'Agent 模式下输入 @ 可以引用工作区文件', platform: 'all' },
  { id: 'tip-agent-mcp', text: 'Agent 模式下输入 # 可以调用 MCP 工具', platform: 'all' },
  { id: 'tip-agent-skill', text: 'Agent 模式下输入 / 可以使用 Skill', platform: 'all' },
  { id: 'tip-attachment', text: '支持拖拽文件到输入框直接上传附件', platform: 'all' },
  { id: 'tip-parallel', text: 'Chat 模式支持并排对比多个模型的回答', platform: 'all' },
]

/** 获取适用于当前平台的随机 Tip */
export function getRandomTip(platform: Platform): Tip {
  const filtered = TIPS.filter((t) => t.platform === 'all' || t.platform === platform)
  const index = Math.floor(Math.random() * filtered.length)
  return filtered[index] ?? filtered[0]!
}
