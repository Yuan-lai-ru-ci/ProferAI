/**
 * AgentSkillsView — 「Agent 技能」全屏视图
 *
 * 由侧边栏「Agent 技能」入口触发，全屏占据中间内容区（隐藏 TabBar 与右侧文件面板）。
 *
 * 结构：
 * - 顶部：标题 + 工作区切换下拉（AgentWorkspaceSwitcher，与 Agent 记忆共用）
 * - 工具条：Skills / MCP / 预设切换 + 搜索 + 新增入口
 * - 内容：能力卡片网格（商店风），点击卡片打开右侧详情抽屉
 *
 * 工作区记忆已拆成独立的「Agent 记忆」视图（AgentMemoryView），不在这里。
 */

import * as React from "react";
import { useSetAtom, useAtomValue } from "jotai";
import { toast } from "sonner";
import { Blocks, Search, Plus, Globe2 } from "lucide-react";
import { Button } from "@profer/ui/primitives/button";
import { ConfirmDialog } from "@profer/ui/primitives/confirm-dialog";
import { activeViewAtom } from "@/atoms/active-view";
import { workspaceCapabilitiesVersionAtom } from "@/atoms/agent-atoms";
import { workspacePresetsAtom } from "@/atoms/agent-preset-atoms";
import { useProjectActions } from "@/hooks/useProjectActions";
import {
  FullScreenView,
  ViewBody,
  ViewHeader,
  ViewToolbar,
} from "@/components/app-shell/FullScreenView";
import type { McpServerEntry, SkillMeta } from "@profer/shared";
import { useAgentSkillsData } from "./useAgentSkillsData";
import { SkillCard } from "./SkillCard";
import { McpCard } from "./McpCard";
import { SkillDetailSheet } from "./SkillDetailSheet";
import { McpDetailSheet } from "./McpDetailSheet";
import { ImportSkillDialog } from "./ImportSkillDialog";
import { AgentWorkspaceSwitcher } from "./AgentWorkspaceSwitcher";
import { AgentPresetSettings } from "./AgentPresetSettings";
import { ImportPresetDialog } from "./ImportPresetDialog";
import { GlobalCapabilitiesView } from "./GlobalCapabilitiesView";
import { MasterSkillDetailSheet } from "./MasterSkillDetailSheet";
import { CreateWorkspaceSkillDialog } from "./CreateWorkspaceSkillDialog";
import { WorkspaceScopeSelectDialog } from "./WorkspaceScopeSelectDialog";
import { AgentSkillsToolbar } from "./AgentSkillsToolbar";
import {
  isBuiltinReferenceSkill,
  isWorkspaceLocalSkill,
  skillDirectoryPath,
  skillListKey,
  skillToggleSourceId,
  partitionSkills,
} from "./skillListSections";

type CapabilityTab = "skills" | "mcp" | "presets";

