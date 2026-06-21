/**
 * FilePreviewDialog — 文件内嵌预览弹窗
 *
 * 根据文件扩展名分派预览方式：
 * - 图片: base64 → ImageLightbox
 * - PDF: prepare-pdf-preview → HTML iframe
 * - Office: docx-to-html / office-to-html → HTML iframe
 * - 代码/文本: resolve-and-read → 代码查看器
 * - 其他: 文件信息 + 下载提示
 */

import * as React from 'react'
import { X, Download, ExternalLink, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FilePreviewDialogProps {
  open: boolean
  filePath: string
  fileName: string
  onClose: () => void
  /** 团队模式：预览前先下载到本地 */
  teamDownload?: () => Promise<string | null>
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'image'; src: string }
  | { status: 'html'; html: string }
  | { status: 'iframe'; src: string }
  | { status: 'text'; content: string; language: string }
  | { status: 'unsupported' }
  | { status: 'error'; message: string }

const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'csv', 'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'sql', 'graphql',
  'env', 'gitignore', 'dockerfile', 'log',
])

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

function ext(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function langFromExt(e: string): string {
  const map: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', sh: 'bash', bat: 'batch',
    sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    json: 'json', xml: 'xml', html: 'html', css: 'css',
    md: 'markdown', graphql: 'graphql',
  }
  return map[e] ?? e
}

export function FilePreviewDialog({ open, filePath, fileName, onClose, teamDownload }: FilePreviewDialogProps): React.ReactElement {
  const [state, setState] = React.useState<PreviewState>({ status: 'loading' })
  const [resolvedPath, setResolvedPath] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open || !filePath) return
    setState({ status: 'loading' })
    setResolvedPath(null)
    loadPreview()
  }, [open, filePath]) // eslint-disable-line

  const loadPreview = async (): Promise<void> => {
    const e = ext(fileName)
    try {
      let localPath = filePath
      // 团队模式：先下载到本地
      if (teamDownload) {
        const downloaded = await teamDownload()
        if (!downloaded) { setState({ status: 'error', message: '文件下载失败，请重试' }); return }
        localPath = downloaded
      }
      setResolvedPath(localPath)

      if (IMAGE_EXTS.has(e)) {
        const resolved = await window.electronAPI.resolveFilePath(localPath)
        if (resolved?.url) setState({ status: 'image', src: resolved.url })
        else setState({ status: 'error', message: '无法读取图片' })
      } else if (e === 'pdf') {
        const result = await window.electronAPI.preparePdfPreview(localPath)
        if (result?.tmpHtmlUrl) setState({ status: 'iframe', src: result.tmpHtmlUrl })
        else setState({ status: 'error', message: '无法预览 PDF' })
      } else if (e === 'docx') {
        const result = await window.electronAPI.docxToHtml(localPath)
        if (result?.html) setState({ status: 'html', html: result.html })
        else setState({ status: 'error', message: '无法预览文档' })
      } else if (['xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(e)) {
        const result = await window.electronAPI.officeToHtml(localPath)
        if (result?.html) setState({ status: 'html', html: result.html })
        else setState({ status: 'error', message: '无法预览文档' })
      } else if (TEXT_EXTS.has(e) || !e) {
        const result = await window.electronAPI.resolveAndReadFile(localPath)
        if (result?.content) setState({ status: 'text', content: result.content, language: langFromExt(e) })
        else setState({ status: 'error', message: '无法读取文件' })
      } else {
        setState({ status: 'unsupported' })
      }
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : '加载失败' })
    }
  }

  const handleOpenLocalFile = async (): Promise<void> => {
    let targetPath = resolvedPath ?? filePath
    if (!resolvedPath && teamDownload) {
      const downloaded = await teamDownload()
      if (!downloaded) {
        setState({ status: 'error', message: '文件下载失败，请重试' })
        return
      }
      targetPath = downloaded
      setResolvedPath(downloaded)
    }
    window.electronAPI.systemOpenFile(targetPath).catch(() => {})
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className={cn(
        'max-w-[calc(56rem-18px)] h-[calc(80vh-24px)] flex flex-col p-0 gap-0',
        state.status === 'image' && 'max-w-[calc(64rem-18px)] h-[calc(90vh-24px)]',
      )}>
        <DialogHeader className="flex flex-row items-center justify-between px-4 py-2 border-b flex-shrink-0">
          <DialogTitle className="text-sm font-medium truncate flex-1 mr-2">{fileName}</DialogTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7"
              onClick={() => { void handleOpenLocalFile() }}
              title="用默认应用打开">
              <ExternalLink className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="size-3.5" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto">
          {state.status === 'loading' && (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {state.status === 'image' && (
            <div className="flex items-center justify-center h-full bg-black/5">
              <img src={state.src} alt={fileName} className="max-w-full max-h-full object-contain" />
            </div>
          )}
          {state.status === 'html' && (
            <iframe srcDoc={state.html} className="w-full h-full border-0" sandbox="allow-scripts" />
          )}
          {state.status === 'iframe' && (
            <iframe src={state.src} className="w-full h-full border-0" />
          )}
          {state.status === 'text' && (
            <pre className="p-4 text-xs font-mono whitespace-pre-wrap overflow-auto h-full">
              <code>{state.content}</code>
            </pre>
          )}
          {state.status === 'unsupported' && (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <p className="text-sm">暂不支持预览此文件类型（.{ext(fileName)}）</p>
              <Button variant="outline" size="sm" onClick={() => { void handleOpenLocalFile() }}>
                <Download className="size-3.5 mr-1" />用默认应用打开
              </Button>
            </div>
          )}
          {state.status === 'error' && (
            <div className="flex items-center justify-center h-full text-sm text-destructive">
              {state.message}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
