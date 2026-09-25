/**
 * 预览扩展名集合 —— 单一来源（从 DiffTabContent 抽出，供各预览路由共用）。
 *
 * `UNSUPPORTED_EXTS`：Profer 现有链路明确不支持预览的格式（历史上直接给"不支持"提示）。
 * `NON_PREVIEWABLE_BINARY_EXTS`：其中**连 OFV 也无法有意义预览**的纯二进制 / 磁盘映像 ——
 *   保留原"不支持"提示，不交给 OFV 试（免得被它的 textPlugin 当成文本渲染出一屏乱码）。
 * `IMAGE_PREVIEW_EXTS`：静态图清单。普通打开路径统一交给 OFV viewer；
 *   DiffTabContent 仍保留图片回退渲染，供历史 preview tab / 组合等旧状态安全落地。
 * `PANEL_ONLY_PREVIEW_EXTS`：必须留在预览面板的格式 —— 各有专属渲染器或契约，见各处注释。
 */

export const UNSUPPORTED_EXTS = new Set([
  // 可执行 / 库
  '.exe', '.dll', '.so', '.dylib', '.bin',
  // 归档
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.zst', '.tgz', '.tbz2', '.txz', '.tlz', '.lz', '.lzma', '.lzo',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2',
  // 编译产物
  '.wasm', '.class', '.pyc', '.pyo', '.o', '.a', '.lib', '.obj',
  // 数据库 / 磁盘映像 / 安装包
  '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb', '.iso', '.dmg', '.pkg', '.msi', '.deb', '.rpm', '.apk', '.ipa',
  // 二进制数据
  '.dat', '.data', '.bin', '.raw', '.pak',
  // 多媒体（不可预览的格式）
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.ogg', '.wav', '.aac', '.flac',
  // 其他
  '.psd', '.ai', '.sketch', '.fig', '.blend', '.max', '.3ds', '.fbx', '.glb', '.gltf',
])

/**
 * OFV 也做不了有意义预览的纯二进制 / 磁盘映像：保留原有"不支持"提示，不交给 OFV 去试，
 * 免得被 textPlugin 当成文本渲染出一屏乱码（比一句"不支持"更糟）。
 */
export const NON_PREVIEWABLE_BINARY_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.data', '.raw', '.pak',
  '.class', '.pyc', '.pyo', '.o', '.a', '.lib', '.obj',
  '.iso', '.dmg', '.pkg', '.msi', '.deb', '.rpm', '.apk', '.ipa',
])

/**
 * 静态图 / SVG（与 DiffTabContent 的 isImage 分支共用同一份清单）。
 *
 * 收录口径：**Chromium 的 `<img>` 自己能解**的位图 —— 这类交给 app 渲染器比丢给 OFV 轻，
 * 也符合「图片走列内模式」的选择。解不了的（`.tif/.tiff/.heic/.heif/.jxl/.cur`）在
 * `ofv-extensions.ts` 的 `OFV_EXTRA_EXTS` 里，由 OFV 的 imagePlugin 转换后显示。
 * `.jfif/.pjpe/.pjpeg` 是 JPEG 的别名扩展名（字节即 JPEG，Chromium 按内容嗅探）。
 */
export const IMAGE_PREVIEW_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.avif', '.apng', '.jfif', '.pjpe', '.pjpeg',
])

/**
 * 面板里**可直接编辑**的纯文本格式（`.md` 另有富文本编辑器，不在此列）。
 * 与 `DiffTabContent` 的 `isPlainTextEditable` 同源；浏览器列的列内预览也用它决定
 * 地址行该写「只读」还是「可编辑」。
 */
export const EDITABLE_TEXT_EXTS = new Set(['.txt', '.text', '.log'])

/**
 * 必须留在预览面板的格式（不进浏览器列）：
 *
 * - `.md`：富文本编辑（ProseMirror）+ 目录 + 源码编辑；
 * - `.html/.htm`：跑起来的页面 + 「渲染 / 源码」双模式（浏览器列里的 HTML 本地预览由主进程直接加载，
 *   走的是另一条路，见 `browser-controller.previewOpen` 的 HTML 分支）；
 * - `.docx` / `.pptx`：Agent 的「正式预览」回执挂在**可见的** silurus viewer 上
 *   （`official-preview-session.ts` 要 slideCount / 跳页 / 每页 canvas），搬走就断了这条契约；
 * - `.pdf`：面板内的分页缩放与查找提示（其渲染链路与 OFV 无关）。
 *
 * 注意 `.doc/.xls/.ppt` 不在此列 —— 它们在 `OFV_EXTS` 里，会被路由到浏览器列的 viewer 页。
 */
export const PANEL_ONLY_PREVIEW_EXTS = new Set([
  '.md', '.markdown', '.html', '.htm', '.docx', '.pptx', '.pdf',
])
