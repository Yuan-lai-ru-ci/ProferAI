/**
 * Agent 输入框是否接管一次拖放。
 *
 * `AgentView` 的 drop 只处理四类载荷：会话引用、右侧文件面板的文件引用、
 * 系统文件、以及普通纯文本。其它自定义载荷（例如侧栏「当前会话」排序把手）
 * 若也被 dragover 无条件 preventDefault + 点亮高亮，就会出现「看起来能放、
 * 松手什么都没发生」的误导。这里集中判定，dragover 与 drop 共用同一口径。
 */

import { FILE_REFERENCE_DRAG_MIME } from './file-reference-drag'
import { SESSION_REFERENCE_DRAG_MIME } from './session-reference-drag'

export function isSupportedInputDrop(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes('Files')
    // 外部拖入的富文本可能只带 text/html / text/uri-list，一律放行交给编辑器默认处理
    || types.some((type) => type.startsWith('text/'))
    || types.includes(SESSION_REFERENCE_DRAG_MIME)
    || types.includes(FILE_REFERENCE_DRAG_MIME)
}
