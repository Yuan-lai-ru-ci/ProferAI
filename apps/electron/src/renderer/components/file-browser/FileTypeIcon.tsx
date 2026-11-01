/**
 * FileTypeIcon — 根据文件名/文件夹名渲染对应的 VS Code 风格图标
 *
 * 封装 @react-symbols/icons，统一尺寸和样式。
 *
 * 图标包是「文件名/扩展名 → 图标」的完整映射表（files + folders 约 540kB），
 * 静态 import 会把它整个钉进入口 chunk、冷启动就得多解析这坨数据。这里改成
 * 首次渲染时动态加载：加载完成前先画一个通用的文件/文件夹图标，到位后自动替换。
 * 数据在本地磁盘上，实际只有首帧可能看到通用图标。
 */

import * as React from 'react'
import { File as FileFallbackIcon, Folder as FolderFallbackIcon } from 'lucide-react'

type SymbolIconsModule = typeof import('@react-symbols/icons/utils')

let symbolIcons: SymbolIconsModule | null = null
let symbolIconsLoading: Promise<SymbolIconsModule | null> | null = null
const symbolIconsListeners = new Set<() => void>()

function loadSymbolIcons(): Promise<SymbolIconsModule | null> {
  if (symbolIcons) return Promise.resolve(symbolIcons)
  if (!symbolIconsLoading) {
    symbolIconsLoading = import('@react-symbols/icons/utils')
      .then((module) => {
        symbolIcons = module
        for (const listener of symbolIconsListeners) listener()
        return module
      })
      .catch(() => null)
  }
  return symbolIconsLoading
}

function subscribeSymbolIcons(listener: () => void): () => void {
  symbolIconsListeners.add(listener)
  return () => {
    symbolIconsListeners.delete(listener)
  }
}

function getSymbolIconsSnapshot(): SymbolIconsModule | null {
  return symbolIcons
}

function useSymbolIcons(): SymbolIconsModule | null {
  const icons = React.useSyncExternalStore(
    subscribeSymbolIcons,
    getSymbolIconsSnapshot,
    getSymbolIconsSnapshot,
  )
  React.useEffect(() => {
    void loadSymbolIcons()
  }, [])
  return icons
}

interface FileTypeIconProps {
  /** 文件名或文件夹名（如 "index.ts"、"node_modules"） */
  name: string
  /** 是否为目录 */
  isDirectory: boolean
  /** 目录是否展开（仅目录有效） */
  isOpen?: boolean
  /** 图标尺寸（像素），默认 16 */
  size?: number
  /** 额外 className */
  className?: string
}

export const FileTypeIcon = React.memo(function FileTypeIcon({
  name,
  isDirectory,
  size = 16,
  className,
}: FileTypeIconProps): React.ReactElement {
  const icons = useSymbolIcons()

  if (isDirectory) {
    return (
      <span className={className} style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icons ? (
          <icons.FolderIcon folderName={name} width={size} height={size} />
        ) : (
          <FolderFallbackIcon width={size} height={size} className="text-muted-foreground" />
        )}
      </span>
    )
  }

  return (
    <span className={className} style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {icons ? (
        <icons.FileIcon fileName={name} autoAssign width={size} height={size} />
      ) : (
        <FileFallbackIcon width={size} height={size} className="text-muted-foreground" />
      )}
    </span>
  )
})
