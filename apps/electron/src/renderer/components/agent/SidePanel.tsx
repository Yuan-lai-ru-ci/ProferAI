/**
 * SidePanel — Agent 侧面板容器
 *
 * 包含 Team Activity 和 File Browser 两个 Tab。
 * 面板可自动打开（检测到 Team/Task 活动或文件变化）
 * 或由用户手动切换。
 *
 * 切换按钮在面板关闭时显示活动指示点。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { PanelRight, X, Users, FolderOpen } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { FileBrowser } from '@/components/file-browser'
import { TeamActivityPanel } from './TeamActivityPanel'
import {
  agentSidePanelOpenAtom,
  agentSidePanelTabAtom,
  hasTeamActivityAtom,
  teamActivityCountAtom,
  workspaceFilesVersionAtom,
} from '@/atoms/agent-atoms'
import type { SidePanelTab } from '@/atoms/agent-atoms'

interface SidePanelProps {
  sessionId: string
  sessionPath: string | null
}

export function SidePanel({ sessionId, sessionPath }: SidePanelProps): React.ReactElement {
  const [isOpen, setIsOpen] = useAtom(agentSidePanelOpenAtom)
  const [activeTab, setActiveTab] = useAtom(agentSidePanelTabAtom)
  const hasTeamActivity = useAtomValue(hasTeamActivityAtom)
  const runningCount = useAtomValue(teamActivityCountAtom)
  const filesVersion = useAtomValue(workspaceFilesVersionAtom)
  const hasFileChanges = filesVersion > 0

  // 自动打开：文件变化时（仅在有 sessionPath 时）
  const prevFilesVersionRef = React.useRef(filesVersion)
  React.useEffect(() => {
    if (filesVersion > prevFilesVersionRef.current && sessionPath) {
      setIsOpen(true)
      // 仅在当前无 team 活动时切换到文件 tab
      if (!hasTeamActivity) {
        setActiveTab('files')
      }
    }
    prevFilesVersionRef.current = filesVersion
  }, [filesVersion, sessionPath, hasTeamActivity, setIsOpen, setActiveTab])

  // 面板是否可显示内容（需要有 sessionPath 或 team 活动）
  const hasContent = sessionPath || hasTeamActivity

  return (
    <div
      className={cn(
        'relative flex-shrink-0 transition-[width] duration-300 ease-in-out overflow-hidden titlebar-drag-region',
        hasContent && isOpen ? 'w-[320px] border-l' : 'w-10',
      )}
    >
      {/* 切换按钮 — 始终固定在右上角 */}
      {hasContent && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2.5 top-2.5 z-10 h-7 w-7 titlebar-no-drag"
              onClick={() => setIsOpen((prev) => !prev)}
            >
              <PanelRight
                className={cn(
                  'size-3.5 absolute transition-all duration-200',
                  isOpen ? 'opacity-0 rotate-90 scale-75' : 'opacity-100 rotate-0 scale-100',
                )}
              />
              <X
                className={cn(
                  'size-3.5 absolute transition-all duration-200',
                  isOpen ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-75',
                )}
              />
              {/* 活动指示点（面板关闭时显示） */}
              {!isOpen && (hasTeamActivity || hasFileChanges) && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary animate-pulse" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>{isOpen ? '关闭侧面板' : '打开侧面板'}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* 面板内容 */}
      {hasContent && (
        <div
          className={cn(
            'w-[320px] h-full flex flex-col transition-opacity duration-300 titlebar-no-drag',
            isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
        >
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as SidePanelTab)}
            className="flex flex-col h-full"
          >
            {/* Tab 切换栏 */}
            <div className="flex items-center gap-1 px-2 pr-10 h-[48px] border-b flex-shrink-0">
              <TabsList className="h-8 bg-muted/50">
                <TabsTrigger value="team" className="text-xs h-7 px-3 gap-1.5">
                  <Users className="size-3" />
                  Team
                  {runningCount > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-primary text-primary-foreground leading-none">
                      {runningCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="files" className="text-xs h-7 px-3 gap-1.5">
                  <FolderOpen className="size-3" />
                  文件
                  {hasFileChanges && (
                    <span className="ml-0.5 size-1.5 rounded-full bg-primary" />
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* Team Activity Tab */}
            <TabsContent value="team" className="flex-1 overflow-hidden m-0 data-[state=active]:flex data-[state=active]:flex-col">
              <TeamActivityPanel sessionId={sessionId} />
            </TabsContent>

            {/* File Browser Tab */}
            <TabsContent value="files" className="flex-1 overflow-hidden m-0 data-[state=active]:flex data-[state=active]:flex-col">
              {sessionPath ? (
                <FileBrowser rootPath={sessionPath} />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  请选择工作区
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  )
}
