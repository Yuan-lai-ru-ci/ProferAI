/**
 * 回退后清理「文件改动」面板的内存记录。
 *
 * 真实缺陷：非 Git 目录的写入记录是渲染层在 tool_result 时累积的，
 * 回退删掉文件后没有权威来源可重扫，面板会一直显示「新建 xxx.md」。
 */
import { describe, expect, test } from 'bun:test'
import { dropRewoundSessionFileChanges, type SessionFileChange } from './session-file-changes'

const created = (path: string): SessionFileChange => ({ path, kind: 'created', runId: 'r1', updatedAt: 1 })
const edited = (path: string): SessionFileChange => ({ path, kind: 'edited', runId: 'r1', updatedAt: 2 })

const ABS = '/Users/mac/.profer-dev/agent-workspaces/default/session-1/1121.md'

describe('回退后清理非 Git 变更记录', () => {
  test('被回退删除的文件即使是绝对路径也能命中相对路径', () => {
    const next = dropRewoundSessionFileChanges([created(ABS)], { deleted: ['session-1/1121.md'] })
    expect(next).toHaveLength(0)
  })

  test('被恢复的文件不再是本次改动', () => {
    const next = dropRewoundSessionFileChanges([edited(ABS)], { restored: ['session-1/1121.md'] })
    expect(next).toHaveLength(0)
  })

  test('没被回退碰到的文件必须保留', () => {
    const other = '/Users/mac/.profer-dev/agent-workspaces/default/session-1/keep.md'
    const next = dropRewoundSessionFileChanges([created(ABS), edited(other)], { deleted: ['session-1/1121.md'] })
    expect(next.map(f => f.path)).toEqual([other])
  })

  test('上一级的同前缀目录不能被误伤', () => {
    const sibling = '/Users/mac/.profer-dev/agent-workspaces/default/session-11/1121.md'
    const next = dropRewoundSessionFileChanges([created(sibling)], { deleted: ['session-1/1121.md'] })
    expect(next).toHaveLength(1)
  })

  test('只有纯文件名时不参与尾部匹配，避免抹掉同名文件', () => {
    const next = dropRewoundSessionFileChanges([created(ABS)], { deleted: ['1121.md'] })
    expect(next).toHaveLength(1)
  })

  test('没有回退文件时原样返回（不产生无意义的新数组写入）', () => {
    const list = [created(ABS)]
    expect(dropRewoundSessionFileChanges(list, undefined)).toEqual(list)
    expect(dropRewoundSessionFileChanges(list, { deleted: [], restored: [] })).toEqual(list)
  })

  test('conflicts 不在清理范围内：文件确实被改过，只是没能自动对齐', () => {
    const next = dropRewoundSessionFileChanges([created(ABS)], {
      deleted: [], restored: [], conflicts: ['session-1/1121.md'],
    } as never)
    expect(next).toHaveLength(1)
  })
})
