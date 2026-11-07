/**
 * 用户档案服务 —— Electron 主进程适配层。
 *
 * 读写实现已下沉到 `@profer/user-memory`，与 profer CLI 的
 * `profer profile show` 共用同一份逻辑与同一个文件：
 * `<configDir>/user-profile.json`。
 *
 * 这里只负责把配置目录接上主进程的 `getConfigDir()`。
 */

import { readUserProfile, writeUserProfile } from '@profer/user-memory'
import type { UserProfile } from '../../types'
import { getConfigDir } from './config-root'

/**
 * 获取用户档案
 *
 * 文件不存在或内容损坏时返回默认档案，不抛错。
 */
export function getUserProfile(): UserProfile {
  return readUserProfile(getConfigDir())
}

/**
 * 更新用户档案
 *
 * 合并更新字段并写入文件。
 */
export function updateUserProfile(updates: Partial<UserProfile>): UserProfile {
  try {
    const updated = writeUserProfile(getConfigDir(), updates)
    console.log(`[用户档案] 已更新: ${updated.userName}`)
    return updated
  } catch (error) {
    console.error('[用户档案] 写入失败:', error)
    throw new Error('写入用户档案失败')
  }
}
