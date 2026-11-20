import { describe, expect, test } from 'bun:test'
import { openModelSelectorAfterPopoverClose } from './model-selector-dialog'

describe('模型弹层交接', () => {
  test('先关闭二级菜单，再在下一拍打开模型选择器', () => {
    const calls: string[] = []
    let openModelDialog: (() => void) | undefined
    openModelSelectorAfterPopoverClose(
      () => calls.push('close-popover'),
      () => calls.push('open-dialog'),
      callback => { openModelDialog = callback },
    )

    expect(calls).toEqual(['close-popover'])
    openModelDialog?.()
    expect(calls).toEqual(['close-popover', 'open-dialog'])
  })
})
