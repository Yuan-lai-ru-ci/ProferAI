/**
 * Vite dev 时 renderer 位于 http://localhost:5174/index.html，打包后位于
 * file:///.../renderer/index.html。必须相对页面而非本 TS 模块路径解析，否则
 * 动态 import 会错误命中 /src/.../office-preview/vendor，触发旧 HTML fallback。
 * 延迟读取 location，使路由/缩放纯函数也能在 Node 测试环境中加载。
 */
function vendorBase(): string {
  if (typeof window === 'undefined') return './vendor/ooxml'
  return new URL('./vendor/ooxml', window.location.href).href.replace(/\/$/, '')
}

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'

interface WasmManifest {
  docx?: string
  xlsx?: string
  pptx?: string
}

interface ZoomableViewer {
  load(source: string | ArrayBuffer): Promise<void>
  destroy(): void
  getScale?: () => number
  setScale?: (scale: number) => void
  fitWidth?: () => void
  fitPage?: () => void
}

interface ScrollViewerOptions {
  wasmUrl?: string
  enableTextSelection?: boolean
  zoomMin?: number
  zoomMax?: number
  onError?: (error: Error) => void
  onScaleChange?: (scale: number) => void
}

interface ViewerModule {
  new (container: HTMLElement, options?: ScrollViewerOptions): ZoomableViewer
}

interface OoxmlModule {
  DocxScrollViewer?: ViewerModule
  PptxScrollViewer?: ViewerModule
  XlsxViewer?: ViewerModule
}

let manifestPromise: Promise<WasmManifest> | null = null
const modulePromises = new Map<OfficeFormat, Promise<OoxmlModule>>()

function modulePath(format: OfficeFormat): string {
  return `${vendorBase()}/${format}.mjs`
}

function rawWasmName(format: OfficeFormat): string {
  return `${format}_parser_bg.wasm`
}

export function normalizeOfficeFormat(fileName: string): OfficeFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  return extension === 'docx' || extension === 'xlsx' || extension === 'pptx' ? extension : null
}

export function clampOfficeScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(4, Math.max(0.25, scale))
}

async function loadManifest(): Promise<WasmManifest> {
  if (!manifestPromise) {
    manifestPromise = import(/* @vite-ignore */ `${vendorBase()}/wasm-manifest.mjs`)
      .then((module) => (module.default ?? {}) as WasmManifest)
      .catch(() => ({}))
  }
  return manifestPromise
}

async function loadModule(format: OfficeFormat): Promise<OoxmlModule> {
  let promise = modulePromises.get(format)
  if (!promise) {
    promise = import(/* @vite-ignore */ modulePath(format)).catch((error: unknown) => {
      modulePromises.delete(format)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`加载 Silurus ${format.toUpperCase()} 模块失败: ${message}`)
    })
    modulePromises.set(format, promise)
  }
  return promise
}

function getViewerConstructor(format: OfficeFormat, module: OoxmlModule): ViewerModule {
  const Viewer = format === 'docx' ? module.DocxScrollViewer : format === 'pptx' ? module.PptxScrollViewer : module.XlsxViewer
  if (!Viewer) throw new Error(`Silurus 未提供 ${format.toUpperCase()} viewer`)
  return Viewer
}

export async function createOfficeViewer(
  format: OfficeFormat,
  container: HTMLElement,
  source: string,
  onScaleChange?: (scale: number) => void,
  onError?: (error: Error) => void,
): Promise<ZoomableViewer> {
  const [module, manifest] = await Promise.all([loadModule(format), loadManifest()])
  const Viewer = getViewerConstructor(format, module)
  const viewer = new Viewer(container, {
    wasmUrl: `${vendorBase()}/${manifest[format] ?? rawWasmName(format)}`,
    enableTextSelection: true,
    // XLSX 的原生 slider 支持连续 input；放宽范围以便精细查看大表或概览。
    ...(format === 'xlsx' ? { zoomMin: 0.1, zoomMax: 8 } : {}),
    onScaleChange,
    onError,
  })
  await viewer.load(source)
  return viewer
}

export function destroyOfficeViewer(viewer: ZoomableViewer | null): void {
  try {
    viewer?.destroy()
  } catch {
    // Viewer teardown is best effort; an already detached worker must not break unmount.
  }
}

export type OfficeViewerHandle = ZoomableViewer
