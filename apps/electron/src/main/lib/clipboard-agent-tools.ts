/**
 * Agent 系统剪贴板工具服务
 *
 * 提供 `clipboard_read_text` / `clipboard_write_text` 两个 Agent 工具的正规主进程实现，
 * 底层用 Electron `clipboard`（UTF-8，天然无 Windows 代码页乱码问题）。
 *
 * 背景：Profer 此前没有暴露剪贴板工具给 Agent，导致 Agent 读到系统剪贴板时只能退化为
 * `PowerShell Get-Clipboard`，而 Windows 控制台默认代码页（GBK/936）会让中文乱码。
 * 本服务给 Agent 一条优雅的正路：走主进程 Electron clipboard，不依赖 PowerShell。
 *
 * 安全边界：用户已确认「完全放开」读/写系统剪贴板，与受管浏览器 clipboard-read
 * 许可策略保持一致。读取的文本会经 JSON 序列化返回给模型，剪贴板内敏感内容
 * （如密码）存在被 Agent 读取的可能，属用户已知并接受的边界。
 */

import { clipboard } from 'electron'

/** 单次读/写剪贴板的字符上限，防止超大内容影响输出与内存。 */
export const MAX_CLIPBOARD_TEXT_CHARS = 64_000

export class ClipboardAgentToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClipboardAgentToolError'
  }
}

/** 带上限的读剪贴板文本；空剪贴板抛错，避免 Agent 误以为读到空字符串。 */
export function readClipboardText(): { text: string; truncated: boolean; totalChars: number } {
  const text = clipboard.readText()
  if (!text) throw new ClipboardAgentToolError('系统剪贴板当前没有文本。')
  const totalChars = Array.from(text).length
  if (totalChars > MAX_CLIPBOARD_TEXT_CHARS) {
    const truncated = Array.from(text).slice(0, MAX_CLIPBOARD_TEXT_CHARS).join('')
    return { text: truncated, truncated: true, totalChars }
  }
  return { text, truncated: false, totalChars }
}

/** 带上限的写剪贴板文本；空输入或超长抛错。 */
export function writeClipboardText(text: string): { writtenChars: number } {
  if (!text) throw new ClipboardAgentToolError('要写入剪贴板的文本不能为空。')
  const charCount = Array.from(text).length
  if (charCount > MAX_CLIPBOARD_TEXT_CHARS) {
    throw new ClipboardAgentToolError(`文本超过 ${MAX_CLIPBOARD_TEXT_CHARS} 个字符上限，请先精简后再写入剪贴板。`)
  }
  clipboard.writeText(text)
  return { writtenChars: charCount }
}
