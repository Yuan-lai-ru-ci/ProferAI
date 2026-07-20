/**
 * 团队文件路由纯逻辑测试
 *
 * 覆盖路径归一化和普通成员文件操作权限。
 */
import { describe, expect, test } from 'bun:test'
import { canModifyRows, normalizeFilePath } from './file-route-utils.js'

describe('normalizeFilePath', () => {
  test('归一化 Windows 分隔符和首尾斜杠', () => {
    expect(normalizeFilePath('/docs\\plan.md/')).toBe('docs/plan.md')
  })

  test('拒绝路径遍历、空路径和服务端保留路径', () => {
    expect(normalizeFilePath('../secret.txt')).toBeNull()
    expect(normalizeFilePath('docs/../secret.txt')).toBeNull()
    expect(normalizeFilePath('')).toBeNull()
    expect(normalizeFilePath('__trash__/entry/a.md')).toBeNull()
    expect(normalizeFilePath('.trash/ws/entry/a.md')).toBeNull()
  })
})

describe('canModifyRows', () => {
  test('允许普通成员操作自己上传的文件', () => {
    expect(canModifyRows([
      { is_directory: 0, uploaded_by: 'u1' },
    ], 'u1')).toBe(true)
  })

  test('拒绝普通成员操作别人上传的文件', () => {
    expect(canModifyRows([
      { is_directory: 0, uploaded_by: 'u2' },
    ], 'u1')).toBe(false)
  })

  test('拒绝普通成员删除包含别人文件的目录', () => {
    expect(canModifyRows([
      { is_directory: 1, uploaded_by: 'u1' },
      { is_directory: 0, uploaded_by: 'u2' },
    ], 'u1')).toBe(false)
  })

  test('允许普通成员移动空目录', () => {
    expect(canModifyRows([
      { is_directory: 1, uploaded_by: '' },
    ], 'u1')).toBe(true)
  })
})

// ===== 文件搜索 =====

describe('文件搜索 LIKE 模式构建', () => {
  function buildLikePattern(q) {
    if (!q || !q.trim()) return null
    const trimmed = q.trim()
    if (trimmed.includes('*') || trimmed.includes('?')) {
      return trimmed.replace(/\*/g, '%').replace(/\?/g, '_')
    }
    return `%${trimmed}%`
  }

  test('无通配符时子串匹配', () => {
    expect(buildLikePattern('readme')).toBe('%readme%')
  })

  test('* 转换为 %', () => {
    expect(buildLikePattern('*.md')).toBe('%.md')
    expect(buildLikePattern('test*.ts')).toBe('test%.ts')
  })

  test('? 转换为 _', () => {
    expect(buildLikePattern('file?.txt')).toBe('file_.txt')
  })

  test('混合通配符', () => {
    expect(buildLikePattern('src/*/test?.ts')).toBe('src/%/test_.ts')
  })

  test('空查询返回 null', () => {
    expect(buildLikePattern('')).toBeNull()
    expect(buildLikePattern('  ')).toBeNull()
  })
})
