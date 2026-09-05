import type { BrowserWindow, Input } from 'electron'

/** 判断是否为 macOS 键盘上的 F1–F12 功能键。 */
export function isMacFunctionKey(input: Pick<Input, 'key' | 'type'>): boolean {
  return input.type === 'keyDown' && /^F(?:[1-9]|1[0-2])$/i.test(input.key)
}

/**
 * 阻止 macOS F1–F12 继续交给 Chromium。
 *
 * 在部分 macOS 键盘设置下，Fn+数字行会被 Electron 上报为 F1–F12；
 * Chromium 随后会触发原生焦点导航，在窗口内绘制黄色焦点框。Profer
 * 当前没有 F1–F12 快捷键，因此在输入边界直接吞掉这些事件最安全。
 */
export function installMacFunctionKeyBlocker(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return

  win.webContents.on('before-input-event', (event, input) => {
    if (!isMacFunctionKey(input)) return
    event.preventDefault()
  })
}
