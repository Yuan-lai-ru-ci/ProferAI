/**
 * 交给 Open File Viewer 的扩展名 —— 单一来源。
 *
 * 两处消费：
 * - `components/diff/DiffTabContent.tsx`：预览面（回退路径）判断是否用 OfvPreview 渲染；
 * - `components/diff/preview-opener.ts`：用户打开文件时判断是走浏览器 viewer 页（主路径）还是渲染进程预览面。
 *
 * 划界原则：
 * - 老式 Office（.doc/.xls/.ppt）：此前渲染 null（一片空白）；
 * - 此前归入 `UNSUPPORTED_EXTS` 的长尾格式（归档 / 设计文件 / 3D / GIS / 电子书 / 邮件 / 数据…）；
 * - `OFV_EXTRA_EXTS`：OFV 有插件但历史上漏在清单外、当下会渲成乱码的那批（见该处注释）；
 * - `.xlsx`：SheetJS 路径，不需要页数/抓图回执；
 * - **不含 `.docx` / `.pptx`**：见 DiffTabContent 与 preview-opener 里的说明（注入面 / Agent 回执）。
 */
import { NON_PREVIEWABLE_BINARY_EXTS, IMAGE_PREVIEW_EXTS, UNSUPPORTED_EXTS } from './preview-extension-sets'

/** OFV 承担的 Office 格式（不含 docx/pptx） */
export const OFV_OFFICE_EXTS: ReadonlySet<string> = new Set(['.xlsx', '.doc', '.xls', '.ppt'])

/**
 * OFV 有插件、但历史上漏在清单外的格式（2026-09-18 补齐）。
 *
 * 入选口径只有一条：**今天会落到文本兜底渲染器 → 二进制被当 UTF-8 渲成乱码**，
 * 而 OFV 有对应插件能正经渲染。按这条口径逐族扫了 OFV 0.1.47 的插件表：
 * - 电子书 / 版式文档 / 邮件 / 脑图：`.epub` `.ofd` `.xps` `.oxps` `.eml` `.msg` `.mbox` `.xmind`；
 * - 需要解码器的图片：Chromium 的 `<img>` 画不出 `.tif/.tiff/.heic/.heif/.jxl/.cur`，
 *   OFV 的 imagePlugin 自带 TIFF 分页转换与 HEIC 转 JPEG（失败时它会给"无法预览"兜底，比乱码好）；
 * - Office 家族其余扩展名：`.docm` `.dot/.dotm/.dotx` `.xlsb/.xlsm` `.xlt/.xltm/.xltx`
 *   `.potx/.potm` `.pps/.ppsx/.ppsm/.pptm` `.odt/.ods/.odp` `.fodt/.fods/.fodp`
 *   `.rtf` `.wps/.et/.dps` `.numbers/.key`；
 * - 设计 / 资产：`.eps/.ps/.psb` `.parquet/.avro` `.webarchive/.eot`；
 * - 3D 模型（二进制本体）：`.stl/.ply/.3mf` 与 `.usd` 家族（usd/usda/usdc/usdz）。
 *
 * 刻意**不在**此列 —— 「当纯文本看也读得出来」的一律不动，留给文本渲染器（可搜可划词）：
 * `.csv/.tsv`、`.json/.yaml/.xml` 家族、`.geojson/.kml/.gpx/.topojson`、`.drawio/.excalidraw/.tldraw`、
 * `.dxf`、`.dae/.vrml/.wrl`（ASCII 三维格式）；
 * 也不含 `.obj` —— 它在 `NON_PREVIEWABLE_BINARY_EXTS` 里按「编译产物」处理（本身就双义），不抢。
 * 也不含 CAD 家族（`.dwg/.dwf/.skp/.sat…`）：本仓库刻意不挂 `cadPlugin`，见 `lib/ofv-plugins.ts`。
 */
export const OFV_EXTRA_EXTS: ReadonlySet<string> = new Set([
  // 电子书 / 版式文档 / 邮件 / 脑图
  '.epub', '.ofd', '.xps', '.oxps', '.eml', '.msg', '.mbox', '.xmind',
  // 需要解码器的图片
  '.tif', '.tiff', '.heic', '.heif', '.jxl', '.cur',
  // Office 家族其余扩展名
  '.docm', '.dot', '.dotm', '.dotx',
  '.xlsb', '.xlsm', '.xlt', '.xltm', '.xltx',
  '.potx', '.potm', '.pps', '.ppsx', '.ppsm', '.pptm',
  '.odt', '.ods', '.odp', '.fodt', '.fods', '.fodp', '.rtf',
  '.wps', '.et', '.dps', '.numbers', '.key',
  // 设计 / 资产
  '.eps', '.ps', '.psb', '.parquet', '.avro', '.webarchive', '.eot',
  // 3D 模型（二进制本体；ASCII 的 .dae/.vrml/.wrl 与双义的 .obj 不收）
  '.stl', '.ply', '.3mf', '.usd', '.usda', '.usdc', '.usdz',
])

export const OFV_EXTS: ReadonlySet<string> = new Set([
  ...OFV_OFFICE_EXTS,
  ...OFV_EXTRA_EXTS,
  ...IMAGE_PREVIEW_EXTS,
  ...[...UNSUPPORTED_EXTS].filter((extension) => !NON_PREVIEWABLE_BINARY_EXTS.has(extension)),
])

/** 取小写扩展名（含点）；无扩展名返回空串 */
export function fileExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** 这个文件是否应由 Open File Viewer 承担预览 */
export function isOfvBackedPath(filePath: string): boolean {
  return OFV_EXTS.has(fileExtension(filePath))
}
