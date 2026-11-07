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
import { Brain } from "lucide-react";
import { activeViewAtom } from "@/atoms/active-view";
import { useProjectActions } from "@/hooks/useProjectActions";
import {
  FullScreenView,
  ViewBody,
  ViewHeader,
  ViewSearchField,
} from "@/components/app-shell/FullScreenView";
import { AgentWorkspaceSwitcher } from "./AgentWorkspaceSwitcher";
import { WorkspaceMemoryTab } from "./WorkspaceMemoryTab";

export function AgentMemoryView(): React.ReactElement {
  const setActiveView = useSetAtom(activeViewAtom);
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
    <FullScreenView region="agent-memory" controlsId="agent-memory">
      <ViewHeader
        width="standard"
        tourId="agent-memory-header"
        title="Agent 记忆"
        subtitle="当前工作区的长期资料：规则、偏好与已验证经验"
        back={{
          label: "返回当前 Agent 会话",
          onClick: () => setActiveView("conversations"),
        }}
        actions={
          <>
            <ViewSearchField
              value={search}
              onChange={setSearch}
              placeholder="搜索记忆正文"
              label="搜索记忆正文"
              searchId="agent-memory"
            />
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
          </>
        }
      />

      {/* 内容区直接撑满剩余高度：面板内部自己滚，页面不再整体滚动。 */}
      <ViewBody width="standard" className="pb-5">
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
      </ViewBody>
    </FullScreenView>
  );
}
