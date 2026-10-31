/**
 * AgentMemoryView — 「Agent 记忆」全屏视图
 *
 * 原先它是「Agent 技能」页的第四个 tab。记忆是工作区级的长期资料（项目规则、
 * 稳定偏好、已验证经验），和 Skills/MCP 的安装与启用不是同一类操作，
 * 因此拆成 rail 上的独立入口，进来就是记忆本身，不用先过一层能力管理页。
 *
 * 结构：
 * - 顶部：返回 + 标题 + 工作区切换
 * - 工具条：搜索（直接过滤记忆正文与文件列表）
 * - 内容：WorkspaceMemoryTab（记忆总览、生成、文件树与编辑器）
 */

import * as React from "react";
import { useSetAtom } from "jotai";
import { ArrowLeft, Brain, Search, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@profer/ui/primitives/tooltip";
import { activeViewAtom } from "@/atoms/active-view";
import { useProjectActions } from "@/hooks/useProjectActions";
import { WindowControlsHost } from "@/components/WindowControlsTemplate";
import { detectIsWindows } from "@profer/ui";
import { resolveWindowControlsRightInset } from "@/lib/window-controls-layout";
import { AgentWorkspaceSwitcher } from "./AgentWorkspaceSwitcher";
import { WorkspaceMemoryTab } from "./WorkspaceMemoryTab";

export function AgentMemoryView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom);
  const isWindows = React.useMemo(() => detectIsWindows(), []);
  const { workspaces, currentWorkspaceId, selectProject } = useProjectActions();
  const [search, setSearch] = React.useState("");

  const currentWorkspace = workspaces.find(
    (workspace) => workspace.id === currentWorkspaceId,
  );
  const workspaceSlug = currentWorkspace?.slug ?? "";
  const workspaceName = currentWorkspace?.name ?? "未选择工作区";

  // 切工作区后旧关键词会指向另一个工作区的正文，直接清掉，避免看起来“搜不到东西”。
  React.useEffect(() => {
    setSearch("");
  }, [currentWorkspaceId]);

  return (
    <div
      data-profer-navigation-region="agent-memory"
      tabIndex={-1}
      className="relative flex h-full flex-col overflow-hidden bg-content-area"
    >
      {/* 本页全屏取代 TabBar，窗口按钮必须由本页自己声明；拖拽层必须在按钮前结束，
          否则 Windows 高缩放会把单击判成标题栏点击。 */}
      <div
        className="absolute inset-x-0 top-0 z-0 h-14 titlebar-drag-region"
        style={{ right: resolveWindowControlsRightInset(isWindows) }}
        aria-hidden="true"
      />
      <WindowControlsHost
        id="agent-memory"
        priority={20}
        className="absolute right-2 top-[3px] z-20"
      />

      {/* 单行头部：返回 + 标题在左，搜索与工作区在右。
          记忆页的主体是文件内容本身，标题区不再占三行，也不写说明文案。 */}
      <div
        data-tour="agent-memory-header"
        className="titlebar-no-drag mx-auto mt-14 flex w-full max-w-6xl shrink-0 flex-wrap items-center gap-3 px-4 pb-3 sm:px-6 lg:px-8"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setActiveView("conversations")}
              className="flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="返回当前 Agent 会话"
            >
              <ArrowLeft size={14} />
              返回
            </button>
          </TooltipTrigger>
          <TooltipContent>返回当前 Agent 会话</TooltipContent>
        </Tooltip>
        <h1 className="shrink-0 text-[17px] font-semibold tracking-tight text-foreground">
          Agent 记忆
        </h1>

        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <div className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-2.5 transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 sm:w-[240px]">
            <Search size={13} className="shrink-0 text-foreground/40" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索记忆正文"
              aria-label="搜索记忆正文"
              data-agent-memory-search
              className="w-full bg-transparent text-[12.5px] text-foreground placeholder:text-foreground/35 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="清空搜索"
                className="shrink-0 rounded p-0.5 text-foreground/40 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {currentWorkspace && (
            <AgentWorkspaceSwitcher
              workspaces={workspaces}
              currentWorkspaceId={currentWorkspaceId}
              workspaceName={workspaceName}
              onSelect={(workspaceId) =>
                selectProject(workspaceId, { resetView: false })
              }
            />
          )}
        </div>
      </div>

      {/* 内容区直接撑满剩余高度：面板内部自己滚，页面不再整体滚动。 */}
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-4 pb-5 sm:px-6 lg:px-8">
        <div data-tour="agent-memory-panel" className="flex min-h-0 flex-1 flex-col">
          {workspaceSlug ? (
            <WorkspaceMemoryTab workspaceSlug={workspaceSlug} search={search} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl bg-foreground/[0.04] text-foreground/30">
                <Brain className="size-6" />
              </div>
              <div className="mt-1 text-[13px] font-medium text-foreground/70">
                未选择工作区
              </div>
              <div className="text-xs text-muted-foreground">
                先在 Agent 模式下选择或创建一个工作区。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
