import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  PROJECT_WORKSPACE_ERROR_COPY,
  parseProjectWorkspaceError,
  toProjectErrorMessage,
} from '@/hooks/useProjectActions'

/**
 * P2-A「IPC 错误码结构化」契约：
 * - 主进程把 `ProjectWorkspaceError.code` 编码成 `[PROJECT:<code>] <message>`；
 * - Electron 的 `invoke` 再包一层 `Error invoking remote method '...': Error: ...`；
 * - 渲染层用纯函数 `parseProjectWorkspaceError` 还原分类，UI 只展示分类文案。
 */

const wrapInvoke = (message: string, channel = 'agent:create-project-workspace') =>
  `Error invoking remote method '${channel}': Error: ${message}`

describe('parseProjectWorkspaceError', () => {
  test('Given 带错误码的 IPC 文案 When 解析 Then 还原 code 与原始细节', () => {
    const parsed = parseProjectWorkspaceError(
      wrapInvoke('[PROJECT:already-bound] 该文件夹已绑定为项目「demo」：/tmp/demo'),
    )
    expect(parsed.code).toBe('already-bound')
    expect(parsed.text).toBe('该文件夹已绑定为项目「demo」：/tmp/demo')
  })

  test('Given 未做 Electron 包装的裸前缀文案 When 解析 Then 同样识别', () => {
    expect(parseProjectWorkspaceError('[PROJECT:path-not-writable] 项目目录不可写：/tmp/probe').code)
      .toBe('path-not-writable')
  })

  test('Given 旧版主进程（无前缀） When 解析 Then 没有 code 且文案原样保留', () => {
    const parsed = parseProjectWorkspaceError(wrapInvoke('项目路径不存在：/tmp/gone'))
    expect(parsed.code).toBeUndefined()
    expect(parsed.text).toBe('项目路径不存在：/tmp/gone')
  })

  test('Given 本端不认识的错误码 When 解析 Then 不当作已知分类（不误导文案）', () => {
    const parsed = parseProjectWorkspaceError('[PROJECT:brand-new-code] 未来版本的错误')
    expect(parsed.code).toBeUndefined()
    expect(parsed.text).toBe('未来版本的错误')
  })

  test('Given 空文案 When 解析 Then 返回空 text 且没有 code', () => {
    expect(parseProjectWorkspaceError('')).toEqual({ text: '' })
  })
})

describe('toProjectErrorMessage', () => {
  test('Given 不存在 / 不可写 / 已绑定 / 配置目录内 When 展示 Then 给出分类友好文案', () => {
    const cases: Array<[string, string]> = [
      ['path-not-found', PROJECT_WORKSPACE_ERROR_COPY['path-not-found']],
      ['path-not-writable', PROJECT_WORKSPACE_ERROR_COPY['path-not-writable']],
      ['already-bound', PROJECT_WORKSPACE_ERROR_COPY['already-bound']],
      ['path-inside-config-dir', PROJECT_WORKSPACE_ERROR_COPY['path-inside-config-dir']],
    ]
    for (const [code, expected] of cases) {
      expect(toProjectErrorMessage(new Error(wrapInvoke(`[PROJECT:${code}] 主进程细节`)), '兜底')).toBe(expected)
    }
    expect(PROJECT_WORKSPACE_ERROR_COPY['path-not-found']).toContain('不存在')
    expect(PROJECT_WORKSPACE_ERROR_COPY['path-not-writable']).toContain('不可写')
    expect(PROJECT_WORKSPACE_ERROR_COPY['already-bound']).toContain('已绑定')
    expect(PROJECT_WORKSPACE_ERROR_COPY['path-inside-config-dir']).toContain('配置目录')
  })

  test('Given 未知错误（无 code） When 展示 Then 保留原有文案清洗行为', () => {
    expect(toProjectErrorMessage(
      new Error(wrapInvoke('该文件夹已绑定为项目「demo」：/tmp/demo')),
      '兜底',
    )).toBe('该文件夹已绑定为项目「demo」：/tmp/demo')
    expect(toProjectErrorMessage(new Error('  '), '兜底')).toBe('兜底')
    expect(toProjectErrorMessage('纯字符串错误', '兜底')).toBe('纯字符串错误')
  })
})

describe('主进程编码与渲染层解析的格式契约', () => {
  test('Given ipc.ts When 编码 ProjectWorkspaceError Then 使用与解析一致的 [PROJECT:<code>] 前缀', () => {
    const ipcSource = readFileSync(new URL('../../main/ipc.ts', import.meta.url), 'utf8')
    expect(ipcSource).toContain("const PROJECT_ERROR_MESSAGE_TAG = '[PROJECT:'")
    expect(ipcSource).toContain('`${PROJECT_ERROR_MESSAGE_TAG}${error.code}] ${error.message}`')
    // 前缀字面量必须与渲染层解析共用一个格式，改动任一侧都要同步
    const encoder = ipcSource.includes('[PROJECT:') && ipcSource.includes('error.code')
    expect(encoder).toBe(true)
  })
})
