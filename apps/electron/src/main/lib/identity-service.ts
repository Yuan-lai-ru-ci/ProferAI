/**
 * 身份服务
 *
 * 管理设备身份和用户身份。
 * Phase 1: 仅设备 ID 生成与持久化。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getDeviceIdentityPath } from './config-paths'
import type { DeviceIdentity, UserIdentity } from '../../types/identity'

/**
 * 生成设备友好名称
 */
function generateDeviceName(): string {
  const hostname = (() => {
    try {
      return require('node:os').hostname() || 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  const platform = process.platform === 'darwin'
    ? 'Mac'
    : process.platform === 'win32'
      ? 'Windows'
      : 'Linux'
  return `${platform} (${hostname})`
}

let _deviceIdentity: DeviceIdentity | null = null

/**
 * 获取设备身份，不存在则创建
 */
export function getOrCreateDeviceIdentity(): DeviceIdentity {
  if (_deviceIdentity) return _deviceIdentity

  const path = getDeviceIdentityPath()

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      _deviceIdentity = JSON.parse(raw) as DeviceIdentity
      return _deviceIdentity!
    } catch {
      // 文件损坏，重新生成
    }
  }

  const identity: DeviceIdentity = {
    deviceId: randomUUID(),
    deviceName: generateDeviceName(),
    registeredAt: Date.now(),
  }

  try {
    writeFileSync(path, JSON.stringify(identity, null, 2), 'utf-8')
    console.log(`[身份] 已生成设备身份: ${identity.deviceName} (${identity.deviceId})`)
  } catch (err) {
    console.warn('[身份] 持久化设备身份失败:', err)
  }

  _deviceIdentity = identity
  return identity
}

/**
 * 更新设备名称
 */
export function updateDeviceName(name: string): DeviceIdentity {
  const identity = getOrCreateDeviceIdentity()
  identity.deviceName = name

  try {
    writeFileSync(getDeviceIdentityPath(), JSON.stringify(identity, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[身份] 更新设备名称失败:', err)
  }

  return identity
}

/**
 * 获取当前用户身份
 *
 * Phase 1: 仅返回本地用户档案（无团队账户绑定）。
 * Phase 2: 扩展为从 auth-service 获取。
 */
export function getUserIdentity(): UserIdentity {
  // 暂时从 user-profile.json 读取，Phase 2 扩展为完整 UserIdentity
  const { getUserProfilePath } = require('./user-profile-service')
  const profilePath = (getUserProfilePath as () => string)()
  let displayName = '用户'
  let avatar = '🧑‍💻'

  if (existsSync(profilePath)) {
    try {
      const raw = readFileSync(profilePath, 'utf-8')
      const profile = JSON.parse(raw)
      displayName = profile.userName || displayName
      avatar = profile.avatar || avatar
    } catch {
      // 使用默认值
    }
  }

  return {
    displayName,
    avatar,
    createdAt: Date.now(),
  }
}
