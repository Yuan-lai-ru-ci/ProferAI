/**
 * 设备 ID 的 OS 级持久化 —— 扛住 ~/.profer 被清空 / 应用重装。
 *
 * device.json（config 目录）在版本更新时保留，但清目录/重装会丢；
 * 这里把 deviceId 额外写到操作系统级、不随 app 数据目录清理的地方：
 *   - Windows: 注册表 HKCU\Software\<ns>\DeviceId（reg.exe，无原生模块依赖）
 *   - macOS:   login keychain（security CLI）
 *   - Linux/其他: 暂不支持，返回 null，由上层回退到 config 目录文件
 *
 * 命名空间按 config 目录名区分（profer / profer-dev），保证开发版与正式版
 * 各自独立的 deviceId，不互相干扰。
 *
 * 任何读写失败都静默降级（不抛错、不阻断登录）——最坏情况退化为仅 device.json，
 * 仍能修复版本更新导致的槽位 churn（清目录才会丢）。
 */
import { execFileSync } from 'node:child_process'
import { getConfigDirName } from './config-paths'

/** 持久化命名空间：'.profer' → 'profer'，'.profer-dev' → 'profer-dev' */
function ns(): string {
  return getConfigDirName().replace(/^\./, '') || 'profer'
}

/** 从 OS 级持久位置读取 deviceId；不存在 / 不支持 / 失败均返回 null */
export function readDurableDeviceId(): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', `HKCU\\Software\\${ns()}`, '/v', 'DeviceId'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const m = out.match(/DeviceId\s+REG_SZ\s+(\S+)/)
      return m?.[1] || null
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('security', ['find-generic-password', '-s', ns(), '-a', 'DeviceId', '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.trim() || null
    }
  } catch {
    // 未找到 / 不支持 → null
  }
  return null
}

/** 把 deviceId 写入 OS 级持久位置；失败静默（降级为仅 config 目录文件） */
export function writeDurableDeviceId(id: string): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('reg', ['add', `HKCU\\Software\\${ns()}`, '/v', 'DeviceId', '/t', 'REG_SZ', '/d', id, '/f'], {
        stdio: 'ignore',
      })
      return
    }
    if (process.platform === 'darwin') {
      execFileSync('security', ['add-generic-password', '-s', ns(), '-a', 'DeviceId', '-w', id, '-U'], {
        stdio: 'ignore',
      })
    }
  } catch {
    // 降级：仅靠 config 目录文件
  }
}
