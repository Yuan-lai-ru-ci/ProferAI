import type { BrowserWindow, Input } from 'electron'

/** 判断是否为 macOS 键盘上的 F1–F12 功能键。 */
export function isMacFunctionKey(input: Pick<Input, 'key' | 'type'>): boolean {
  return input.type === 'keyDown' && /^F(?:[1-9]|1[0-2])$/i.test(input.key)
}

/**
 * 已被 Profer 占用为快捷键、需放行给渲染进程的功能键（小写）。
 *
 * 目前仅 F2：它是渲染层「重命名」的默认绑定（renderer/lib/shortcut-defaults.ts 的 rename-item）。
 * 渲染层的快捷键注册表在没有匹配 handler 时会自行吞掉这些按键，因此放行不会漏出原生焦点导航。
 * 若渲染层新增其它 F 键默认绑定，需同步补充此集合。
 */
const RESERVED_FUNCTION_KEYS = new Set(['f2'])

/** 判断该功能键是否已被 Profer 占用为快捷键（应放行给渲染进程处理）。 */
export function isReservedFunctionKey(input: Pick<Input, 'key'>): boolean {
  return RESERVED_FUNCTION_KEYS.has(input.key.toLowerCase())
}

/**
 * 阻止 macOS F1–F12 继续交给 Chromium。
 *
 * 在部分 macOS 键盘设置下，Fn+数字行会被 Electron 上报为 F1–F12；
 * Chromium 随后会触发原生焦点导航，在窗口内绘制黄色焦点框。除已被
 * Profer 占用为快捷键的功能键外，其余在输入边界直接吞掉最安全。
 */
export function installMacFunctionKeyBlocker(win: BrowserWindow): void {
  if (process.platform !== 'darwin') return

  win.webContents.on('before-input-event', (event, input) => {
    if (!isMacFunctionKey(input)) return
    // 已占用为快捷键的功能键放行，交给渲染进程的快捷键注册表分发
    if (isReservedFunctionKey(input)) return
    event.preventDefault()
  })
}
