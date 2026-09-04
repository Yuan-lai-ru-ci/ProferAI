import { describe, expect, test } from 'bun:test'
import { createTextContextMenuTemplate, type TextContextMenuParams } from './menu'

function makeParams(overrides: Partial<TextContextMenuParams> = {}): TextContextMenuParams {
  return {
    isEditable: false,
    selectionText: '',
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false,
      canEditRichly: false,
    },
    ...overrides,
  }
}

describe('文本右键菜单', () => {
  test('Given 可编辑输入框 When 剪贴板可粘贴 Then 显示且启用粘贴菜单', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
      editFlags: {
        ...makeParams().editFlags,
        canPaste: true,
        canSelectAll: true,
      },
    }), 'win32')

    expect(template.find((item) => item.role === 'paste')).toMatchObject({
      label: '粘贴',
      enabled: true,
    })
  })

  test('Given 普通页面有文本选区 When 用户右键 Then 只提供可用的复制操作', () => {
    const template = createTextContextMenuTemplate(makeParams({
      selectionText: '要复制的文字',
      editFlags: {
        ...makeParams().editFlags,
        canCopy: true,
        canSelectAll: true,
      },
    }), 'win32')

    expect(template).toEqual([{ role: 'copy', label: '复制', enabled: true }])
  })

  test('Given 非编辑区域且没有选区 When 用户右键 Then 不创建菜单以保留业务右键行为', () => {
    expect(createTextContextMenuTemplate(makeParams(), 'win32')).toEqual([])
  })

  test('Given macOS 可编辑输入框 When 用户右键 Then 提供粘贴并匹配样式', () => {
    const template = createTextContextMenuTemplate(makeParams({
      isEditable: true,
      editFlags: {
        ...makeParams().editFlags,
        canPaste: true,
      },
    }), 'darwin')

    expect(template.find((item) => item.role === 'pasteAndMatchStyle')).toMatchObject({
      label: '粘贴并匹配样式',
      enabled: true,
    })
  })
})
