/**
 * MasterSkillDetailSheet — 全局元 Skill 详情抽屉
 *
 * 承载元 Skill 的 SKILL.md 编辑（保存自动 bump 版本 + 生成快照）、
 * 版本历史浏览与回退，以及「同步到工作区」入口。
 */

import * as React from "react";
import { toast } from "sonner";
import {
  Save,
  X,
  Pencil,
  RefreshCw,
  History,
  Download,
  Plus,
  ChevronDown,
  Check,
  ShieldCheck,
} from "lucide-react";
import { SkillDetailSheetFrame } from "./SkillDetailSheetFrame";
import { SkillDetailLayout } from "./SkillDetailLayout";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SettingsCard } from "@/components/settings/primitives";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  AgentWorkspace,
  GlobalSkillMeta,
  GlobalSkillWorkspaceReference,
  MasterSkillMeta,
  MasterSkillVersion,
} from "@profer/shared";
import { extractSkillBody, rebuildSkillMd } from "./skillMdUtils";

interface Props {
  skill: MasterSkillMeta | GlobalSkillMeta | null;
  workspaceSlug?: string;
  globalMode?: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  /** 打开同步对话框 */
  onSync?: (slug: string) => void;
  /** 工作区页面查看全局/元 Skill 时，原始定义只读。 */
  readOnlyGlobal?: boolean;
  onCopyToWorkspace?: (skillId: string) => void | Promise<void>;
  onOpenGlobalConfig?: () => void;
}

function isGlobalSkill(skill: Props["skill"]): skill is GlobalSkillMeta {
  return !!skill && "skillId" in skill;
}

