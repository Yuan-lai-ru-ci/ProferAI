import { describe, expect, test } from 'bun:test'
import { getRewindConfirmCopy } from './RewindDialog'

/**
 * 设计 §8 的 UI 约束在测试里表达：主路径只有一次确认，
 * 且文案里不能出现内部词汇或让用户判断冲突。
 */
describe('RewindDialog 确认文案', () => {
  test('只有一次确认：标题、说明、按钮，且不暴露内部词汇', () => {
    const copy = getRewindConfirmCopy('rewind')
    expect(copy.title).toBe('确认回退？')
    expect(copy.submitLabel).toBe('回退')
    const text = `${copy.title}${copy.description}${copy.submitLabel}`
    for (const forbidden of ['Shadow Git', 'shadow', 'commit', 'patch', 'uuid', 'UUID', '版本', '冲突', '只回退对话', '只恢复文件']) {
      expect(text).not.toContain(forbidden)
    }
  })

  test('说明同时交代「文件一起撤销」和「用户自己的修改保留」', () => {
    const copy = getRewindConfirmCopy('rewind')
    expect(copy.description).toContain('文件也一起撤销')
    expect(copy.description).toContain('你自己后来改过的内容会保留')
  })

  test('重新生成与重发沿用同一确认，只是按钮动词不同', () => {
    expect(getRewindConfirmCopy('regenerate')).toMatchObject({ title: '确认回退？', submitLabel: '回退并重新生成' })
    expect(getRewindConfirmCopy('edit-resend')).toMatchObject({ title: '确认回退？', submitLabel: '回退并重发' })
  })
})
