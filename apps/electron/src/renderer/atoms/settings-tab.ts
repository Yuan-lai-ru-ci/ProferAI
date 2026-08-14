/**
 * Settings Tab Atom — 设置标签页状态
 *
 * 管理设置面板中当前激活的标签页（共 18 个）：
 * - general: 通用设置（用户档案 / 账户 / 通用偏好）
 * - channels: 模型配置
 * - prompts: 提示词管理
 * - agent: Agent 配置
 * - tools: Chat 工具
 * - bots: 远程连接
 * - voice-input: 语音输入
 * - shortcuts: 快捷键管理
 * - appearance: 外观设置
 * - proxy: 代理设置
 * - devices: 登录设备
 * - subscription: 立即订阅
 * - credits: 额度与用量
 * - openapi: 开放 API
 * - data-management: 数据管理（备份+磁盘）
 * - team: 团队管理
 * - about: 关于（含意见反馈）
 * - connection / notifications: 平板连接 / 平板通知（仅平板白名单使用）
 */

import { atom } from 'jotai'

export type SettingsTab = 'general' | 'channels' | 'appearance' | 'about' | 'agent' | 'prompts' | 'tools' | 'bots' | 'tutorial' | 'shortcuts' | 'voice-input' | 'team' | 'credits' | 'subscription' | 'openapi' | 'data-management' | 'proxy' | 'devices' | 'connection' | 'notifications'

/** 当前设置标签页（不持久化，每次打开设置默认显示通用设置） */
export const settingsTabAtom = atom<SettingsTab>('general')

/** 设置浮窗是否打开 */
export const settingsOpenAtom = atom(false)

/** 渠道创建表单是否有未保存内容（用于拦截导航离开） */
export const channelFormDirtyAtom = atom(false)

/** 外部请求关闭设置面板（如 Cmd+W），SettingsPanel 监听后弹出确认对话框 */
export const settingsCloseRequestedAtom = atom(false)
