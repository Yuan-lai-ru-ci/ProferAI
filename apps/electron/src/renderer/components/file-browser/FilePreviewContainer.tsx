/**
 * FilePreviewContainer — 全局文件预览入口
 *
 * 监听 window 'proma:file-preview' 事件，统一管理 FilePreviewDialog 生命周期。
 * 在 main.tsx 顶层挂载一次即可，不依赖组件树作用域。
 */

import * as React from 'react'
import { FilePreviewDialog } from './FilePreviewDialog'

interface PreviewEvent {
  path: string
  name: string
  download?: () => Promise<string | null>
}

export function FilePreviewContainer(): React.ReactElement {
  const [preview, setPreview] = React.useState<PreviewEvent | null>(null)

  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PreviewEvent>).detail
      setPreview(detail)
    }
    window.addEventListener('proma:file-preview', handler)
    return () => window.removeEventListener('proma:file-preview', handler)
  }, [])

  return (
    <FilePreviewDialog
      open={!!preview}
      filePath={preview?.path ?? ''}
      fileName={preview?.name ?? ''}
      onClose={() => setPreview(null)}
      teamDownload={preview?.download}
    />
  )
}