function ScopeManager({
  references,
  workspaces,
  busy,
  onAdd,
  onRemove,
}: {
  references: GlobalSkillWorkspaceReference[];
  workspaces: AgentWorkspace[];
  busy: boolean;
  onAdd: (slug: string) => void;
  onRemove: (slug: string) => void;
}): React.ReactElement {
  const active = references.filter(
    (reference) => reference.actualSource === "global",
  );
  const activeSlugs = new Set(
    active.map((reference) => reference.workspaceSlug),
  );
  const available = workspaces.filter(
    (workspace) => !activeSlugs.has(workspace.slug),
  );
  return (
    <SettingsCard divided={false}>
      <div className="flex flex-wrap items-center gap-2 p-4">
        <span className="mr-1 text-sm font-medium">已生效工作区：</span>
        {active.map((reference) => (
          <span
            key={reference.workspaceSlug}
            className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1.5 text-xs text-primary"
          >
            <span>{reference.workspaceName}</span>
            <button
              type="button"
              aria-label={`移除 ${reference.workspaceName}`}
              disabled={busy}
              onClick={() => onRemove(reference.workspaceSlug)}
              className="rounded-full p-0.5 hover:bg-primary/15 disabled:opacity-50"
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || available.length === 0}
            >
              <Plus size={13} className="mr-1" />
              添加工作区
              <ChevronDown size={13} className="ml-1" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1">
            {available.length ? (
              available.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => onAdd(workspace.slug)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <span className="truncate">{workspace.name}</span>
                  <Check size={13} className="text-primary" />
                </button>
              ))
            ) : (
              <p className="p-2 text-xs text-muted-foreground">
                所有工作区均已生效
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </SettingsCard>
  );
}

function BuiltinTag(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
      <ShieldCheck size={12} />
      Profer 内置
    </span>
  );
}

export function MasterSkillDetailSheet(props: Props): React.ReactElement {
  const { skill, onOpenChange } = props;
  return (
    <SkillDetailSheetFrame
      open={!!skill}
      title="Skill 详情"
      onOpenChange={onOpenChange}
    >
      {skill && <MasterSkillBody key={skill.slug} {...props} skill={skill} />}
    </SkillDetailSheetFrame>
  );
}

function MasterSkillBody({
  skill,
  workspaceSlug,
  globalMode = false,
  onOpenChange,
  onChanged,
  onSync,
  readOnlyGlobal = false,
  onCopyToWorkspace,
  onOpenGlobalConfig,
}: Props & { skill: MasterSkillMeta | GlobalSkillMeta }): React.ReactElement {
  const slug = skill.slug;
  const isGlobal = isGlobalSkill(skill);
  const canEditBody =
    !isGlobal || (!readOnlyGlobal && skill.type !== "builtin-meta");
  const canEditMeta = !isGlobal || !readOnlyGlobal;
  const [content, setContent] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<MasterSkillVersion[]>([]);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editBody, setEditBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [tab, setTab] = React.useState<"edit" | "history">("edit");
  const [rollingBack, setRollingBack] = React.useState(false);
  const [displayName, setDisplayName] = React.useState(skill.name);
  const [displayDesc, setDisplayDesc] = React.useState(skill.description ?? "");
  const [isEditingMeta, setIsEditingMeta] = React.useState(false);
  const [editName, setEditName] = React.useState("");
  const [editDesc, setEditDesc] = React.useState("");
  const [savingMeta, setSavingMeta] = React.useState(false);
  const [scopeReferences, setScopeReferences] = React.useState<
    GlobalSkillWorkspaceReference[]
  >([]);
  const [workspaces, setWorkspaces] = React.useState<AgentWorkspace[]>([]);
  const [scopeBusy, setScopeBusy] = React.useState(false);

  React.useEffect(() => {
    setContent(null);
    setHistory([]);
    setIsEditing(false);
    setTab("edit");
    const read = isGlobal
      ? window.electronAPI.globalSkill.read(skill.skillId)
      : window.electronAPI.skillMaster.read(slug);
    void read.then(setContent).catch((e) => {
      console.error("[MasterSkill] 读取失败:", e);
      setContent(null);
    });
    if (!isGlobal)
      void window.electronAPI.skillMaster
        .listHistory(slug)
        .then(setHistory)
        .catch(() => setHistory([]));
    if (globalMode && isGlobal)
      void Promise.all([
        window.electronAPI.globalSkill.getDeleteBlockers(skill.skillId),
        window.electronAPI.listAgentWorkspaces(),
      ])
        .then(([report, listed]) => {
          setScopeReferences(report.references);
          setWorkspaces(listed.filter((workspace) => !workspace.isDeleted));
        })
        .catch(() => {
          setScopeReferences([]);
          setWorkspaces([]);
        });
  }, [slug, skill, isGlobal, globalMode]);

  const body = React.useMemo(() => extractSkillBody(content ?? ""), [content]);

  const saveMeta = async (): Promise<void> => {
    setSavingMeta(true);
    try {
      if (isGlobal) return;
      await window.electronAPI.skillMaster.renameMeta(slug, {
        name: editName,
        description: editDesc,
      });
      setDisplayName(editName);
      setDisplayDesc(editDesc);
      setIsEditingMeta(false);
      onChanged();
      toast.success("元数据已更新");
    } catch (e) {
      console.error("[MasterSkill] 更新元数据失败:", e);
      toast.error("更新元数据失败");
    } finally {
      setSavingMeta(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!content) return;
    setSaving(true);
    try {
      const newContent = rebuildSkillMd(content, { body: editBody });
      if (isGlobal)
        await window.electronAPI.globalSkill.save(
          skill.skillId,
          newContent,
          workspaceSlug ?? "",
          "global",
        );
      else
        await window.electronAPI.skillMaster.save(
          slug,
          newContent,
          note.trim() || undefined,
        );
      setContent(newContent);
      setIsEditing(false);
      setNote("");
      onChanged();
      // 刷新历史
      if (!isGlobal) {
        const h = await window.electronAPI.skillMaster.listHistory(slug);
        setHistory(h);
      }
      toast.success(
        isGlobal ? "全局 Skill 已保存" : "元 Skill 已保存（版本已 bump）",
      );
    } catch (e) {
      console.error("[MasterSkill] 保存失败:", e);
      toast.error("保存失败");
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (snapshotId: string): Promise<void> => {
    setRollingBack(true);
    try {
      if (isGlobal) return;
      await window.electronAPI.skillMaster.rollback(slug, snapshotId);
      const c = await window.electronAPI.skillMaster.read(slug);
      const h = await window.electronAPI.skillMaster.listHistory(slug);
      setContent(c);
      setHistory(h);
      onChanged();
      toast.success(`已回退到 ${snapshotId}`);
    } catch (e) {
      console.error("[MasterSkill] 回退失败:", e);
      toast.error("回退失败");
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <SkillDetailLayout
        title={isGlobal ? "全局 Skill 详情" : "全局元 Skill 详情"}
        name={displayName}
        slug={slug}
        version={skill.version}
        badge={
          isGlobal && skill.type === "builtin-meta" ? <BuiltinTag /> : undefined
        }
        onBack={() => onOpenChange(false)}
        actions={
          <>
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">
                {isGlobal
                  ? "全局 Skill"
                  : `已同步 ${skill.syncedWorkspaceCount} 个工作区`}
              </span>
              {!isGlobal && skill.userModified && (
                <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  已修改
                </span>
              )}
            </div>
            {!globalMode && onSync && (
              <Button size="sm" variant="outline" onClick={() => onSync(slug)}>
                <Download size={14} className="mr-1" />
                同步到工作区
              </Button>
            )}
            {isGlobal && readOnlyGlobal && onCopyToWorkspace && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onCopyToWorkspace(skill.skillId)}
              >
                <Download size={14} className="mr-1" />
                在当前工作区创建副本
              </Button>
            )}
            {isGlobal &&
              readOnlyGlobal &&
              onOpenGlobalConfig &&
              skill.type === "user-global" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onOpenGlobalConfig}
                >
                  前往全局配置编辑
                </Button>
              )}
          </>
        }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {globalMode && isGlobal && (
          <ScopeManager
            references={scopeReferences}
            workspaces={workspaces}
            busy={scopeBusy}
            onAdd={(target) => {
              setScopeBusy(true);
              void window.electronAPI.globalSkill
                .setEnabled(target, skill.skillId, true)
                .then(async () => {
                  const report =
                    await window.electronAPI.globalSkill.getDeleteBlockers(
                      skill.skillId,
                    );
                  setScopeReferences(report.references);
                  onChanged();
                  toast.success("已添加该工作区的生效范围");
                })
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : "添加范围失败",
                  ),
                )
                .finally(() => setScopeBusy(false));
            }}
            onRemove={(target) => {
              setScopeBusy(true);
              void window.electronAPI.globalSkill
                .setEnabled(target, skill.skillId, false)
                .then(async () => {
                  const report =
                    await window.electronAPI.globalSkill.getDeleteBlockers(
                      skill.skillId,
                    );
                  setScopeReferences(report.references);
                  onChanged();
                  toast.success("已移除该工作区的生效范围");
                })
                .catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : "移除范围失败",
                  ),
                )
                .finally(() => setScopeBusy(false));
            }}
          />
        )}
        {/* 编辑 / 历史 切换 */}
        <div className="flex items-center gap-1 px-5 pt-3">
          {!globalMode && (
            <>
              <TabButton
                active={tab === "edit"}
                label="编辑"
                onClick={() => setTab("edit")}
              />
              <TabButton
                active={tab === "history"}
                label={`历史 (${history.length})`}
                onClick={() => setTab("history")}
              />
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-5">
          {tab === "edit" ? (
            <div className="flex flex-col gap-3">
              {/* 元数据（name / description）编辑 */}
              <div className="rounded-lg border border-border/60 bg-content-area px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    元数据
                  </span>
                  {canEditMeta &&
                    (!isEditingMeta ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditName(displayName);
                          setEditDesc(displayDesc);
                          setIsEditingMeta(true);
                        }}
                      >
                        <Pencil size={13} className="mr-1" /> 编辑
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setIsEditingMeta(false)}
                          disabled={savingMeta}
                        >
                          <X size={13} className="mr-1" /> 取消
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void saveMeta()}
                          disabled={savingMeta}
                        >
                          <Save size={13} className="mr-1" />{" "}
                          {savingMeta ? "保存中..." : "保存"}
                        </Button>
                      </div>
                    ))}
                </div>
                {isEditingMeta ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="名称"
                      className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <textarea
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      placeholder="描述"
                      rows={2}
                      className="w-full resize-y rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                ) : (
                  <div className="mt-1.5 flex flex-col gap-1">
                    <div className="text-sm text-foreground">
                      {displayName || "未设置名称"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {displayDesc || "暂无描述"}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <div className="font-mono text-xs text-muted-foreground">
                  SKILL.md
                </div>
                {canEditBody &&
                  (!isEditing ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditBody(body);
                        setIsEditing(true);
                      }}
                    >
                      <RefreshCw size={14} className="mr-1" />
                      编辑
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setIsEditing(false)}
                        disabled={saving}
                      >
                        <X size={14} className="mr-1" /> 取消
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void save()}
                        disabled={saving}
                      >
                        <Save size={14} className="mr-1" />{" "}
                        {saving ? "保存中..." : "保存并生成新版本"}
                      </Button>
                    </div>
                  ))}
              </div>

              {isEditing && !isGlobal && (
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="本次改动说明（可选，会记录到版本历史）"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}

              <SettingsCard divided={false}>
                <div className="p-4">
                  {isEditing ? (
                    <textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      className="min-h-[360px] w-full resize-y rounded-md border border-border bg-transparent p-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="输入 SKILL.md 正文（保存后 version 自动 +1）..."
                    />
                  ) : (
                    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-[13px] text-foreground">
                      {content ?? "加载中..."}
                    </pre>
                  )}
                </div>
              </SettingsCard>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                每次保存自动生成一条快照；点击「回退」可恢复到指定版本（会保留一条新的回退记录）。
              </p>
              {history.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  暂无版本历史
                </div>
              )}
              {history.map((v) => (
                <div
                  key={v.snapshotId}
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-content-area px-3 py-2.5"
                >
                  <History
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {v.snapshotId}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        v{v.version}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                      {v.note ? ` · ${v.note}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      rollingBack ||
                      v.snapshotId === history[history.length - 1]?.snapshotId
                    }
                    onClick={() => void rollback(v.snapshotId)}
                  >
                    回退
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SkillDetailLayout>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "rounded-lg bg-muted px-3 py-1.5 text-[13px] font-medium text-foreground"
          : "rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted/50"
      }
    >
      {label}
    </button>
  );
}
