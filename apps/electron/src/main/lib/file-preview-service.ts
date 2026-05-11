/**
 * 文件预览服务 — 内联预览支持
 *
 * 提供文件路径解析、PDF 预览 HTML 生成、DOCX 转 HTML 等功能，
 * 供 PreviewPanel 内联面板使用。
 */

import { basename, extname, join, dirname, resolve } from 'node:path'
import { readFileSync, statSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

/** 文件大小限制：50MB */
const MAX_FILE_SIZE = 50 * 1024 * 1024

/** 支持预览的图片扩展名 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

/** 支持预览的视频扩展名 */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov'])

/** 支持代码/纯文本预览的扩展名 */
const CODE_EXTENSIONS = new Set([
  '.json', '.jsonc', '.json5',
  '.xml', '.html', '.htm', '.svg',
  '.txt', '.log', '.csv',
  '.yaml', '.yml', '.toml', '.ini', '.env', '.lock',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish',
  '.css', '.scss', '.less',
  '.sql', '.rb', '.php',
  '.diff', '.patch',
])

/** 支持 Markdown 渲染预览的扩展名 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

/** 支持 PDF 预览的扩展名 */
const PDF_EXTENSIONS = new Set(['.pdf'])

/** 支持 DOCX 预览的扩展名 */
const DOCX_EXTENSIONS = new Set(['.docx'])

/**
 * 特殊文件名（无扩展名或扩展名不能代表语言）→ 高亮语言映射
 */
const SPECIAL_FILENAME_LANG: Record<string, string> = {
  '.gitignore': 'bash',
  '.dockerignore': 'bash',
  '.npmignore': 'bash',
  '.eslintignore': 'bash',
  '.prettierignore': 'bash',
  '.gitattributes': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  'dockerfile': 'dockerfile',
  'makefile': 'makefile',
  'bun.lock': 'yaml',
  'pnpm-lock.yaml': 'yaml',
  'cargo.lock': 'ini',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  'procfile': 'yaml',
}

/** 扩展名 → 语言 ID 映射 */
const EXT_LANG_MAP: Record<string, string> = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.xml': 'xml', '.html': 'html', '.htm': 'html', '.svg': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'ini', '.ini': 'ini', '.env': 'bash', '.lock': 'yaml',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.sql': 'sql', '.rb': 'ruby', '.php': 'php',
  '.diff': 'diff', '.patch': 'diff',
  '.txt': 'plaintext', '.log': 'plaintext', '.csv': 'plaintext',
}

/** 通用语言 ID */
function detectLanguage(filePath: string, ext: string): string {
  const base = basename(filePath).toLowerCase()
  if (isEnvFile(base)) return 'bash'
  if (SPECIAL_FILENAME_LANG[base]) return SPECIAL_FILENAME_LANG[base]
  return EXT_LANG_MAP[ext] || 'plaintext'
}

function isEnvFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower === '.env' || lower.startsWith('.env.')
}

/** 获取预览类型 */
function getPreviewType(filePath: string, ext: string): 'image' | 'video' | 'markdown' | 'code' | 'pdf' | 'docx' | 'unsupported' {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (DOCX_EXTENSIONS.has(ext)) return 'docx'
  const base = basename(filePath).toLowerCase()
  if (isEnvFile(base)) return 'code'
  if (SPECIAL_FILENAME_LANG[base]) return 'code'
  return 'unsupported'
}

// ─── 临时文件 ───

function getPreviewTmpDir(): string {
  const dir = join(tmpdir(), 'proma-preview')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function writeTempHtml(html: string): string {
  const tmpDir = getPreviewTmpDir()
  const tmpFile = join(tmpDir, `preview-${Date.now()}.html`)
  writeFileSync(tmpFile, html, 'utf-8')
  return tmpFile
}

// ─── 路径解析 ───

/**
 * 在目录中递归搜索指定文件名
 */
function searchFileInDir(dir: string, targetName: string, maxDepth = 8): string | null {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build', '.cache', 'target'])
  let scanned = 0
  const MAX_SCANNED = 500

  function walk(current: string, depth: number): string | null {
    if (depth > maxDepth || scanned > MAX_SCANNED) return null
    try {
      const entries = require('fs').readdirSync(current, { withFileTypes: true }) as import('fs').Dirent[]
      for (const entry of entries) {
        if (entry.isFile() && entry.name === targetName) {
          return join(current, entry.name)
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          scanned++
          const found = walk(join(current, entry.name), depth + 1)
          if (found) return found
        }
      }
    } catch { /* permission denied etc */ }
    return null
  }

  return walk(dir, 0)
}

/**
 * 解析待预览的文件路径
 * - 绝对路径：直接 resolve，不存在时 fallback 搜索
 * - 相对路径：依次尝试 basePaths，返回第一个存在的；都不存在则 fallback 搜索
 */
function resolveTargetPath(filePath: string, basePaths?: string[]): string {
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    const direct = resolve(filePath)
    if (existsSync(direct)) return direct
    const name = basename(direct)
    if (basePaths) {
      for (const base of basePaths) {
        if (!base) continue
        const found = searchFileInDir(base, name)
        if (found) return found
      }
    }
    const awIdx = filePath.indexOf('agent-workspaces')
    if (awIdx !== -1) {
      const wsRoot = filePath.slice(0, awIdx + 'agent-workspaces'.length)
      if (existsSync(wsRoot)) {
        const found = searchFileInDir(wsRoot, name)
        if (found) return found
      }
    }
    return direct
  }
  if (basePaths && basePaths.length > 0) {
    const firstSegment = filePath.split('/')[0]
    if (firstSegment) {
      for (const base of basePaths) {
        if (!base) continue
        if (basename(base) === firstSegment) {
          const candidate = resolve(dirname(base), filePath)
          if (existsSync(candidate)) return candidate
        }
      }
    }
    for (const base of basePaths) {
      if (!base) continue
      const candidate = resolve(base, filePath)
      if (existsSync(candidate)) return candidate
    }
    const home = homedir()
    const homeCandidate = resolve(home, filePath)
    if (existsSync(homeCandidate)) return homeCandidate
    const rootCandidate = resolve('/', filePath)
    if (existsSync(rootCandidate)) return rootCandidate
    const name = basename(filePath)
    for (const base of basePaths) {
      if (!base) continue
      const found = searchFileInDir(base, name)
      if (found) return found
    }
    return resolve(basePaths[0]!, filePath)
  }
  const homeCandidate = resolve(homedir(), filePath)
  if (existsSync(homeCandidate)) return homeCandidate
  const rootCandidate = resolve('/', filePath)
  if (existsSync(rootCandidate)) return rootCandidate
  return resolve(filePath)
}

