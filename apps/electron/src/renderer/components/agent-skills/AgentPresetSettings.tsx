/**
 * AgentPresetSettings — 「Agent 技能」视图的「预设」tab 管理区块
 *
 * 内置预设只读可复制；自定义预设可编辑/删除；任意预设可设为默认（新建会话使用）。
 * 编辑表单覆盖五类能力：提示词段、推理档位、权限模式、Skill 白名单、MCP 白名单。
 */

import * as React from "react";
import { toast } from "sonner";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Plus,
  Copy,
  Pencil,
  Trash2,
  Star,
  Check,
  Download,
  Upload,
  ChevronDown,
  X,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@profer/ui/primitives/button";
import { Input } from "@profer/ui/primitives/input";
import { Textarea } from "@profer/ui/primitives/textarea";
import { Switch } from "@profer/ui/primitives/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@profer/ui/primitives/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@profer/ui/primitives/dialog";
import {
  SettingsSection,
  SettingsCard,
} from "@/components/settings/primitives";
import { workspacePresetsAtom } from "@/atoms/agent-preset-atoms";
import { workspaceCapabilitiesVersionAtom } from "@/atoms/agent-atoms";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@profer/ui/primitives/popover";
import { GlobalPresetScopePanel } from "./GlobalPresetScopePanel";
import { ConfirmDialog } from "@profer/ui/primitives/confirm-dialog";
import type {
  AgentWorkspace,
  PresetReference,
  PresetReferenceReport,
  PresetWorkspaceReference,
  Channel,
} from "@profer/shared";
import { isChannelEnabledForAnyRuntime } from "@profer/shared";

function BuiltinPresetTag(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
      <ShieldCheck size={11} />
      Profer 内置
    </span>
  );
}

import type {
  AgentPreset,
  AgentPresetCreateInput,
  AgentPresetUpdateInput,
  AgentPresetToolGroup,
  AgentEffort,
  ProferPermissionMode,
  SkillMeta,
} from "@profer/shared";
import {
  AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP,
  AGENT_PRESET_GROUP_TOOL_NAMES,
  AGENT_PRESET_CAPABILITY_GROUPS,
} from "@profer/shared";
import type { AgentPresetSuppressKey } from "@profer/shared";

// ===== 表单状态 =====

interface PresetFormState {
  name: string;
  description: string;
  promptText: string;
  channelId: string; // 空 = 委派时继承
  modelId: string; // 空 = 委派时继承
  effort: string; // '' = 跟随全局
  permissionMode: string; // '' = 跟随默认
  skillSlugs: string; // 逗号分隔
  mcpServerNames: string; // 逗号分隔
  allowSubagents: string; // '' = 跟随 / 'yes' / 'no'
  disabledToolGroups: AgentPresetToolGroup[]; // 空数组 = 全部可用
  disabledTools: string[]; // 禁用的单工具短名
  basePresetId: string; // '' = 独立预设 / 内置预设 ID = 派生
}

/** 产品内置能力组选项直接来自 shared registry，避免 UI 与运行时清单漂移。 */
/** Radix Select 保留空字符串给 placeholder，表单的“跟随/独立”状态使用非空哨兵值。 */
const SELECT_DEFAULT_VALUE = "__default__";

const TOOL_GROUP_OPTIONS = AGENT_PRESET_CAPABILITY_GROUPS.map((group) => ({
  value: group.id,
  label: group.label,
  hint: group.hint,
}));

/** 与运行时一致的自动映射（shared 唯一事实表）：工具组禁用 → 隐藏对应提示词段 key（含 automation） */

function presetToForm(preset: AgentPreset): PresetFormState {
  return {
    name: preset.name,
    description: preset.description,
    promptText: preset.promptSections?.join("\n\n") ?? "",
    channelId: preset.channelId ?? "",
    modelId: preset.modelId ?? "",
    effort: preset.effort ?? "",
    permissionMode: preset.permissionMode ?? "",
    skillSlugs: preset.skillSlugs?.join(", ") ?? "",
    mcpServerNames: preset.mcpServerNames?.join(", ") ?? "",
    allowSubagents:
      preset.allowSubagents === undefined
        ? ""
        : preset.allowSubagents
          ? "yes"
          : "no",
    disabledToolGroups: preset.disabledToolGroups ?? [],
    disabledTools: preset.disabledTools ?? [],
    basePresetId: preset.basePresetId ?? "",
  };
}

