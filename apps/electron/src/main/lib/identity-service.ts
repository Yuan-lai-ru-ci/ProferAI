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
 * 获取设备身份，不存在则创建。
 *
 * deviceId 优先级：OS 级持久位置（注册表/keychain，扛清目录）> device.json 快取 > 新生成。
 * 无论来源如何，最终都双写回 OS 级持久位置 + device.json，保证两处一致。
 */
export function getOrCreateDeviceIdentity(): DeviceIdentity {
  if (_deviceIdentity) return _deviceIdentity

  const path = getDeviceIdentityPath()
  const { readDurableDeviceId, writeDurableDeviceId } = require('./device-durable-store')

  // 读 config 目录快取（含 deviceName / registeredAt）
  let identity: DeviceIdentity | null = null
  if (existsSync(path)) {
    try {
      identity = JSON.parse(readFileSync(path, 'utf-8')) as DeviceIdentity
    } catch {
      // 文件损坏，忽略
    }
  }

  // OS 级持久 deviceId 优先（config 目录被清后仍认得同一台机）
  const durableId: string | null = readDurableDeviceId()
  const finalId = durableId || identity?.deviceId || randomUUID()

  if (!identity) {
    identity = { deviceId: finalId, deviceName: generateDeviceName(), registeredAt: Date.now() }
  } else if (identity.deviceId !== finalId) {
    identity.deviceId = finalId
  }

  // OS 级持久位置缺失则回填（首次运行 / 之前降级过）
  if (!durableId) {
    try { writeDurableDeviceId(finalId) } catch { /* 静默降级 */ }
  }
  try {
    writeFileSync(path, JSON.stringify(identity, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[身份] 持久化设备身份失败:', err)
  }

  _deviceIdentity = identity
  console.log(`[身份] 设备身份: ${identity.deviceName} (${identity.deviceId})${durableId ? ' [OS级持久]' : ''}`)
  return identity
}

/**
 * 取登录/刷新请求要带的设备信息（注册设备数模型）。
 */
export function getDeviceAuthInfo(): { deviceId: string; deviceName: string; platform: string; appVersion: string } {
  const id = getOrCreateDeviceIdentity()
  let appVersion = ''
  try { appVersion = require('electron').app.getVersion() } catch { /* 非 Electron 环境 */ }
  return { deviceId: id.deviceId, deviceName: id.deviceName, platform: process.platform, appVersion }
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
