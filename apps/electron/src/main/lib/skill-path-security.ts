/** 全局 Skill 路径边界校验；所有外部 slug 和运行时目录名共用。 */
import { isAbsolute, join, relative, resolve, win32, posix } from 'node:path'

export function assertSafeSkillSegment(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${fieldName} 不能为空`)
  if (value.includes('\0') || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`${fieldName} 包含非法路径片段`)
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)) {
    throw new Error(`${fieldName} 不允许使用绝对路径`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${fieldName} 包含非法控制字符`)
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
