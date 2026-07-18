/**
 * 论文知识库导入对话框
 *
 * 支持两种导入方式：
 * 1. 本地 PDF — 文件选择器
 * 2. arXiv — 搜索并选择导入
 *
 * 样式对齐 Profer 现有 Dialog 规范。
 */

import React, { useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { Search, FileUp, Loader2, Globe, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ArxivPaper } from '@profer/shared'

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportComplete: () => void
}

export function ImportDialog({ open, onOpenChange, onImportComplete }: ImportDialogProps) {
  const [arxivQuery, setArxivQuery] = useState('')
  const [arxivResults, setArxivResults] = useState<ArxivPaper[]>([])
  const [isSearchingArxiv, setIsSearchingArxiv] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleArxivSearch = async () => {
    if (!arxivQuery.trim()) return
    setIsSearchingArxiv(true)
    try {
      const results = await window.electronAPI.kb.searchArxiv(arxivQuery.trim(), 10)
      setArxivResults(results)
      if (results.length === 0) {
        toast.info('未找到匹配的论文')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'arXiv 搜索失败'
      console.error('[KB] arXiv 搜索失败:', err)
      toast.error(msg)
    } finally {
      setIsSearchingArxiv(false)
    }
  }

  const handleArxivImport = async (arxivId: string) => {
    setImportingId(arxivId)
    try {
      await window.electronAPI.kb.import({ source: { type: 'arxiv', arxivId } })
      toast.success('论文导入成功')
      onImportComplete()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '导入失败'
      console.error('[KB] arXiv 导入失败:', err)
      toast.error(msg)
    } finally {
      setImportingId(null)
    }
  }

  const doLocalImport = useCallback(async (filePath: string) => {
    const fileName = filePath.split(/[/\\]/).pop() || ''
    setImportingId('__local__')
    try {
      await window.electronAPI.kb.import({ source: { type: 'file', filePath } })
      toast.success(`「${fileName}」导入成功`)
      onImportComplete()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '导入失败'
      console.error('[KB] 本地 PDF 导入失败:', err)
      toast.error(msg)
    } finally {
      setImportingId(null)
    }
  }, [onImportComplete])

  // 文件选择按钮
  const handleFilePicker = () => {
    fileInputRef.current?.click()
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const filePath = window.electronAPI.getPathForFile(file)
    if (filePath) doLocalImport(filePath)
    // 重置 input 以便重复选同一文件
    e.target.value = ''
  }

  // 拖拽处理
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // 只在真正离开拖拽区域时才取消高亮，而非进入子元素时误触发
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const file = e.dataTransfer.files?.[0]
    if (!file) return

    // 仅接受 PDF
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('仅支持 PDF 文件')
      return
    }

    const filePath = window.electronAPI.getPathForFile(file)
    if (filePath) doLocalImport(filePath)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>导入论文到论文知识库</DialogTitle>
          <DialogDescription>
            支持 arXiv 论文导入。论文将通过 MinerU 解析为结构化 Markdown，自动分块并生成索引。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="arxiv" className="flex-1 flex flex-col min-h-0">
          <TabsList className="w-full">
            <TabsTrigger value="arxiv" className="flex-1">
              <Globe className="size-4 mr-1.5" />
              arXiv 导入
            </TabsTrigger>
            <TabsTrigger value="local" className="flex-1">
              <FileUp className="size-4 mr-1.5" />
              本地 PDF
            </TabsTrigger>
          </TabsList>

          {/* arXiv Tab */}
          <TabsContent value="arxiv" className="flex-1 flex flex-col min-h-0 mt-3">
            <div className="flex gap-2">
              <div className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-3 transition-colors focus-within:border-primary/40">
                <Search className="size-3.5 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  placeholder="搜索 arXiv 论文（如 attention is all you need）"
                  value={arxivQuery}
                  onChange={(e) => setArxivQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleArxivSearch()}
                  className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleArxivSearch}
                disabled={isSearchingArxiv || !arxivQuery.trim()}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                {isSearchingArxiv ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
                搜索
              </button>
            </div>

            <ScrollArea className="flex-1 mt-3 min-h-[180px]">
              {arxivResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2 min-h-[160px]">
                  <Globe className="size-8 opacity-30" />
                  <p className="text-sm">输入关键词搜索 arXiv 论文</p>
                </div>
              ) : (
                <div className="space-y-2 pr-1">
                  {arxivResults.map((paper) => (
                    <div
                      key={paper.arxivId}
                      className="flex items-start gap-3 p-3 rounded-lg border border-border/60 hover:border-primary/30 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium line-clamp-2 text-foreground/85">
                          {paper.title}
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          {paper.authors.slice(0, 3).join(', ')}
                          {paper.authors.length > 3 && ' 等'}
                          {' · '}
                          {paper.year}
                          {paper.primaryCategory ? ` · ${paper.primaryCategory}` : ''}
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                          {paper.abstract.slice(0, 300)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleArxivImport(paper.arxivId)}
                        disabled={importingId === paper.arxivId}
                        className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-40"
                      >
                        {importingId === paper.arxivId ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : null}
                        导入
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Local PDF Tab */}
          <TabsContent value="local" className="flex-1 flex flex-col min-h-0 mt-3">
            {/* 隐藏文件选择器 */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={handleFileInputChange}
            />

            <div
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-colors cursor-pointer min-h-[160px]',
                isDragging
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/60 hover:border-border/80 hover:bg-accent/20',
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleFilePicker}
            >
              {importingId === '__local__' ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="size-8 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">正在解析导入...</p>
                  <p className="text-xs text-muted-foreground/60">PDF 较大时可能需要 1-2 分钟</p>
                </div>
              ) : (
                <>
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/40">
                    <FileUp className="size-6 text-muted-foreground" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">
                      拖拽 PDF 到此处或点击选择文件
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      PDF 将通过 MinerU 解析为结构化 Markdown，自动分块并建立索引
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleFilePicker() }}
                    className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
                  >
                    <FileUp className="size-3.5" />
                    选择 PDF 文件
                  </button>
                </>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