/** 逗号分隔文本 → slug 数组（去空白去空项） */
function parseSlugList(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ===== 勾选面板（Skill / MCP 白名单共用） =====

interface PickItem {
  value: string;
  label: string;
  hint?: string;
  /** 工作区层已停用的项（白名单选了也不生效，仅标注） */
  disabled?: boolean;
}

interface PickListProps {
  items: PickItem[];
  selected: Set<string>;
  searchable?: boolean;
  emptyHint: string;
  onToggle: (value: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

/** 可搜索的多选列表：chip 平铺勾选（免长列表滚动），顶部带已选计数与全选/清空 */
function PickList({
  items,
  selected,
  searchable,
  emptyHint,
  onToggle,
  onSelectAll,
  onClear,
}: PickListProps): React.ReactElement {
  const [filter, setFilter] = React.useState("");
  const q = filter.trim().toLowerCase();
  const visible = q
    ? items.filter((i) =>
        (i.label + i.value + (i.hint ?? "")).toLowerCase().includes(q),
      )
    : items;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {searchable && (
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索…"
              className="h-7 w-36 text-xs"
            />
          )}
          <span className="text-[10px] text-muted-foreground">
            已选 {selected.size} / {items.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            onClick={onSelectAll}
          >
            全选
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            onClick={onClear}
          >
            清空（全部禁用）
          </Button>
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto scrollbar-thin">
        {visible.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">
            {emptyHint}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5 p-1">
            {visible.map((item) => {
              const checked = selected.has(item.value);
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => onToggle(item.value)}
                  title={`${item.value}${item.hint ? ` · ${item.hint}` : ""}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
                    checked
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/80 text-foreground/75 hover:bg-foreground/[0.04]",
                    item.disabled && !checked && "opacity-45",
                  )}
                >
                  {checked && <Check size={11} strokeWidth={3} />}
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface PendingPresetDisable {
  preset: AgentPreset;
  reference: PresetReference;
  report: PresetReferenceReport;
}

function presetReference(preset: AgentPreset, workspaceSlug: string): PresetReference {
  const scope = preset.scope ?? (preset.isBuiltin ? "builtin-meta" : "user-global");
  return {
    presetId: preset.id,
    presetScope: scope,
    ...(scope === "workspace" ? { workspaceSlug } : {}),
  };
}

function presetReferenceKey(preset: AgentPreset): string {
  return `${preset.scope ?? (preset.isBuiltin ? "builtin-meta" : "user-global")}:${preset.id}`;
}

interface AgentPresetSettingsProps {
  workspaceSlug?: string;
  search?: string;
  globalMode?: boolean;
  onPromote?: (preset: AgentPreset) => void;
  onOpenGlobalConfig?: () => void;
  hideToolbar?: boolean;
  createRequestToken?: number;
  importFileRequestToken?: number;
  exportRequestToken?: number;
}

export function AgentPresetSettings({
  workspaceSlug,
  search = "",
  globalMode = false,
  onPromote,
  onOpenGlobalConfig,
  hideToolbar = false,
  createRequestToken = 0,
  importFileRequestToken = 0,
  exportRequestToken = 0,
}: AgentPresetSettingsProps): React.ReactElement {
  const [workspacePresets, setWorkspacePresets] = useAtom(
    workspacePresetsAtom(workspaceSlug),
  );
  const [globalPresets, setGlobalPresets] = React.useState<AgentPreset[]>([]);
  const presets = globalMode ? globalPresets : workspacePresets;
  const [loading, setLoading] = React.useState(true);
  const [toggleBusy, setToggleBusy] = React.useState<Set<string>>(new Set());
  // 与 Skills/MCP 相同的刷新信号：预设写操作后 bump，通知会话工具栏等订阅方重拉
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom);
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom);
  const [defaultPresetId, setDefaultPresetId] = React.useState<string>("");
  const [editing, setEditing] = React.useState<AgentPreset | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [form, setForm] = React.useState<PresetFormState>(
    presetToForm({
      name: "",
      description: "",
      isBuiltin: false,
      createdAt: 0,
      updatedAt: 0,
    } as AgentPreset),
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [pendingGlobalDelete, setPendingGlobalDelete] =
    React.useState<AgentPreset | null>(null);
  const [globalDeleteReport, setGlobalDeleteReport] =
    React.useState<PresetReferenceReport | null>(null);
  const [globalDeleteBusy, setGlobalDeleteBusy] = React.useState(false);
  const [pendingPresetDisable, setPendingPresetDisable] =
    React.useState<PendingPresetDisable | null>(null);
  const [replacementPresetKey, setReplacementPresetKey] = React.useState("");
  const [presetDisableBusy, setPresetDisableBusy] = React.useState(false);
  // 导出/导入文件操作的结果提示（头部按钮下方展示，几秒后自动消失）
  const [fileNotice, setFileNotice] = React.useState("");
  const [fileBusy, setFileBusy] = React.useState(false);
  const reloadRequestId = React.useRef(0);
  // 勾选面板数据源：当前工作区的 Skills 与 MCP 列表（打开对话框时拉取）
  const [availableSkills, setAvailableSkills] = React.useState<SkillMeta[]>([]);
  const [availableMcpServers, setAvailableMcpServers] = React.useState<
    Array<{ name: string; enabled: boolean }>
  >([]);
  const [availableChannels, setAvailableChannels] = React.useState<Channel[]>([]);
  const dialogOpen = creating || editing !== null;

  React.useEffect(() => {
    if (!dialogOpen || !workspaceSlug) return;
    void (async () => {
      try {
        const [skills, mcp, channels] = await Promise.all([
          window.electronAPI.getWorkspaceSkills(workspaceSlug),
          window.electronAPI.getWorkspaceMcpConfig(workspaceSlug),
          window.electronAPI.listChannels({ localOnly: true }),
        ]);
        setAvailableSkills(skills);
        setAvailableMcpServers(
          Object.entries(mcp.servers).map(([name, entry]) => ({
            name,
            enabled: !!entry.enabled,
          })),
        );
        setAvailableChannels(channels);
      } catch (err) {
        console.error("[预设设置] 加载 Skill/MCP 列表失败:", err);
      }
    })();
  }, [dialogOpen, workspaceSlug]);

  // 白名单勾选集合（文本字段为真源，面板为其视图）
  const selectedSkillSlugs = React.useMemo(
    () => new Set(parseSlugList(form.skillSlugs)),
    [form.skillSlugs],
  );
  const selectedMcpNames = React.useMemo(
    () => new Set(parseSlugList(form.mcpServerNames)),
    [form.mcpServerNames],
  );

  const toggleSkillSlug = React.useCallback((slug: string) => {
    setForm((f) => {
      const next = new Set(parseSlugList(f.skillSlugs));
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return { ...f, skillSlugs: [...next].join(", ") };
    });
  }, []);

  const toggleMcpName = React.useCallback((name: string) => {
    setForm((f) => {
      const next = new Set(parseSlugList(f.mcpServerNames));
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...f, mcpServerNames: [...next].join(", ") };
    });
  }, []);

  /** 单工具裁剪勾选：已选 = 禁用该工具（短名，与 shared 事实表一致） */
  const toggleDisabledTool = React.useCallback((toolName: string) => {
    setForm((f) => ({
      ...f,
      disabledTools: f.disabledTools.includes(toolName)
        ? f.disabledTools.filter((t) => t !== toolName)
        : [...f.disabledTools, toolName],
    }));
  }, []);

  const reload = React.useCallback(
    async (options?: { silent?: boolean }) => {
      const requestId = ++reloadRequestId.current;
      if (!options?.silent) setLoading(true);
      try {
        const list = globalMode
          ? await window.electronAPI.listGlobalAgentPresets()
          : await window.electronAPI.listAgentPresets(workspaceSlug, true);
        if (requestId !== reloadRequestId.current) return;
        if (globalMode) {
          setGlobalPresets(list);
          setDefaultPresetId("");
        } else {
          const defaultId = await window.electronAPI.getDefaultAgentPreset(workspaceSlug);
          if (requestId !== reloadRequestId.current) return;
          setWorkspacePresets(list);
          setDefaultPresetId(defaultId);
        }
      } catch (err) {
        if (requestId === reloadRequestId.current) console.error("[预设设置] 加载失败:", err);
      } finally {
        if (!options?.silent && requestId === reloadRequestId.current) setLoading(false);
      }
    },
    [globalMode, setWorkspacePresets, workspaceSlug],
  );

  // 搜索过滤：名称 / 描述 / 提示词段 / Skill 白名单 / MCP 白名单
  const q = search.trim().toLowerCase();
  const filteredPresets = React.useMemo(() => {
    if (!q) return presets;
    return presets.filter((p) => {
      const haystack = [
        p.name,
        p.description,
        ...(p.promptSections ?? []),
        ...(p.skillSlugs ?? []),
        ...(p.mcpServerNames ?? []),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [presets, q]);

  // 首次进入/切换工作区时显示加载态；能力开关等外部刷新沿用当前列表，避免整页白屏和滚动位置跳动。
  React.useEffect(() => {
    void reload();
  }, [reload]);
  React.useEffect(() => {
    if (capabilitiesVersion > 0) void reload({ silent: true });
  }, [capabilitiesVersion, reload]);

  const openCreate = React.useCallback(() => {
    setError("");
    setForm({
      name: "",
      description: "",
      promptText: "",
      channelId: "",
      modelId: "",
      effort: "",
      permissionMode: "",
      skillSlugs: "",
      mcpServerNames: "",
      allowSubagents: "",
      disabledToolGroups: [],
      disabledTools: [],
      basePresetId: "",
    });
    setCreating(true);
  }, []);
  // 挂载时以当前计数为基线，避免切回选项卡时重放历史请求。
  const previousCreateRequest = React.useRef(createRequestToken);
  React.useEffect(() => {
    if (createRequestToken > previousCreateRequest.current) {
      previousCreateRequest.current = createRequestToken;
      openCreate();
    }
  }, [createRequestToken, openCreate]);

  const openEdit = React.useCallback((preset: AgentPreset) => {
    setError("");
    setForm(presetToForm(preset));
    setEditing(preset);
  }, []);

  /**
   * 更新输入：始终传全量字段，null = 清除（manager 支持）；
   * suppressPromptSections 按工具组自动映射，保证提示词与工具一致。
   */
  const buildUpdateInput = React.useCallback((): AgentPresetUpdateInput => {
    const promptSections = form.promptText.trim()
      ? form.promptText
          .split(/\n\s*\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    const suppressPromptSections = form.disabledToolGroups
      .map((g) => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[g])
      .filter((key): key is AgentPresetSuppressKey => key !== undefined);

    return {
      name: form.name,
      description: form.description,
      promptSections,
      suppressPromptSections:
        suppressPromptSections.length > 0 ? suppressPromptSections : null,
      disabledToolGroups:
        form.disabledToolGroups.length > 0 ? form.disabledToolGroups : null,
      disabledTools: form.disabledTools.length > 0 ? form.disabledTools : null,
      channelId: form.channelId.trim() || null,
      modelId: form.modelId.trim() || null,
      effort: (form.effort || null) as AgentEffort | null,
      permissionMode: (form.permissionMode ||
        null) as ProferPermissionMode | null,
      // 白名单必须显式保存：空数组表示不注入，只有「全选」才是全部可用。
      skillSlugs: parseSlugList(form.skillSlugs),
      mcpServerNames: parseSlugList(form.mcpServerNames),
      allowSubagents: form.allowSubagents
        ? form.allowSubagents === "yes"
        : null,
      // 派生基座：选内置=设置（切换）；留空=null（脱离基座，manager 冻结当前生效配置）
      basePresetId: form.basePresetId || null,
    };
  }, [form]);

  /** 创建输入：从全量输入剔除 null（manager 创建时 null 表示未设置） */
  const buildCreateInput = React.useCallback((): AgentPresetCreateInput => {
    const u = buildUpdateInput();
    return {
      name: u.name ?? "",
      description: u.description ?? "",
      ...(u.promptSections && { promptSections: u.promptSections }),
      ...(u.suppressPromptSections && {
        suppressPromptSections: u.suppressPromptSections,
      }),
      ...(u.disabledToolGroups && { disabledToolGroups: u.disabledToolGroups }),
      ...(u.disabledTools && { disabledTools: u.disabledTools }),
      ...(u.channelId && { channelId: u.channelId }),
      ...(u.modelId && { modelId: u.modelId }),
      ...(u.effort && { effort: u.effort }),
      ...(u.permissionMode && { permissionMode: u.permissionMode }),
      ...(u.skillSlugs && { skillSlugs: u.skillSlugs }),
      ...(u.mcpServerNames && { mcpServerNames: u.mcpServerNames }),
      ...(u.allowSubagents !== null &&
        u.allowSubagents !== undefined && { allowSubagents: u.allowSubagents }),
      ...(form.basePresetId && { basePresetId: form.basePresetId }),
    };
  }, [buildUpdateInput, form.basePresetId]);

  const selectableChannels = React.useMemo(
    () => availableChannels
      .filter((channel) => isChannelEnabledForAnyRuntime(channel))
      .map((channel) => ({
        ...channel,
        models: channel.models.filter((model) => model.enabled),
      }))
      .filter((channel) => channel.models.length > 0),
    [availableChannels],
  );
  const selectedChannel = selectableChannels.find((channel) => channel.id === form.channelId);
  const selectedModel = selectedChannel?.models.find((model) => model.id === form.modelId);
  const bindingIsLegacy = !form.channelId && !!form.modelId;
  const bindingIsInvalid = !!form.channelId && (!selectedChannel || !selectedModel);
  const modelSelectEnabled = !!selectedChannel || bindingIsLegacy;


  const handleSave = React.useCallback(async () => {
    if (!form.name.trim()) {
      setError("预设名称不能为空");
      return;
    }
    if (form.channelId.trim() && !form.modelId.trim()) {
      setError("选择了委派渠道后，还需要选择一个模型；如果要跟随父会话，请把渠道也设为跟随。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (globalMode) {
        if (editing) {
          await window.electronAPI.updateGlobalAgentPreset(
            editing.id,
            buildUpdateInput(),
          );
          setEditing(null);
        } else {
          await window.electronAPI.createGlobalAgentPreset(buildCreateInput());
          setCreating(false);
        }
      } else {
        if (!workspaceSlug) {
          setError("预设管理需要选择工作区");
          return;
        }
        if (editing) {
          await window.electronAPI.updateAgentPreset(
            workspaceSlug,
            editing.id,
            buildUpdateInput(),
          );
          setEditing(null);
        } else {
          await window.electronAPI.createAgentPreset(
            workspaceSlug,
            buildCreateInput(),
          );
          setCreating(false);
        }
      }
      await reload();
      bumpCapabilities((v) => v + 1);
    } catch (err) {
      console.error("[预设设置] 保存失败:", err);
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [
    editing,
    form.name,
    buildUpdateInput,
    buildCreateInput,
    globalMode,
    workspaceSlug,
    reload,
    bumpCapabilities,
  ]);

  const handleCopy = React.useCallback(
    async (preset: AgentPreset) => {
      if (!workspaceSlug || globalMode) return;
      try {
        await window.electronAPI.copyAgentPreset(workspaceSlug, preset.id);
        await reload();
        bumpCapabilities((v) => v + 1);
      } catch (err) {
        console.error("[预设设置] 复制失败:", err);
      }
    },
    [globalMode, workspaceSlug, reload, bumpCapabilities],
  );

  const handleDelete = React.useCallback(
    async (preset: AgentPreset) => {
      try {
        if (globalMode) {
          const report = await window.electronAPI.getPresetReferenceReport({
            presetId: preset.id,
            presetScope: preset.scope ?? "user-global",
          });
          setGlobalDeleteReport(report);
          if (report.canDelete) setPendingGlobalDelete(preset);
          else {
            const message = `无法删除「${preset.name}」：仍有 ${report.totalCount} 个有效引用，请先解除对应工作区范围。`;
            setError(message);
            toast.error(message);
          }
          return;
        }
        if (!workspaceSlug) return;
        await window.electronAPI.deleteAgentPreset(workspaceSlug, preset.id);
        await reload();
        bumpCapabilities((v) => v + 1);
      } catch (err) {
        console.error("[预设设置] 删除失败:", err);
        const message = err instanceof Error ? err.message : "删除失败";
        setError(message);
        toast.error(message);
      }
    },
    [globalMode, workspaceSlug, reload, bumpCapabilities],
  );

  const confirmGlobalDelete = React.useCallback(async () => {
    if (!pendingGlobalDelete) return;
    setGlobalDeleteBusy(true);
    try {
      await window.electronAPI.deleteGlobalAgentPreset({
        presetId: pendingGlobalDelete.id,
        presetScope: pendingGlobalDelete.scope ?? "user-global",
      });
      setPendingGlobalDelete(null);
      setGlobalDeleteReport(null);
      setError("");
      await reload();
      bumpCapabilities((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setGlobalDeleteBusy(false);
    }
  }, [pendingGlobalDelete, reload, bumpCapabilities]);

  const handleTogglePreset = React.useCallback(
    async (preset: AgentPreset, enabled: boolean) => {
      if (!workspaceSlug) return;
      const reference = !enabled && preset.scope !== "workspace"
        ? presetReference(preset, workspaceSlug)
        : null;
      if (reference) {
        try {
          const report = await window.electronAPI.getPresetReferenceReport(reference);
          const hasPersistentObjectReferences = report.blockers.some(
            (blocker) =>
              blocker.workspaceSlug === workspaceSlug &&
              (blocker.reason === "session" || blocker.reason === "automation"),
          );
          if (hasPersistentObjectReferences) {
            setReplacementPresetKey("");
            setPendingPresetDisable({ preset, reference, report });
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "读取预设引用失败";
          toast.error(message);
          return;
        }
      }

      const busyId = preset.id;
      if (enabled) {
        const counterpart = presets.find(
          (candidate) =>
            candidate.id !== preset.id &&
            candidate.name === preset.name &&
            candidate.scope !== preset.scope &&
            candidate.enabledInWorkspace !== false,
        );
        if (
          counterpart &&
          !window.confirm(
            "当前工作区同时存在同名的工作区预设与全局/元预设，同时启用可能导致配置重复或行为冲突，不推荐这样使用。是否仍要继续启用？",
          )
        )
          return;
      }
      const previousEnabled =
        preset.scope === "workspace"
          ? preset.enabledInWorkspace !== false
          : preset.enabledInWorkspace === true;
      setToggleBusy((previous) => new Set(previous).add(busyId));
      const updateList = (
        items: AgentPreset[],
        nextEnabled: boolean,
      ): AgentPreset[] =>
        items.map((item) =>
          item.id === preset.id
            ? { ...item, enabledInWorkspace: nextEnabled }
            : item,
        );
      if (!globalMode)
        setWorkspacePresets(updateList(workspacePresets, enabled));
      else setGlobalPresets(updateList(globalPresets, enabled));
      try {
        if (preset.scope === "workspace") {
          await window.electronAPI.setWorkspacePresetEnabled(
            workspaceSlug,
            preset.id,
            enabled,
          );
        } else if (enabled) {
          await window.electronAPI.enableGlobalPresetInWorkspace(
            workspaceSlug,
            reference ?? presetReference(preset, workspaceSlug),
          );
        } else {
          await window.electronAPI.disableGlobalPresetInWorkspace(
            workspaceSlug,
            reference ?? presetReference(preset, workspaceSlug),
          );
        }
        if (!enabled && defaultPresetId === preset.id) {
          setDefaultPresetId(
            await window.electronAPI.getDefaultAgentPreset(workspaceSlug),
          );
        }
        bumpCapabilities((v) => v + 1);
      } catch (err) {
        console.error("[预设设置] 切换预设生效状态失败:", err);
        if (globalMode)
          setGlobalPresets(updateList(globalPresets, previousEnabled));
        else setWorkspacePresets(updateList(workspacePresets, previousEnabled));
        toast.error(
          err instanceof Error ? err.message : "切换预设生效状态失败",
        );
      } finally {
        setToggleBusy((previous) => {
          const next = new Set(previous);
          next.delete(busyId);
          return next;
        });
      }
    },
    [
      bumpCapabilities,
      globalMode,
      globalPresets,
      setGlobalPresets,
      setWorkspacePresets,
      workspacePresets,
      workspaceSlug,
      defaultPresetId,
    ],
  );

  const replacementCandidates = React.useMemo(
    () =>
      pendingPresetDisable
        ? presets.filter(
            (candidate) =>
              candidate.id !== pendingPresetDisable.preset.id &&
              candidate.enabledInWorkspace !== false,
          )
        : [],
    [pendingPresetDisable, presets],
  );

  const confirmPresetDisable = React.useCallback(async () => {
    if (!pendingPresetDisable || !workspaceSlug || !replacementPresetKey) return;
    const replacement = replacementCandidates.find(
      (candidate) => presetReferenceKey(candidate) === replacementPresetKey,
    );
    if (!replacement) {
      toast.error("请选择有效的替代预设");
      return;
    }

    setPresetDisableBusy(true);
    setToggleBusy((previous) => new Set(previous).add(pendingPresetDisable.preset.id));
    try {
      await window.electronAPI.rebindAndDisableGlobalPresetScope(
        workspaceSlug,
        pendingPresetDisable.reference,
        presetReference(replacement, workspaceSlug),
      );
      setPendingPresetDisable(null);
      setReplacementPresetKey("");
      await reload();
      bumpCapabilities((v) => v + 1);
      toast.success(`已将相关引用改绑到「${replacement.name}」，并关闭「${pendingPresetDisable.preset.name}」`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "改绑并关闭预设失败");
    } finally {
      setPresetDisableBusy(false);
      setToggleBusy((previous) => {
        const next = new Set(previous);
        next.delete(pendingPresetDisable.preset.id);
        return next;
      });
    }
  }, [
    bumpCapabilities,
    pendingPresetDisable,
    reload,
    replacementPresetKey,
    replacementCandidates,
    workspaceSlug,
  ]);

  const handleCopyToWorkspace = React.useCallback(
    async (preset: AgentPreset) => {
      if (!workspaceSlug || preset.scope === "workspace") return;
      try {
        await window.electronAPI.copyPresetToWorkspace(
          {
            presetId: preset.id,
            presetScope:
              preset.scope ??
              (preset.isBuiltin ? "builtin-meta" : "user-global"),
          },
          workspaceSlug,
        );
        await reload({ silent: true });
        bumpCapabilities((v) => v + 1);
        toast.success(`已复制「${preset.name}」到当前工作区`);
      } catch (err) {
        console.error("[预设设置] 复制到工作区失败:", err);
        toast.error(err instanceof Error ? err.message : "复制到工作区失败");
      }
    },
    [bumpCapabilities, globalMode, reload, workspaceSlug],
  );

  const handleSetDefault = React.useCallback(
    async (preset: AgentPreset) => {
      if (!workspaceSlug || globalMode) return;
      try {
        if (defaultPresetId === preset.id || preset.enabledInWorkspace === false)
          return;
        const id = await window.electronAPI.setDefaultAgentPreset(
          workspaceSlug,
          preset.id,
        );
        setDefaultPresetId(id);
        bumpCapabilities((v) => v + 1);
      } catch (err) {
        console.error("[预设设置] 设默认失败:", err);
      }
    },
    [defaultPresetId, globalMode, workspaceSlug, bumpCapabilities],
  );

  /** 导出全部预设为 JSON 文件（保存对话框由主进程弹出；取消则静默） */
  const handleExport = React.useCallback(async () => {
    if (!workspaceSlug) return;
    setFileBusy(true);
    setFileNotice("");
    try {
      const result = await window.electronAPI.exportAgentPresets(workspaceSlug);
      if (result) {
        setFileNotice(`已导出 ${result.count} 个预设：${result.filePath}`);
      }
    } catch (err) {
      console.error("[预设设置] 导出失败:", err);
      setFileNotice(
        err instanceof Error ? `导出失败：${err.message}` : "导出失败",
      );
    } finally {
      setFileBusy(false);
    }
  }, [workspaceSlug]);

  /** 从 JSON 文件导入预设（打开对话框由主进程弹出；取消则静默） */
  const handleImport = React.useCallback(async () => {
    if (!workspaceSlug) return;
    setFileBusy(true);
    setFileNotice("");
    try {
      const result = await window.electronAPI.importAgentPresets(workspaceSlug);
      if (result) {
        const renamed =
          result.renamedNames.length > 0
            ? `（重名自动改名的预设：${result.renamedNames.join(" / ")}）`
            : "";
        setFileNotice(`已导入 ${result.imported.length} 个预设${renamed}`);
        await reload();
        bumpCapabilities((v) => v + 1);
      }
    } catch (err) {
      console.error("[预设设置] 导入失败:", err);
      setFileNotice(
        err instanceof Error ? `导入失败：${err.message}` : "导入失败",
      );
    } finally {
      setFileBusy(false);
    }
  }, [workspaceSlug, reload, bumpCapabilities]);

  const previousImportFileRequest = React.useRef(importFileRequestToken);
  React.useEffect(() => {
    if (importFileRequestToken > previousImportFileRequest.current) {
      previousImportFileRequest.current = importFileRequestToken;
      void handleImport();
    }
  }, [handleImport, importFileRequestToken]);

  const previousExportRequest = React.useRef(exportRequestToken);
  React.useEffect(() => {
    if (exportRequestToken > previousExportRequest.current) {
      previousExportRequest.current = exportRequestToken;
      void handleExport();
    }
  }, [exportRequestToken, handleExport]);

  const formTitle = editing ? `编辑预设 · ${editing.name}` : "新建预设";

  const skillItems = React.useMemo<PickItem[]>(
    () =>
      availableSkills.map((s) => ({
        value: s.slug,
        label: s.name,
        hint: s.enabled ? s.slug : `${s.slug} · 未启用（需在 Skills 页启用）`,
        disabled: !s.enabled,
      })),
    [availableSkills],
  );

  const mcpItems = React.useMemo<PickItem[]>(
    () =>
      availableMcpServers.map((m) => ({
        value: m.name,
        label: m.name,
        hint: m.enabled ? "已启用" : "未启用",
        disabled: !m.enabled,
      })),
    [availableMcpServers],
  );

  return (
    <SettingsSection
      title={globalMode ? "全局预设" : "Agent 预设"}
      description="预设 = 岗位 + 工作环境：把提示词、推理档位、权限模式、Skill/MCP 白名单与能力裁剪组合成可复用配置。预设为工作区级配置，可跨工作区导入；会话内可随时切换（下一轮消息完整生效），星标为新建会话的默认预设。"
    >
      {!hideToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {!globalMode && onOpenGlobalConfig && (
              <Button size="sm" variant="ghost" onClick={onOpenGlobalConfig}>
                全局配置
              </Button>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleExport}
              disabled={fileBusy}
              title="把预设导出为 JSON 文件，便于跨机器分享"
            >
              <Download size={14} />
              <span>导出</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleImport}
              disabled={fileBusy}
              title="从 Profer 预设 JSON 文件导入"
            >
              <Upload size={14} />
              <span>导入</span>
            </Button>
            <Button size="sm" variant="outline" onClick={openCreate}>
              <Plus size={14} />
              <span>{globalMode ? "新建全局预设" : "新建预设"}</span>
            </Button>
          </div>
        </div>
      )}
      {fileNotice && (
        <p className="text-right text-xs text-muted-foreground break-all">
          {fileNotice}
        </p>
      )}
      <SettingsCard divided>
        {presets.length === 0 && loading && (
          <div className="p-4 text-sm text-muted-foreground">加载中…</div>
        )}
        {!loading && presets.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            暂无预设。
          </div>
        )}
        {!loading && presets.length > 0 && filteredPresets.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            没有匹配的预设，试试更换搜索关键词。
          </div>
        )}
        {(["workspace", "user-global", "builtin-meta"] as const).map(
          (scope) => {
            const sectionPresets = filteredPresets.filter((preset) =>
              globalMode
                ? scope === "user-global"
                  ? preset.scope === "user-global"
                  : scope === "builtin-meta"
                    ? preset.scope === "builtin-meta"
                    : false
                : preset.scope === scope,
            );
            if (sectionPresets.length === 0) return null;
            const sectionTitle =
              scope === "workspace"
                ? "工作区预设"
                : scope === "user-global"
                  ? "全局预设"
                  : "元预设";
            return (
              <React.Fragment key={scope}>
                <div className="border-t border-border/50 px-4 py-2 text-xs font-medium text-muted-foreground first:border-t-0">
                  {sectionTitle}{" "}
                  <span className="ml-1 tabular-nums text-foreground/35">
                    {sectionPresets.length}
                  </span>
                </div>
                {sectionPresets.map((preset) => {
                  const isDefault = preset.id === defaultPresetId;
                  const baseName = preset.basePresetId
                    ? presets.find((p) => p.id === preset.basePresetId)?.name
                    : undefined;
                  return (
                    <div
                      key={preset.id}
                      className={cn(
                        "flex items-center justify-between gap-3 p-4",
                        globalMode && "cursor-pointer hover:bg-muted/40",
                      )}
                      onClick={globalMode ? () => openEdit(preset) : undefined}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">
                            {preset.name}
                          </span>
                          {globalMode && preset.scope === "builtin-meta" ? (
                            <BuiltinPresetTag />
                          ) : (
                            preset.isBuiltin && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                                内置
                              </span>
                            )
                          )}
                          {!preset.isBuiltin && preset.basePresetId && (
                            <span
                              className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400 shrink-0"
                              title="派生预设只存差异，基座内置升级自动跟随"
                            >
                              基于「{baseName ?? preset.basePresetId}」
                            </span>
                          )}
                          {isDefault && (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary shrink-0">
                              默认
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                          {preset.description}
                        </p>
                        {(preset.skillSlugs ||
                          preset.mcpServerNames ||
                          preset.effort ||
                          preset.permissionMode ||
                          preset.disabledToolGroups ||
                          preset.disabledTools ||
                          preset.allowSubagents !== undefined) && (
                          <p className="mt-1 flex flex-wrap gap-1">
                            {preset.effort && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">
                                强度 {preset.effort}
                              </span>
                            )}
                            {preset.permissionMode && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">
                                权限 {preset.permissionMode}
                              </span>
                            )}
                            {preset.skillSlugs && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">
                                Skill×{preset.skillSlugs.length}
                              </span>
                            )}
                            {preset.mcpServerNames && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">
                                MCP×{preset.mcpServerNames.length}
                              </span>
                            )}
                            {preset.promptSections && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">
                                提示词段×{preset.promptSections.length}
                              </span>
                            )}
                            {preset.allowSubagents === false && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">
                                无委派
                              </span>
                            )}
                            {preset.disabledToolGroups && (
                              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
                                精简×{preset.disabledToolGroups.length}
                              </span>
                            )}
                            {preset.disabledTools && (
                              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
                                禁工具×{preset.disabledTools.length}
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!globalMode && (
                          <Switch
                            checked={
                              preset.scope === "workspace"
                                ? preset.enabledInWorkspace !== false
                                : preset.enabledInWorkspace === true
                            }
                            disabled={toggleBusy.has(preset.id)}
                            onCheckedChange={(enabled) =>
                              void handleTogglePreset(preset, enabled)
                            }
                            aria-label={`${preset.name} 在当前工作区生效`}
                          />
                        )}
                        {!globalMode && preset.scope !== "workspace" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyToWorkspace(preset);
                            }}
                            title="创建工作区副本"
                          >
                            <Copy className="size-4 text-foreground/60" />
                          </Button>
                        )}
                        {!globalMode &&
                          preset.scope !== "workspace" &&
                          onOpenGlobalConfig && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2 text-xs text-primary"
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenGlobalConfig();
                              }}
                              title="请打开全局配置进行编辑"
                            >
                              编辑全局预设
                            </Button>
                          )}
                        {!globalMode &&
                          preset.scope === "workspace" &&
                          onPromote && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2 text-xs text-primary"
                              onClick={(event) => {
                                event.stopPropagation();
                                onPromote(preset);
                              }}
                              title="提升为全局预设"
                            >
                              提升为全局
                            </Button>
                          )}
                        {!globalMode && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            disabled={isDefault || preset.enabledInWorkspace === false}
                            onClick={() => void handleSetDefault(preset)}
                            title={
                              isDefault
                                ? "当前默认"
                                : preset.enabledInWorkspace === false
                                  ? "请先启用此预设"
                                  : "设为默认"
                            }
                          >
                            <Star
                              className={cn(
                                "size-4",
                                isDefault
                                  ? "fill-primary text-primary"
                                  : "text-foreground/50",
                              )}
                            />
                          </Button>
                        )}
                        {!globalMode && preset.scope === "workspace" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            onClick={() => void handleCopy(preset)}
                            title="复制"
                          >
                            <Copy className="size-4 text-foreground/60" />
                          </Button>
                        )}
                        {!globalMode &&
                          preset.scope === "workspace" &&
                          !preset.isBuiltin && (
                            <>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8"
                                onClick={() => openEdit(preset)}
                                title="编辑"
                              >
                                <Pencil className="size-4 text-foreground/60" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 hover:text-destructive"
                                onClick={() => handleDelete(preset)}
                                title="删除"
                              >
                                <Trash2 className="size-4 text-foreground/60" />
                              </Button>
                            </>
                          )}
                        {globalMode &&
                          workspaceSlug &&
                          preset.scope !== "workspace" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleCopyToWorkspace(preset);
                              }}
                              title="复制到当前工作区"
                            >
                              <Copy className="size-4 text-foreground/60" />
                            </Button>
                          )}
                        {globalMode && preset.scope === "user-global" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 hover:text-destructive"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDelete(preset);
                            }}
                            title="删除全局预设"
                          >
                            <Trash2 className="size-4 text-foreground/60" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            );
          },
        )}
      </SettingsCard>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
            setError("");
          }
        }}
      >
        <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[920px]">
          <DialogHeader className="shrink-0 border-b bg-muted/20 px-6 py-4 sm:px-8">
            <DialogTitle className="pr-8 text-lg tracking-tight">{formTitle}</DialogTitle>
            <DialogDescription className="sr-only">
              配置预设的岗位信息、运行策略与工具权限。
            </DialogDescription>
            {globalMode && editing && (
              <GlobalPresetScopePanel preset={editing} />
            )}
          </DialogHeader>
          {!(globalMode && editing?.scope === "builtin-meta") && (
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-5 sm:px-8">
              <div className="mb-5 flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">基础信息</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              <div className="flex flex-col gap-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-foreground/80">
                    名称 <span className="text-primary">*</span>
                  </label>
                  <Input
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                    placeholder="如：研究模式"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-foreground/80">
                    描述
                  </label>
                  <Input
                    value={form.description}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, description: e.target.value }))
                    }
                    placeholder="一句话说明这个岗位"
                  />
                </div>
              </div>
              <div className="rounded-xl border bg-muted/15 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <label className="text-sm font-semibold text-foreground/90">
                      派生基座
                    </label>
                    <p className="mt-0.5 text-xs text-muted-foreground">可选：继承内置预设，减少重复配置</p>
                  </div>
                  <span className="rounded-full bg-background px-2 py-1 text-[10px] font-medium text-muted-foreground ring-1 ring-border">进阶</span>
                </div>
                <Select
                  value={form.basePresetId || SELECT_DEFAULT_VALUE}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      basePresetId: v === SELECT_DEFAULT_VALUE ? "" : v,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="独立预设（不基于内置预设）" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_DEFAULT_VALUE}>
                      独立预设（不基于内置预设）
                    </SelectItem>
                    <SelectItem value="standard">基于「标准」</SelectItem>
                    <SelectItem value="code">基于「代码」</SelectItem>
                    <SelectItem value="minimal">基于「极简」</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  只存储与基座的差异，内置预设升级后会自动跟随；下方字段仍可覆盖或追加。
                </p>
              </div>
              <div className="rounded-xl border bg-muted/15 p-4">
                <div className="mb-3">
                  <label className="text-sm font-semibold text-foreground/90">
                    行为指令
                  </label>
                  <p className="mt-0.5 text-xs text-muted-foreground">追加到系统提示词，段落之间用空行分隔</p>
                </div>
                <Textarea
                  value={form.promptText}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, promptText: e.target.value }))
                  }
                  placeholder={"## 研究模式\n\n本会话专注调研，只读不写……"}
                  rows={6}
                  className="min-h-32 resize-y bg-background/70 text-sm leading-6"
                />
              </div>
              <div className="rounded-xl border bg-muted/15 p-4">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <label className="text-sm font-semibold text-foreground/90">
                      委派路由
                    </label>
                    <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">
                      选择协作子会话使用的渠道和模型。留空时跟随父会话；保存的是稳定的渠道与模型绑定，不需要记忆模型 ID。
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
                    可选
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground/75">渠道</label>
                    <Select
                      value={form.channelId || SELECT_DEFAULT_VALUE}
                      onValueChange={(value) =>
                        setForm((f) => ({
                          ...f,
                          channelId: value === SELECT_DEFAULT_VALUE ? "" : value,
                          modelId: value === SELECT_DEFAULT_VALUE || value !== f.channelId ? "" : f.modelId,
                        }))
                      }
                    >
                      <SelectTrigger className="bg-background/70">
                        <SelectValue placeholder="跟随父会话渠道" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_DEFAULT_VALUE}>跟随父会话渠道</SelectItem>
                        {selectableChannels.map((channel) => (
                          <SelectItem key={channel.id} value={channel.id}>
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{channel.name}</span>
                              <span className="text-[10px] text-muted-foreground">{channel.models.length} 个模型</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-foreground/75">模型</label>
                    <Select
                      value={form.modelId || SELECT_DEFAULT_VALUE}
                      onValueChange={(value) =>
                        setForm((f) => ({ ...f, modelId: value === SELECT_DEFAULT_VALUE ? "" : value }))
                      }
                      disabled={!modelSelectEnabled}
                    >
                      <SelectTrigger className="bg-background/70">
                        <SelectValue placeholder={selectedChannel ? "选择模型" : bindingIsLegacy ? "清空旧版模型绑定" : "先选择渠道"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_DEFAULT_VALUE}>跟随父会话模型</SelectItem>
                        {bindingIsLegacy && (
                          <SelectItem value={form.modelId}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">旧版绑定：{form.modelId}</span>
                              <span className="truncate text-[10px] text-muted-foreground">选择“跟随父会话模型”即可清除</span>
                            </span>
                          </SelectItem>
                        )}
                        {selectedChannel?.models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{model.name}</span>
                              <span className="truncate text-[10px] text-muted-foreground">{model.id}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {bindingIsLegacy && (
                  <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    这是旧版仅绑定模型 ID 的配置。请选择渠道和模型来升级为明确路由，或清空模型后让它完全跟随父会话。
                  </p>
                )}
                {bindingIsInvalid && !bindingIsLegacy && (
                  <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                    当前绑定的渠道或模型已不可用，请重新选择；否则委派时会被拒绝，不会静默切换模型。
                  </p>
                )}
                {!availableChannels.length && (
                  <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
                    尚未找到已配置渠道。你可以先保存其他预设内容，配置 Agent 渠道后再回来选择路由。
                  </p>
                )}
                {availableChannels.length > 0 && !selectableChannels.length && (
                  <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
                    当前没有同时启用 Agent 且包含可用模型的渠道。请先在渠道设置中启用渠道、Agent 内核和至少一个模型。
                  </p>
                )}
              </div>
              <div className="rounded-xl border bg-muted/15 p-4">
                <div className="mb-3">
                  <p className="text-sm font-semibold text-foreground/90">运行策略</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">控制思考深度与操作授权方式</p>
                </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-foreground/70">
                    推理强度
                  </label>
                  <Select
                    value={form.effort || SELECT_DEFAULT_VALUE}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        effort: v === SELECT_DEFAULT_VALUE ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="跟随全局设置" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_DEFAULT_VALUE}>
                        跟随全局设置
                      </SelectItem>
                      <SelectItem value="low">低</SelectItem>
                      <SelectItem value="medium">中</SelectItem>
                      <SelectItem value="high">高</SelectItem>
                      <SelectItem value="max">最大</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-foreground/70">
                    权限模式
                  </label>
                  <Select
                    value={form.permissionMode || SELECT_DEFAULT_VALUE}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        permissionMode: v === SELECT_DEFAULT_VALUE ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="跟随会话默认" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_DEFAULT_VALUE}>
                        跟随会话默认
                      </SelectItem>
                      <SelectItem value="auto">自动审批</SelectItem>
                      <SelectItem value="bypassPermissions">
                        完全自动
                      </SelectItem>
                      <SelectItem value="plan">计划模式</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              </div>
              <div className="rounded-xl border bg-muted/15 p-4">
                <div className="mb-4">
                  <p className="text-sm font-semibold text-foreground/90">连接能力</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">选择这个预设可以调用的 Skill 与 MCP 服务</p>
                </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-foreground/80">
                    Skill 白名单
                  </label>
                  <PickList
                    items={skillItems}
                    selected={selectedSkillSlugs}
                    searchable
                    emptyHint={
                      workspaceSlug ? "当前工作区暂无 Skill" : "需要选择工作区"
                    }
                    onToggle={toggleSkillSlug}
                    onSelectAll={() =>
                      setForm((f) => ({
                        ...f,
                        skillSlugs: availableSkills
                          .map((s) => s.slug)
                          .join(", "),
                      }))
                    }
                    onClear={() => setForm((f) => ({ ...f, skillSlugs: "" }))}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-foreground/80">
                    MCP 白名单
                  </label>
                  <PickList
                    items={mcpItems}
                    selected={selectedMcpNames}
                    emptyHint={
                      workspaceSlug ? "当前工作区暂无 MCP" : "需要选择工作区"
                    }
                    onToggle={toggleMcpName}
                    onSelectAll={() =>
                      setForm((f) => ({
                        ...f,
                        mcpServerNames: availableMcpServers
                          .map((m) => m.name)
                          .join(", "),
                      }))
                    }
                    onClear={() =>
                      setForm((f) => ({ ...f, mcpServerNames: "" }))
                    }
                  />
                </div>
              </div>
              </div>
              <p className="px-1 text-xs leading-5 text-muted-foreground">
                留空表示不注入任何项；点击「全选」即可启用当前工作区的完整列表。未启用的项需要先在对应设置页开启。
              </p>
              <div className="rounded-xl border bg-muted/15 p-4">
                <div className="mb-3">
                  <p className="text-sm font-semibold text-foreground/90">访问边界</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">按需收窄工具和子 Agent 权限，打造更专注的工作模式</p>
                </div>
              <div className="flex flex-col gap-4">
                <label className="text-xs font-semibold text-foreground/80">
                  子 Agent 委派
                </label>
                <Select
                  value={form.allowSubagents || SELECT_DEFAULT_VALUE}
                  onValueChange={(v) =>
                    setForm((f) => ({
                      ...f,
                      allowSubagents: v === SELECT_DEFAULT_VALUE ? "" : v,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="跟随默认策略" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_DEFAULT_VALUE}>
                      跟随默认策略
                    </SelectItem>
                    <SelectItem value="yes">允许委派</SelectItem>
                    <SelectItem value="no">禁止委派</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-foreground/80">
                  精简能力
                </label>
                <div className="flex flex-col gap-3 rounded-lg border bg-background/50 p-4">
                  {TOOL_GROUP_OPTIONS.map((group) => {
                    const groupDisabled = form.disabledToolGroups.includes(
                      group.value,
                    );
                    const groupDefinition = AGENT_PRESET_CAPABILITY_GROUPS.find(
                      (candidate) => candidate.id === group.value,
                    );
                    const groupTools = groupDefinition?.toolNames ?? AGENT_PRESET_GROUP_TOOL_NAMES[group.value];
                    return (
                      <div key={group.value} className="flex flex-col gap-1.5">
                        <label className="flex cursor-pointer items-center justify-between gap-2 select-none">
                          <span className="flex min-w-0 flex-col">
                            <span className="text-xs">{group.label}</span>
                            <span className="truncate text-[10px] text-muted-foreground">
                              {group.hint}
                            </span>
                          </span>
                          <Switch
                            checked={groupDisabled}
                            onCheckedChange={(on) =>
                              setForm((f) => ({
                                ...f,
                                disabledToolGroups: on
                                  ? [...f.disabledToolGroups, group.value]
                                  : f.disabledToolGroups.filter(
                                      (g) => g !== group.value,
                                    ),
                              }))
                            }
                            className="scale-90 shrink-0"
                          />
                        </label>
                        {!groupDisabled && (
                          <details className="ml-1 border-l-2 border-border/60 pl-3">
                            <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground/80">
                              单工具裁剪（已禁{" "}
                              {
                                form.disabledTools.filter((t) =>
                                  (groupTools as readonly string[]).includes(t),
                                ).length
                              }{" "}
                              / {groupTools.length}）
                            </summary>
                            <div className="flex flex-wrap gap-1.5 pt-1.5">
                              {(groupDefinition?.tools ?? []).map((tool) => {
                                const checked = form.disabledTools.includes(tool.name);
                                return (
                                  <button
                                    key={tool.name}
                                    type="button"
                                    onClick={() => toggleDisabledTool(tool.name)}
                                    title={`${tool.label}：${tool.hint}；风险：${tool.risk}`}
                                    className={cn(
                                      "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-colors",
                                      checked
                                        ? "border-destructive/60 bg-destructive/10 text-destructive"
                                        : "border-border/80 text-foreground/70 hover:bg-foreground/[0.04]",
                                    )}
                                  >
                                    {checked && <Check size={10} strokeWidth={3} />}
                                    <span>{tool.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  禁用后对应工具不再注入，相关提示词段落自动隐藏（任务图/记忆/协作/定时任务）。组已整体禁用时无需再逐个勾选单工具；全部关
                  = 完整能力。
                </p>
              </div>
              </div>
              {error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
            </div>
            </div>
          )}
          {globalMode && editing?.scope === "builtin-meta" && (
            <p className="rounded-lg bg-blue-500/10 p-3 text-xs text-blue-700 dark:text-blue-300">
              这是 Profer 内置元预设，只读，不能编辑、重命名或删除。
            </p>
          )}

          <DialogFooter className="shrink-0 gap-2 border-t bg-background px-6 py-3 sm:items-center sm:gap-0 sm:px-8">
            <p className="mr-auto hidden text-xs text-muted-foreground sm:block">保存后将在下一轮会话中生效</p>
            <Button
              variant="ghost"
              className="h-9 rounded-lg px-4 text-sm"
              onClick={() => {
                setCreating(false);
                setEditing(null);
                setError("");
              }}
            >
              取消
            </Button>
            {!(globalMode && editing?.scope === "builtin-meta") && (
              <Button
                onClick={handleSave}
                disabled={saving}
                className="h-9 rounded-lg px-5 text-sm shadow-sm"
              >
                {saving ? "保存中…" : "保存预设"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {globalMode &&
        globalDeleteReport &&
        globalDeleteReport.blockers.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <p className="font-medium">当前预设存在有效引用，暂不可删除</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {globalDeleteReport.blockers.map((blocker) => (
                <li key={`${blocker.workspaceSlug}:${blocker.reason}`}>
                  {blocker.workspaceName} · {blocker.reason} ·{" "}
                  {blocker.objectCount} 项
                </li>
              ))}
            </ul>
          </div>
        )}
      <Dialog
        open={pendingPresetDisable !== null}
        onOpenChange={(open) => {
          if (!open && !presetDisableBusy) {
            setPendingPresetDisable(null);
            setReplacementPresetKey("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>关闭预设前需要改绑引用</DialogTitle>
            <DialogDescription>
              「{pendingPresetDisable?.preset.name ?? ""}」仍被当前工作区的会话或自动任务使用。请选择替代预设，系统会一次性改绑这些引用后再关闭原预设。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              当前工作区共有 {pendingPresetDisable?.report.blockers
                .filter((blocker) => blocker.workspaceSlug === workspaceSlug && (blocker.reason === "session" || blocker.reason === "automation"))
                .reduce((count, blocker) => count + blocker.objectCount, 0) ?? 0} 个会话/自动任务引用。
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">替代预设</label>
              <Select
                value={replacementPresetKey}
                onValueChange={setReplacementPresetKey}
                disabled={presetDisableBusy}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择替代预设…" />
                </SelectTrigger>
                <SelectContent>
                  {replacementCandidates.map((candidate) => (
                    <SelectItem key={presetReferenceKey(candidate)} value={presetReferenceKey(candidate)}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {replacementCandidates.length === 0 && (
                <p className="text-xs text-destructive">
                  当前工作区没有其他可用预设，请先启用或创建一个替代预设。
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={presetDisableBusy}
              onClick={() => {
                setPendingPresetDisable(null);
                setReplacementPresetKey("");
              }}
            >
              取消
            </Button>
            <Button
              disabled={presetDisableBusy || !replacementPresetKey}
              onClick={() => void confirmPresetDisable()}
            >
              {presetDisableBusy ? "改绑中…" : "改绑并关闭"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingGlobalDelete !== null}
        onOpenChange={(open) => {
          if (!open && !globalDeleteBusy) {
            setPendingGlobalDelete(null);
            setGlobalDeleteReport(null);
          }
        }}
        title={`确认删除全局预设「${pendingGlobalDelete?.name ?? ""}」？`}
        description="删除后不可恢复，且不会自动替换其他会话或工作区配置。"
        confirmLabel="删除"
        loadingLabel="删除中…"
        loading={globalDeleteBusy}
        onConfirm={() => void confirmGlobalDelete()}
      />
    </SettingsSection>
  );
}
