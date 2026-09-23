/**
 * 「文件点开去哪儿」的单一判定（纯函数，供 preview-opener 路由 + 单测共用）。
 *
 * 文件入口统一交给右侧 Browser：
 * - `ofv-viewer`：Open File Viewer 承担的长尾格式 → Browser 列里的独立 viewer 页（沙箱 webContents、无 preload）；
 * - `browser-inline`：其余格式 → Browser 列里的 app 渲染器，由 `DiffTabContent` 显示内容或“不支持预览”提示。
 *
 * 为什么集中在这里：此前「去哪」散落在 `preview-opener` 的分支与 `DiffTabContent` 的扩展名判定里，
 * 两处各持一半事实。路由必须能被单测逐格式钉住，否则改一处就会静默错位。
 */
import { isOfvBackedPath } from './ofv-extensions'

export type PreviewDestination = 'ofv-viewer' | 'browser-inline'

export function resolvePreviewDestination(filePath: string): PreviewDestination {
  // OFV 优先：长尾格式仍在右侧 Browser 的独立 viewer 页中打开。
  if (isOfvBackedPath(filePath)) return 'ofv-viewer'

  // 其余本地文件统一进入右侧 Browser 的列内预览：
  // 文本、Markdown、HTML、PDF、Office 与不支持的二进制，均由 BrowserInlinePreview
  // 承载；后者在 Browser 内显示“不支持预览”提示，不再把入口分流到独立预览面板。
  return 'browser-inline'
}