// ─── 导出：内联预览 API ───

/** 解析文件路径并读取内容（供内联文本/代码预览使用） */
export function resolveAndReadFile(filePath: string, basePaths?: string[]): { resolvedPath: string; content: string } | null {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  try {
    const st = statSync(safePath)
    if (st.size > MAX_FILE_SIZE) return null
    const content = readFileSync(safePath, 'utf-8')
    return { resolvedPath: safePath, content }
  } catch {
    return null
  }
}

/** 仅解析文件路径（不读取内容），供图片等用 proma-file:// 协议加载的场景使用 */
export function resolveFilePath(filePath: string, basePaths?: string[]): string | null {
  const safePath = resolveTargetPath(filePath, basePaths)
  return existsSync(safePath) ? safePath : null
}

/** 为内联 PDF 预览生成临时 HTML 文件（使用 proma-file:// 加载 PDF，无体积膨胀） */
export function preparePdfPreview(filePath: string, basePaths?: string[]): { resolvedPath: string; tmpHtmlPath: string } | null {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  const st = statSync(safePath)
  if (st.size > MAX_FILE_SIZE) return null
  const fileUrl = `proma-file://${encodeURI(safePath).replace(/#/g, '%23')}`
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: auto; padding: 16px; }
  #c { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; width: fit-content; min-width: 100%; }
  #c canvas { box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin: 0 auto; display: block; }
  .loading { color: #888; font: 12px/1.5 system-ui; padding: 40px; text-align: center; width: 100%; }
  .error { color: #f87171; font: 12px/1.5 system-ui; padding: 20px; text-align: center; width: 100%; }
  .page-info { color: #888; font: 11px/1.5 system-ui; text-align: center; padding: 4px; width: 100%; }
</style>
</head><body>
  <div class="loading" id="c">正在加载 PDF...</div>
  <script type="module">
    const container = document.getElementById('c');
    const fileUrl = ${JSON.stringify(fileUrl)};
    const STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    let stepIdx = 2;
    let pdfDoc = null;

    function notifyZoom() {
      window.parent.postMessage({ type: 'pdf-zoom-changed', zoom: Math.round(STEPS[stepIdx] * 100) }, '*');
    }

    async function renderAll() {
      if (!pdfDoc) return;
      container.innerHTML = '';
      const userScale = STEPS[stepIdx];
      const dpr = window.devicePixelRatio || 1;
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const vp = page.getViewport({ scale: userScale * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = (vp.width / dpr) + 'px';
        canvas.style.height = (vp.height / dpr) + 'px';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        container.appendChild(canvas);
      }
      const info = document.createElement('div');
      info.className = 'page-info';
      info.textContent = '共 ' + pdfDoc.numPages + ' 页';
      container.appendChild(info);
      notifyZoom();
    }

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'pdf-zoom') {
        if (e.data.direction === 'in' && stepIdx < STEPS.length - 1) { stepIdx++; renderAll(); }
        if (e.data.direction === 'out' && stepIdx > 0) { stepIdx--; renderAll(); }
      }
    });

    try {
      const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';
      pdfDoc = await pdfjsLib.getDocument({
        url: fileUrl,
        standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/standard_fonts/',
      }).promise;
      await renderAll();
    } catch (err) {
      container.innerHTML = '<div class="error">PDF 加载失败: ' + err.message + '<\\/div>';
    }
  <\/script>
<\/body><\/html>`
  const tmpHtmlPath = writeTempHtml(html)
  return { resolvedPath: safePath, tmpHtmlPath }
}

/** 将 DOCX 文件转换为 HTML（供内联预览使用） */
export async function convertDocxToHtml(filePath: string, basePaths?: string[]): Promise<{ resolvedPath: string; html: string } | null> {
  const safePath = resolveTargetPath(filePath, basePaths)
  if (!existsSync(safePath)) return null
  try {
    const st = statSync(safePath)
    if (st.size > MAX_FILE_SIZE) return null
    const mammoth = await import('mammoth')
    const result = await mammoth.convertToHtml({ path: safePath })
    return { resolvedPath: safePath, html: result.value }
  } catch (err) {
    console.error('[file-preview] convertDocxToHtml failed:', err)
    return null
  }
}
