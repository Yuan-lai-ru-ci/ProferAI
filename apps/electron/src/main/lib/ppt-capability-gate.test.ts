import { describe, expect, test } from 'bun:test'
import { evaluatePptCapability } from './ppt-capability-gate'

describe('PPT capability gate', () => {
  test('普通会话不注入 PPT 能力', () => {
    expect(evaluatePptCapability({
      userMessage: '帮我检查这个 TypeScript 项目的类型错误。',
      active: false,
      hasActiveDeckProject: false,
    })).toMatchObject({ decision: 'inactive', active: false })
  })

  test('明确创建 PPTX 的高置信意图激活当前会话', () => {
    expect(evaluatePptCapability({
      userMessage: '请根据这些材料制作一个 .pptx 组会汇报，并导出文件。',
      active: false,
      hasActiveDeckProject: false,
    })).toMatchObject({ decision: 'activate', active: true })
  })

  test('已有活动 Deck Project 时修改第 N 页保持激活', () => {
    expect(evaluatePptCapability({
      userMessage: '请修改第 3 页并打开刚才的 PPT 预览。',
      active: true,
      hasActiveDeckProject: true,
    })).toMatchObject({ decision: 'stay_active', active: true })
  })

  test('PPT 出现在普通文件名或变量名中不会单独激活', () => {
    expect(evaluatePptCapability({
      userMessage: '请解释变量 pptxExportOptions 在这段代码中的作用。',
      active: false,
      hasActiveDeckProject: false,
    })).toMatchObject({ decision: 'inactive', active: false })
  })

  test('明确退出 PPT 模式优先关闭能力但不删除项目', () => {
    expect(evaluatePptCapability({
      userMessage: '退出 PPT 模式，先不要继续做演示文稿。',
      active: true,
      hasActiveDeckProject: true,
    })).toMatchObject({ decision: 'deactivate', active: false })
  })
})
