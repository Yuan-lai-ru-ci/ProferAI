/** 全局 Skill 路径边界校验；所有外部 slug 和运行时目录名共用。 */
import { isAbsolute, join, relative, resolve, win32, posix } from 'node:path'

const WINDOWS_INVALID_SEGMENT_CHARS = /[<>:"/\\|?*]/
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

/**
 * Skill slug 的跨平台唯一键。
 *
 * 保留原始 slug 用于展示和目录命名；只在判重与冲突解析时统一 Unicode
 * 规范化和大小写，避免 macOS/Linux 上可并存的名称投影到 Windows 后相撞。
 */
export function canonicalSkillSegmentKey(value: string): string {
  return value.normalize('NFC').toLowerCase().normalize('NFC')
}

export function assertSafeSkillSegment(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${fieldName} 不能为空`)
  const normalized = value.normalize('NFC')
  if (normalized === '.' || normalized === '..' || WINDOWS_INVALID_SEGMENT_CHARS.test(normalized)) {
    throw new Error(`${fieldName} 包含非法路径片段`)
  }
  if (isAbsolute(normalized) || win32.isAbsolute(normalized) || posix.isAbsolute(normalized)) {
    throw new Error(`${fieldName} 不允许使用绝对路径`)
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${fieldName} 包含非法控制字符`)
  if (/[. ]$/.test(normalized)) throw new Error(`${fieldName} 不能以点或空格结尾`)
  if (WINDOWS_RESERVED_DEVICE_NAME.test(normalized)) throw new Error(`${fieldName} 使用了 Windows 保留设备名`)
  return value
}

/** 拼接后再次验证目标仍在 root 内，防止未来调用方放宽 segment 规则时留下越界。 */
export function safeSkillPath(root: string, segment: string, fieldName: string): string {
  assertSafeSkillSegment(segment, fieldName)
  const rootResolved = resolve(root)
  const target = resolve(rootResolved, segment)
  const rel = relative(rootResolved, target)
  if (rel === '..' || rel.startsWith(`..${posix.sep}`) || rel.startsWith(`..${win32.sep}`) || isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw new Error(`${fieldName} 超出目标目录范围`)
  }
  return join(rootResolved, segment)
}

export function assertSafeSkillRootChild(root: string, child: string, fieldName: string): string {
  const rootResolved = resolve(root)
  const target = resolve(child)
  const rel = relative(rootResolved, target)
  if (rel === '..' || rel.startsWith(`..${posix.sep}`) || rel.startsWith(`..${win32.sep}`) || isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw new Error(`${fieldName} 超出目标目录范围`)
  }
  return target
}