export function AgentSkillsView(): React.ReactElement {
  const data = useAgentSkillsData();
  const setActiveView = useSetAtom(activeViewAtom);
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom);
  const presetList = useAtomValue(workspacePresetsAtom(data.workspaceSlug));
  const { workspaces, currentWorkspaceId, selectProject } = useProjectActions();

  const [tab, setTab] = React.useState<CapabilityTab>("skills");
  const [search, setSearch] = React.useState("");
  const [selectedSkillKey, setSelectedSkillKey] = React.useState<string | null>(
    null,
  );
  const [mcpSheetOpen, setMcpSheetOpen] = React.useState(false);
  const [editingMcp, setEditingMcp] = React.useState<{
    name: string;
    entry: McpServerEntry;
  } | null>(null);
  const [showImport, setShowImport] = React.useState(false);
  const [globalConfigOpen, setGlobalConfigOpen] = React.useState(false);
  const [globalConfigTab, setGlobalConfigTab] = React.useState<
    "skills" | "presets"
  >("skills");
  const [globalCreateSkillToken, setGlobalCreateSkillToken] = React.useState(0);
  const [globalImportSkillToken, setGlobalImportSkillToken] = React.useState(0);
  const [globalCreatePresetToken, setGlobalCreatePresetToken] =
    React.useState(0);
  const [workspaceCreatePresetToken, setWorkspaceCreatePresetToken] =
    React.useState(0);
  const [workspaceImportPresetFileToken, setWorkspaceImportPresetFileToken] =
    React.useState(0);
  const [workspaceExportPresetToken, setWorkspaceExportPresetToken] =
    React.useState(0);
  const [pendingDeleteSkill, setPendingDeleteSkill] =
    React.useState<SkillMeta | null>(null);
  const [pendingDeleteMcpName, setPendingDeleteMcpName] = React.useState<
    string | null
  >(null);
  const [isDeletingSkill, setIsDeletingSkill] = React.useState(false);
  const [isDeletingMcp, setIsDeletingMcp] = React.useState(false);
  const [showImportPreset, setShowImportPreset] = React.useState(false);
  const [createWorkspaceSkillOpen, setCreateWorkspaceSkillOpen] =
    React.useState(false);
  const [promoteSkill, setPromoteSkill] = React.useState<SkillMeta | null>(
    null,
  );
  const [promotePreset, setPromotePreset] = React.useState<
    import("@profer/shared").AgentPreset | null
  >(null);

  const q = search.trim().toLowerCase();

  const filteredSkills = React.useMemo(() => {
    if (!q) return data.skills;
    return data.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [data.skills, q]);

  // 分区按身份（workspaceSkillId）而非 actualSource：已关闭的副本在 skills-inactive/
  // 重新扫描后 actualSource 为 none，按加载层过滤会让它从列表里彻底消失。
  const { workspaceSkills, globalSkills, builtinSkills } =
    partitionSkills(filteredSkills);
  const updateCount = data.skills.filter(
    (s) => s.hasUpdate && isWorkspaceLocalSkill(s),
  ).length;

  const serverEntries = React.useMemo(() => {
    return Object.entries(data.mcpConfig.servers ?? {})
      .filter(([name]) => name !== "memos-cloud")
      .filter(([name]) => !q || name.toLowerCase().includes(q));
  }, [data.mcpConfig, q]);

  // 不含搜索过滤的 MCP 总数（标签计数与空态判断用）
  const mcpCount = React.useMemo(
    () =>
      Object.keys(data.mcpConfig.servers ?? {}).filter(
        (n) => n !== "memos-cloud",
      ).length,
    [data.mcpConfig],
  );

  // 顶部 Skills/MCP/预设切换按钮：支持 ←/→ 循环切换 + Home/End。
  // 记忆已拆成 rail 上的独立「Agent 记忆」视图，不再作为本页标签。
  const tabButtonRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const tabList: Array<{ value: CapabilityTab; label: string; count: number }> =
    [
      { value: "skills", label: "Skills", count: data.skills.length },
      { value: "mcp", label: "MCP", count: mcpCount },
      { value: "presets", label: "预设", count: presetList.length },
    ];
  const handleTabKeyDown = React.useCallback(
    (
      event: React.KeyboardEvent<HTMLButtonElement>,
      currentIndex: number,
    ): void => {
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight")
        nextIndex = (currentIndex + 1) % tabList.length;
      else if (event.key === "ArrowLeft")
        nextIndex = (currentIndex - 1 + tabList.length) % tabList.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabList.length - 1;
      if (nextIndex === undefined) return;
      const next = tabList[nextIndex];
      if (!next) return;
      event.preventDefault();
      setTab(next.value);
      tabButtonRefs.current[nextIndex]?.focus();
    },
    [setTab, tabList],
  );

  const skillKey = skillListKey;
  const selectedSkill =
    data.skills.find((s) => skillKey(s) === selectedSkillKey) ?? null;
  // workspaceSkillId 标识工作区副本（含已关闭的）；actualSource 只表示当前实际加载层，
  // 不能用来判断一个条目是不是全局定义。
  const selectedIsGlobal = Boolean(
    selectedSkill && skillKey(selectedSkill).startsWith("global:"),
  );
  const selectedIsBuiltin =
    selectedIsGlobal && selectedSkill?.sourceSkillType === "builtin-meta";

  const openSkillFolder = (skill: SkillMeta): void => {
    const target = skillDirectoryPath(skill, data.skillsDir);
    if (target) window.electronAPI.openFile(target);
  };

  if (!data.hasWorkspace && !globalConfigOpen) {
    return (
      <FullScreenView region="agent-skills" controlsId="agent-skills">
        <ViewBody width="standard" className="items-center justify-center gap-3 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-foreground/[0.04]">
            <Blocks className="size-8 text-foreground/30" />
          </div>
          <div className="text-[15px] font-medium text-foreground/80">
            未选择工作区
          </div>
          <div className="max-w-sm text-[13px] text-foreground/50">
            请先在 Agent 模式下选择或创建一个工作区，再来管理它的 Skills 与 MCP。
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => setGlobalConfigOpen(true)}
            className="mt-1 h-8 gap-1.5 px-3 text-[13px] font-medium"
          >
            <Globe2 size={15} />
            管理全局配置
          </Button>
        </ViewBody>
      </FullScreenView>
    );
  }

  return (
    <FullScreenView region="agent-skills" controlsId="agent-skills">
      <ViewHeader
        width="standard"
        tourId="agent-skills-header"
        title={globalConfigOpen ? "Agent 技能 · 全局" : "Agent 技能"}
        subtitle={
          globalConfigOpen
            ? "管理跨工作区生效的 Skills 与预设"
            : "管理当前工作区的 Skills、预设与其他 Agent 能力"
        }
        back={{
          label: "返回当前 Agent 会话",
          onClick: () => setActiveView("conversations"),
        }}
        actions={
          <>
            {!globalConfigOpen && (
              <AgentWorkspaceSwitcher
                workspaces={workspaces}
                currentWorkspaceId={currentWorkspaceId}
                workspaceName={data.workspaceName}
                onSelect={(workspaceId) => {
                  setGlobalConfigOpen(false);
                  selectProject(workspaceId, { resetView: false });
                }}
              />
            )}
            <Button
              type="button"
              size="sm"
              variant={globalConfigOpen ? "default" : "outline"}
              aria-pressed={globalConfigOpen}
              onClick={() => setGlobalConfigOpen((open) => !open)}
              className="h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium"
            >
              <Globe2 size={15} />
              全局配置
            </Button>
          </>
        }
      />

      <ViewToolbar width="standard">
          <AgentSkillsToolbar
          scope={globalConfigOpen ? "global" : "workspace"}
          domain={globalConfigOpen ? globalConfigTab : tab}
          tabs={
            globalConfigOpen
              ? [
                  { value: "skills", label: "全局 Skill" },
                  { value: "presets", label: "全局预设" },
                ]
              : tabList
          }
          search={search}
          searchPlaceholder={
            globalConfigOpen
              ? globalConfigTab === "skills"
                ? "搜索全局 Skills…"
                : "搜索全局预设…"
              : tab === "skills"
                ? "搜索 Skills..."
                : tab === "mcp"
                  ? "搜索 MCP 服务器..."
                  : "搜索预设..."
          }
          onDomainChange={(value) => {
            if (globalConfigOpen)
              setGlobalConfigTab(value === "presets" ? "presets" : "skills");
            else setTab(value as CapabilityTab);
          }}
          onSearchChange={setSearch}
          onCreate={
            globalConfigOpen
              ? () => {
                  if (globalConfigTab === "skills")
                    setGlobalCreateSkillToken((value) => value + 1);
                  else setGlobalCreatePresetToken((value) => value + 1);
                }
              : tab === "skills"
                ? () => setCreateWorkspaceSkillOpen(true)
                : tab === "presets"
                  ? () => setWorkspaceCreatePresetToken((value) => value + 1)
                  : tab === "mcp"
                    ? () => {
                        setEditingMcp(null);
                        setMcpSheetOpen(true);
                      }
                    : undefined
          }
          onImport={
            globalConfigOpen
              ? globalConfigTab === "skills"
                ? () => setGlobalImportSkillToken((value) => value + 1)
                : undefined
              : tab === "skills"
                ? () => setShowImport(true)
                : tab === "presets"
                  ? () => setShowImportPreset(true)
                  : undefined
          }
          importLabel="导入"
          onSecondaryImport={
            !globalConfigOpen && tab === "presets"
              ? () => setWorkspaceImportPresetFileToken((value) => value + 1)
              : undefined
          }
          secondaryImportLabel="从文件导入"
          onExport={
            !globalConfigOpen && tab === "presets"
              ? () => setWorkspaceExportPresetToken((value) => value + 1)
              : undefined
          }
        />
      </ViewToolbar>

      {/* 内容 */}
      <ViewBody width="standard" scroll>
        <div data-tour="agent-skills-panel" className="w-full">
          {globalConfigOpen ? (
            <GlobalCapabilitiesView
              initialTab={globalConfigTab}
              workspaceSlug={data.workspaceSlug}
              search={search}
              createSkillRequestToken={globalCreateSkillToken}
              importSkillRequestToken={globalImportSkillToken}
              createPresetRequestToken={globalCreatePresetToken}
            />
          ) : tab === "presets" ? (
            <AgentPresetSettings
              workspaceSlug={data.workspaceSlug}
              search={search}
              hideToolbar
              createRequestToken={workspaceCreatePresetToken}
              importFileRequestToken={workspaceImportPresetFileToken}
              exportRequestToken={workspaceExportPresetToken}
              onPromote={setPromotePreset}
              onOpenGlobalConfig={() => {
                setGlobalConfigTab("presets");
                setGlobalConfigOpen(true);
              }}
            />
          ) : data.loading ? (
            <div className="py-20 text-center text-sm text-muted-foreground">
              加载中...
            </div>
          ) : tab === "skills" ? (
            <SkillsTab
              workspaceSkills={workspaceSkills}
              globalSkills={globalSkills}
              builtinSkills={builtinSkills}
              total={data.skills.length}
              updateCount={updateCount}
              updatingSkill={data.updatingSkill}
              isBuiltin={() => false}
              onOpen={(skill) => setSelectedSkillKey(skillKey(skill))}
              onToggle={data.toggleSkill}
              onUpdate={data.updateSkill}
              onPromote={(skill) => setPromoteSkill(skill)}
            />
          ) : (
            <McpTab
              entries={serverEntries}
              total={mcpCount}
              onOpen={(name, entry) => {
                setEditingMcp({ name, entry });
                setMcpSheetOpen(true);
              }}
              onToggle={data.toggleMcp}
              onRequestDelete={setPendingDeleteMcpName}
              onAdd={() => {
                setEditingMcp(null);
                setMcpSheetOpen(true);
              }}
            />
          )}
        </div>
      </ViewBody>

      {/* 详情抽屉 */}
      {selectedIsGlobal ? (
        <MasterSkillDetailSheet
          skill={
            selectedSkill
              ? {
                  schemaVersion: 1,
                  skillId: selectedSkill.sourceSkillId ?? selectedSkill.slug,
                  slug: selectedSkill.slug,
                  type: selectedSkill.sourceSkillType ?? "user-global",
                  version: selectedSkill.version ?? "1.0.0",
                  name: selectedSkill.name,
                  description: selectedSkill.description,
                  createdAt: "",
                  updatedAt: "",
                  enabledInWorkspace: selectedSkill.enabled,
                  replacedInWorkspace: false,
                  sourceStatus: "available",
                  actualSource: "global",
                }
              : null
          }
          workspaceSlug={data.workspaceSlug}
          onOpenChange={(open) => {
            if (!open) setSelectedSkillKey(null);
          }}
          onChanged={() => bumpCapabilities((v) => v + 1)}
          readOnlyGlobal
          onCopyToWorkspace={async (skillId) => {
            await window.electronAPI.globalSkill.copyToWorkspace(
              skillId,
              data.workspaceSlug,
            );
            bumpCapabilities((v) => v + 1);
            toast.success("已在当前工作区创建副本");
          }}
          onOpenGlobalConfig={() => {
            setGlobalConfigTab("skills");
            setGlobalConfigOpen(true);
          }}
        />
      ) : (
        <SkillDetailSheet
          skill={selectedSkill}
          workspaceSlug={data.workspaceSlug}
          isBuiltin={selectedIsBuiltin}
          updating={data.updatingSkill === selectedSkill?.slug}
          onOpenChange={(open) => {
            if (!open) setSelectedSkillKey(null);
          }}
          onToggle={(enabled) =>
            selectedSkill &&
            data.toggleSkill(
              selectedSkill.slug,
              enabled,
              skillToggleSourceId(selectedSkill),
            )
          }
          onUpdate={() => selectedSkill && data.updateSkill(selectedSkill.slug)}
          onRequestDelete={() =>
            selectedSkill && setPendingDeleteSkill(selectedSkill)
          }
          onOpenFolder={() => selectedSkill && openSkillFolder(selectedSkill)}
          onChanged={() => bumpCapabilities((v) => v + 1)}
        />
      )}

      {/* Skill 删除确认 */}
      <ConfirmDialog
        open={pendingDeleteSkill !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteSkill(null);
        }}
        title={`确认删除 Skill「${pendingDeleteSkill?.name}」？`}
        description="删除后将无法恢复，确定要卸载这个 Skill 吗？"
        confirmLabel="删除"
        loadingLabel="删除中..."
        loading={isDeletingSkill}
        onConfirm={async () => {
          if (!pendingDeleteSkill || isDeletingSkill) return;
          setIsDeletingSkill(true);
          const ok = await data.deleteSkill(
            pendingDeleteSkill.slug,
            pendingDeleteSkill.name,
            pendingDeleteSkill.workspaceSkillId,
          );
          setIsDeletingSkill(false);
          setPendingDeleteSkill(null);
          if (ok) setSelectedSkillKey(null);
        }}
      />

      {/* MCP 删除确认 */}
      <ConfirmDialog
        open={pendingDeleteMcpName !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteMcpName(null);
        }}
        title={`确认删除 MCP 服务器「${pendingDeleteMcpName}」？`}
        description="删除后将无法恢复，确定要删除这个 MCP 服务器吗？"
        confirmLabel="删除"
        loadingLabel="删除中..."
        loading={isDeletingMcp}
        onConfirm={async () => {
          if (!pendingDeleteMcpName || isDeletingMcp) return;
          setIsDeletingMcp(true);
          await data.deleteMcp(pendingDeleteMcpName);
          setIsDeletingMcp(false);
          setPendingDeleteMcpName(null);
        }}
      />

      <McpDetailSheet
        open={mcpSheetOpen}
        server={editingMcp}
        workspaceSlug={data.workspaceSlug}
        onOpenChange={(open) => {
          setMcpSheetOpen(open);
          if (!open) bumpCapabilities((v) => v + 1);
        }}
        onSaved={() => setMcpSheetOpen(false)}
        onChanged={() => bumpCapabilities((v) => v + 1)}
      />

      <ImportSkillDialog
        open={showImport}
        onOpenChange={setShowImport}
        workspaceSlug={data.workspaceSlug}
        installedSkills={data.skills}
        onImported={() => bumpCapabilities((v) => v + 1)}
      />

      <CreateWorkspaceSkillDialog
        open={createWorkspaceSkillOpen}
        onOpenChange={setCreateWorkspaceSkillOpen}
        workspaceSlug={data.workspaceSlug}
        onCreated={() => bumpCapabilities((v) => v + 1)}
      />
      <WorkspaceScopeSelectDialog
        open={promoteSkill !== null}
        title={`提升「${promoteSkill?.name ?? ""}」为全局 Skill`}
        description="选择该全局 Skill 要在哪些工作区生效；下一步选择是否保留原工作区 Skill。"
        workspaces={workspaces.filter((workspace) => !workspace.isDeleted)}
        initialWorkspaceSlug={data.workspaceSlug}
        onOpenChange={(open) => {
          if (!open) setPromoteSkill(null);
        }}
        onConfirm={async (targets, keepWorkspaceCopy) => {
          if (!promoteSkill) return;
          await window.electronAPI.promoteWorkspaceSkillToGlobal(
            data.workspaceSlug,
            promoteSkill.slug,
            targets,
            keepWorkspaceCopy,
          );
          setPromoteSkill(null);
          bumpCapabilities((v) => v + 1);
          toast.success(`已提升为全局 Skill：${promoteSkill.name}`);
        }}
      />

      <WorkspaceScopeSelectDialog
        open={promotePreset !== null}
        title={`提升「${promotePreset?.name ?? ""}」为全局预设`}
        description="选择该全局预设要在哪些工作区生效；下一步选择是否保留原工作区预设。"
        workspaces={workspaces.filter((workspace) => !workspace.isDeleted)}
        initialWorkspaceSlug={data.workspaceSlug}
        onOpenChange={(open) => {
          if (!open) setPromotePreset(null);
        }}
        onConfirm={async (targets, keepWorkspaceCopy) => {
          if (!promotePreset) return;
          await window.electronAPI.promoteWorkspacePresetToGlobal(
            data.workspaceSlug,
            promotePreset.id,
            targets,
            keepWorkspaceCopy,
          );
          setPromotePreset(null);
          bumpCapabilities((v) => v + 1);
          toast.success(`已提升为全局预设：${promotePreset.name}`);
        }}
      />

      <ImportPresetDialog
        open={showImportPreset}
        onOpenChange={setShowImportPreset}
        workspaceSlug={data.workspaceSlug}
        onImported={() => {
          // 导入成功后 bump 已在对话框内完成；这里留空回调以保持签名一致
        }}
      />
    </FullScreenView>
  );
}

