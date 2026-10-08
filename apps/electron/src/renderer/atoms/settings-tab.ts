/**
 * Settings Tab Atom — 设置标签页状态
 *
 * 管理设置面板中当前激活的标签页：
 * - general: 通用
 * - usage: 使用偏好（通知与声音 / 对话浏览 / 输入体验）
 * - account: 账户与资料
 * - channels: 模型配置
 * - prompts: 提示词管理
 * - agent: Agent 配置
 * - tools: Chat 工具
 * - bots: 远程连接
 * - shortcuts: 快捷键管理
 * - appearance: 外观设置
 * - proxy: 代理设置
 * - devices: 登录设备
 * - subscription: 立即订阅
 * - credits: 额度与用量
 * - openapi: 开放 API
 * - data-management: 数据管理（备份+磁盘）
 * - developer: 开发者模式（版本号连击解锁后显示）
 * - plugins: 插件系统（开发者模式下显示）
 * - team: 团队管理
 * - about: 关于（含意见反馈）
 */

import { atom } from 'jotai'

export type SettingsTab = 'general' | 'usage' | 'account' | 'channels' | 'appearance' | 'about' | 'agent' | 'prompts' | 'tools' | 'bots' | 'tutorial' | 'shortcuts' | 'team' | 'credits' | 'subscription' | 'openapi' | 'data-management' | 'developer' | 'plugins' | 'proxy' | 'devices'

/** 当前设置标签页（不持久化，每次打开设置默认显示通用偏好） */
export const settingsTabAtom = atom<SettingsTab>('general')

/** 设置浮窗是否打开 */
export const settingsOpenAtom = atom(false)

/** 渠道表单是否有未保存或正在保存的内容（用于拦截导航离开） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置面板（如 Cmd+W），SettingsPanel 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)

export interface ChannelFormController {
  busy: boolean
  flush: () => Promise<boolean>
  discard: () => Promise<void>
}

/** 当前渠道表单注册的离开控制器，供设置导航在卸载前保存或明确丢弃。 */
export const channelFormControllerAtom = atom<ChannelFormController | null>(null)
