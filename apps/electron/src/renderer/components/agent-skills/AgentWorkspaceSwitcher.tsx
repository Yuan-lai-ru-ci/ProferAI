/**
 * AgentWorkspaceSwitcher — 「Agent 技能」「Agent 记忆」共用的工作区切换下拉。
 *
 * 两个全屏视图都以工作区为作用域（Skills/MCP 装在工作区里，记忆也是工作区级资料），
 * 头部的工作区按钮必须长得一样、切换行为也一致：切换后停留在当前视图（resetView:false），
 * 由调用方决定是否收起全局配置等视图内状态。
 */

import * as React from "react";
import { Check, ChevronDown, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@profer/ui/primitives/popover";
import type { AgentWorkspace } from "@profer/shared";

interface AgentWorkspaceSwitcherProps {
  workspaces: AgentWorkspace[];
  currentWorkspaceId: string | null;
  workspaceName: string;
  /** 选中工作区后回调；相同工作区不会触发 toast */
  onSelect: (workspaceId: string) => void;
}

export function AgentWorkspaceSwitcher({
  workspaces,
  currentWorkspaceId,
  workspaceName,
  onSelect,
}: AgentWorkspaceSwitcherProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`切换工作区，当前为${workspaceName}`}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-border/60 bg-content-area px-3 py-1.5 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.04]"
        >
          <FolderOpen size={14} className="text-foreground/45" />
          <span className="max-w-[180px] truncate">{workspaceName}</span>
          <ChevronDown size={14} className="text-foreground/45" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[320px] w-56 overflow-y-auto scrollbar-thin p-1"
      >
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => {
              setOpen(false);
              if (workspace.id === currentWorkspaceId) return;
              onSelect(workspace.id);
              toast.success(`已切换到工作区「${workspace.name}」`);
            }}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
              workspace.id === currentWorkspaceId
                ? "bg-accent text-accent-foreground"
                : "text-foreground/80 hover:bg-accent/50",
            )}
          >
            <span className="truncate">{workspace.name}</span>
            {workspace.id === currentWorkspaceId && (
              <Check size={14} className="shrink-0 text-primary" />
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