// ===== Skills Tab =====

interface SkillsTabProps {
  workspaceSkills: SkillMeta[];
  globalSkills: SkillMeta[];
  builtinSkills: SkillMeta[];
  total: number;
  updateCount: number;
  updatingSkill: string | null;
  onPromote?: (skill: SkillMeta) => void;
  isBuiltin: (slug: string) => boolean;
  onOpen: (skill: SkillMeta) => void;
  onToggle: (slug: string, enabled: boolean, sourceSkillId?: string) => void;
  onUpdate: (slug: string) => void;
  onPublish?: (slug: string) => void;
  publishingSlug?: string | null;
}

function SkillsTab({
  workspaceSkills,
  globalSkills,
  builtinSkills,
  total,
  updateCount,
  updatingSkill,
  onPromote,
  isBuiltin,
  onOpen,
  onToggle,
  onUpdate,
  onPublish,
  publishingSlug,
}: SkillsTabProps): React.ReactElement {
  if (total === 0) {
    return (
      <EmptyState
        icon={<Blocks className="size-8 text-foreground/30" />}
        title="暂无 Skill"
        hint="可以在 Agent 模式下让 Profer 帮你联网查找并安装 Skill，或从其他工作区导入。"
      />
    );
  }
  if (
    workspaceSkills.length === 0 &&
    globalSkills.length === 0 &&
    builtinSkills.length === 0
  ) {
    return (
      <EmptyState
        icon={<Search className="size-8 text-foreground/30" />}
        title="没有匹配的 Skill"
        hint="试试更换搜索关键词。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {updateCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] px-3 py-2 text-[13px] text-blue-600 dark:text-blue-400">
          有 {updateCount} 个 Skill 可更新到来源最新版本
        </div>
      )}
      {workspaceSkills.length > 0 && (
        <SkillSection
          title="工作区 Skills"
          skills={workspaceSkills}
          isBuiltin={isBuiltin}
          interactive
          updatingSkill={updatingSkill}
          onOpen={onOpen}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onPublish={onPublish}
          onPromote={onPromote}
          publishingSlug={publishingSlug}
        />
      )}
      {globalSkills.length > 0 && (
        <SkillSection
          title="全局 Skills"
          skills={globalSkills}
          isBuiltin={isBuiltin}
          interactive
          updatingSkill={updatingSkill}
          onOpen={onOpen}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onPublish={onPublish}
          publishingSlug={publishingSlug}
        />
      )}
      {builtinSkills.length > 0 && (
        <SkillSection
          title="元 Skills"
          skills={builtinSkills}
          isBuiltin={isBuiltin}
          interactive
          updatingSkill={updatingSkill}
          onOpen={onOpen}
          onToggle={onToggle}
          onUpdate={onUpdate}
          onPublish={onPublish}
          publishingSlug={publishingSlug}
        />
      )}
    </div>
  );
}

