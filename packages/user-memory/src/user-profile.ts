/**
 * 用户档案（用户名 + 头像）读写。
 *
 * 存储：`<configDir>/user-profile.json`。
 *
 * 类型与 Electron 的 `apps/electron/src/types/user-profile.ts` 结构一致，
 * 但这里不 import 它——那个文件被 renderer 引用，而本模块要能在纯 Node / Bun
 * 环境（CLI）里运行。TypeScript 结构类型让两者可以互相赋值。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getUserProfilePath } from './paths'

/** 默认用户头像 emoji */
export const DEFAULT_USER_AVATAR = '🧑‍💻'

/** 默认用户名 */
export const DEFAULT_USER_NAME = '用户'

export interface UserProfile {
  /** 用户名 */
  userName: string
  /** 头像（emoji 字符串 或 data:image/* base64 URL） */
  avatar: string
}

function defaults(): UserProfile {
  return { userName: DEFAULT_USER_NAME, avatar: DEFAULT_USER_AVATAR }
}

/**
 * 读取用户档案。
 *
 * 文件不存在或内容损坏时返回默认档案，不抛错——画像缺失不应该让调用方失败。
 */
export function readUserProfile(configDir: string): UserProfile {
  const filePath = getUserProfilePath(configDir)
  if (!existsSync(filePath)) return defaults()

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<UserProfile>
    return {
      userName: data.userName || DEFAULT_USER_NAME,
      avatar: data.avatar || DEFAULT_USER_AVATAR,
    }
  } catch {
    return defaults()
  }
}

/**
 * 合并更新用户档案并写盘。
 *
 * 与旧实现相比多了一步 mkdir：CLI 首次运行时配置目录可能还不存在，
 * 而 `resolveConfigDir()` 只解析路径、不创建目录。
 */
export function writeUserProfile(configDir: string, updates: Partial<UserProfile>): UserProfile {
  const updated: UserProfile = { ...readUserProfile(configDir), ...updates }
  const filePath = getUserProfilePath(configDir)

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 })

  return updated
}