interface SkillSectionProps {
  title: string;
  skills: SkillMeta[];
  interactive?: boolean;
  isBuiltin: (slug: string) => boolean;
  updatingSkill: string | null;
  onOpen: (skill: SkillMeta) => void;
  onToggle: (slug: string, enabled: boolean, sourceSkillId?: string) => void;
  onUpdate: (slug: string) => void;
  onPublish?: (slug: string) => void;
  onPromote?: (skill: SkillMeta) => void;
  publishingSlug?: string | null;
}

function SkillSection({
  title,
  skills,
  isBuiltin,
  interactive = true,
  updatingSkill,
  onOpen,
  onToggle,
  onUpdate,
  onPublish,
  onPromote,
  publishingSlug,
}: SkillSectionProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[13px] font-medium text-foreground/55">
          {title}
        </span>
        <span className="text-[12px] tabular-nums text-foreground/35">
          {skills.length}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {skills.map((skill) => (
          <SkillCard
            key={skillListKey(skill)}
            skill={skill}
            isBuiltin={isBuiltinReferenceSkill(skill)}
            updating={updatingSkill === skill.slug}
            onOpen={() => onOpen(skill)}
            onToggle={(enabled) =>
              onToggle(skill.slug, enabled, skillToggleSourceId(skill))
            }
            onUpdate={() => onUpdate(skill.slug)}
            onPublish={onPublish ? () => onPublish(skill.slug) : undefined}
            publishing={publishingSlug === skill.slug}
            interactive={interactive}
            onPromote={
              onPromote && title === "工作区 Skills" && skill.enabled
                ? () => onPromote(skill)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

// ===== MCP Tab =====

interface McpTabProps {
  entries: Array<[string, McpServerEntry]>;
  total: number;
  onOpen: (name: string, entry: McpServerEntry) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onRequestDelete: (name: string) => void;
  onAdd: () => void;
}

function McpTab({
  entries,
  total,
  onOpen,
  onToggle,
  onRequestDelete,
  onAdd,
}: McpTabProps): React.ReactElement {
  if (total === 0) {
    return (
      <EmptyState
        icon={<Plus className="size-8 text-foreground/30" />}
        title="还没有 MCP 服务器"
        hint="点击右上角「添加服务器」开始，或在 Agent 模式下让 Profer 帮你查找并配置。"
        action={
          <button
            type="button"
            onClick={onAdd}
            className="mt-2 flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            <Plus size={14} />
            <span>添加服务器</span>
          </button>
        }
      />
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Search className="size-8 text-foreground/30" />}
        title="没有匹配的 MCP 服务器"
        hint="试试更换搜索关键词。"
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {entries.map(([name, entry]) => (
        <McpCard
          key={name}
          name={name}
          entry={entry}
          onOpen={() => onOpen(name, entry)}
          onToggle={(enabled) => onToggle(name, enabled)}
          onRequestDelete={() => onRequestDelete(name)}
        />
      ))}
    </div>
  );
}

// ===== Empty State =====

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 pt-24 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-foreground/[0.04]">
        {icon}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[15px] font-medium text-foreground/85">
          {title}
        </div>
        <div className="text-[13px] leading-relaxed text-foreground/50">
          {hint}
        </div>
      </div>
      {action}
    </div>
  );
}
