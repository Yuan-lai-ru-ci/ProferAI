/**
 * AgentPresetSettings — 「Agent 技能」视图的「预设」tab 管理区块
 *
 * 内置预设只读可复制；自定义预设可编辑/删除；任意预设可设为默认（新建会话使用）。
 * 编辑表单覆盖五类能力：提示词段、推理档位、权限模式、Skill 白名单、MCP 白名单。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Plus, Copy, Pencil, Trash2, Star, Check, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { SettingsSection, SettingsCard } from '@/components/settings/primitives'
import { workspacePresetsAtom } from '@/atoms/agent-preset-atoms'
import { workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'
import type { AgentPreset, AgentPresetCreateInput, AgentPresetUpdateInput, AgentPresetToolGroup, AgentEffort, ProferPermissionMode, SkillMeta } from '@profer/shared'
import { AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP, AGENT_PRESET_GROUP_TOOL_NAMES } from '@profer/shared'

// ===== 表单状态 =====

interface PresetFormState {
  name: string
  description: string
  promptText: string
  effort: string // '' = 跟随全局
  permissionMode: string // '' = 跟随默认
  skillSlugs: string // 逗号分隔
  mcpServerNames: string // 逗号分隔
  allowSubagents: string // '' = 跟随 / 'yes' / 'no'
  disabledToolGroups: AgentPresetToolGroup[] // 空数组 = 全部可用
  disabledTools: string[] // 禁用的单工具短名
  basePresetId: string // '' = 独立预设 / 内置预设 ID = 派生
}

/** 产品内置工具组选项（预设可禁用） */
const TOOL_GROUP_OPTIONS: Array<{ value: AgentPresetToolGroup; label: string; hint: string }> = [
  { value: 'task-graph', label: '任务图', hint: 'proma_task_* 子任务图工具' },
  { value: 'memory', label: '长期记忆', hint: 'Auto Memory 与 memory-archive' },
  { value: 'collaboration', label: '协作子 Agent', hint: '委派与协作工具（等价禁止委派）' },
  { value: 'automation', label: '定时任务', hint: 'Profer Automation 工具' },
]

/** 与运行时一致的自动映射（shared 唯一事实表）：工具组禁用 → 隐藏对应提示词段 key（含 automation） */

function presetToForm(preset: AgentPreset): PresetFormState {
  return {
    name: preset.name,
    description: preset.description,
    promptText: preset.promptSections?.join('\n\n') ?? '',
    effort: preset.effort ?? '',
    permissionMode: preset.permissionMode ?? '',
    skillSlugs: preset.skillSlugs?.join(', ') ?? '',
    mcpServerNames: preset.mcpServerNames?.join(', ') ?? '',
    allowSubagents: preset.allowSubagents === undefined ? '' : preset.allowSubagents ? 'yes' : 'no',
    disabledToolGroups: preset.disabledToolGroups ?? [],
    disabledTools: preset.disabledTools ?? [],
    basePresetId: preset.basePresetId ?? '',
  }
}

/** 逗号分隔文本 → slug 数组（去空白去空项） */
function parseSlugList(text: string): string[] {
  return text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
}

// ===== 勾选面板（Skill / MCP 白名单共用） =====

interface PickItem {
  value: string
  label: string
  hint?: string
  /** 工作区层已停用的项（白名单选了也不生效，仅标注） */
  disabled?: boolean
}

interface PickListProps {
  items: PickItem[]
  selected: Set<string>
  searchable?: boolean
  emptyHint: string
  onToggle: (value: string) => void
  onSelectAll: () => void
  onClear: () => void
}

/** 可搜索的多选列表：chip 平铺勾选（免长列表滚动），顶部带已选计数与全选/清空 */
function PickList({ items, selected, searchable, emptyHint, onToggle, onSelectAll, onClear }: PickListProps): React.ReactElement {
  const [filter, setFilter] = React.useState('')
  const q = filter.trim().toLowerCase()
  const visible = q ? items.filter((i) => (i.label + i.value + (i.hint ?? '')).toLowerCase().includes(q)) : items
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
          <span className="text-[10px] text-muted-foreground">已选 {selected.size} / {items.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onSelectAll}>全选</Button>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onClear}>清空</Button>
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto scrollbar-thin">
        {visible.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">{emptyHint}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 p-1">
            {visible.map((item) => {
              const checked = selected.has(item.value)
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => onToggle(item.value)}
                  title={`${item.value}${item.hint ? ` · ${item.hint}` : ''}`}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
                    checked
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border/80 text-foreground/75 hover:bg-foreground/[0.04]',
                    item.disabled && !checked && 'opacity-45',
                  )}
                >
                  {checked && <Check size={11} strokeWidth={3} />}
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function AgentPresetSettings({ workspaceSlug, search = '' }: { workspaceSlug?: string; search?: string }): React.ReactElement {
  const [presets, setPresets] = useAtom(workspacePresetsAtom(workspaceSlug))
  // 与 Skills/MCP 相同的刷新信号：预设写操作后 bump，通知会话工具栏等订阅方重拉
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)
  const [defaultPresetId, setDefaultPresetId] = React.useState<string>('')
  const [editing, setEditing] = React.useState<AgentPreset | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [form, setForm] = React.useState<PresetFormState>(presetToForm({ name: '', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 } as AgentPreset))
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  // 导出/导入文件操作的结果提示（头部按钮下方展示，几秒后自动消失）
  const [fileNotice, setFileNotice] = React.useState('')
  const [fileBusy, setFileBusy] = React.useState(false)
  // 勾选面板数据源：当前工作区的 Skills 与 MCP 列表（打开对话框时拉取）
  const [availableSkills, setAvailableSkills] = React.useState<SkillMeta[]>([])
  const [availableMcpServers, setAvailableMcpServers] = React.useState<Array<{ name: string; enabled: boolean }>>([])

  const dialogOpen = creating || editing !== null

  React.useEffect(() => {
    if (!dialogOpen || !workspaceSlug) return
    void (async () => {
      try {
        const [skills, mcp] = await Promise.all([
          window.electronAPI.getWorkspaceSkills(workspaceSlug),
          window.electronAPI.getWorkspaceMcpConfig(workspaceSlug),
        ])
        setAvailableSkills(skills)
        setAvailableMcpServers(Object.entries(mcp.servers).map(([name, entry]) => ({ name, enabled: !!entry.enabled })))
      } catch (err) {
        console.error('[预设设置] 加载 Skill/MCP 列表失败:', err)
      }
    })()
  }, [dialogOpen, workspaceSlug])

  // 白名单勾选集合（文本字段为真源，面板为其视图）
  const selectedSkillSlugs = React.useMemo(() => new Set(parseSlugList(form.skillSlugs)), [form.skillSlugs])
  const selectedMcpNames = React.useMemo(() => new Set(parseSlugList(form.mcpServerNames)), [form.mcpServerNames])

  const toggleSkillSlug = React.useCallback((slug: string) => {
    setForm((f) => {
      const next = new Set(parseSlugList(f.skillSlugs))
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return { ...f, skillSlugs: [...next].join(', ') }
    })
  }, [])

  const toggleMcpName = React.useCallback((name: string) => {
    setForm((f) => {
      const next = new Set(parseSlugList(f.mcpServerNames))
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { ...f, mcpServerNames: [...next].join(', ') }
    })
  }, [])

  /** 单工具裁剪勾选：已选 = 禁用该工具（短名，与 shared 事实表一致） */
  const toggleDisabledTool = React.useCallback((toolName: string) => {
    setForm((f) => ({
      ...f,
      disabledTools: f.disabledTools.includes(toolName)
        ? f.disabledTools.filter((t) => t !== toolName)
        : [...f.disabledTools, toolName],
    }))
  }, [])

  const reload = React.useCallback(async () => {
    try {
      const [list, defaultId] = await Promise.all([
        window.electronAPI.listAgentPresets(workspaceSlug),
        window.electronAPI.getDefaultAgentPreset(workspaceSlug),
      ])
      setPresets(list)
      setDefaultPresetId(defaultId)
    } catch (err) {
      console.error('[预设设置] 加载失败:', err)
    }
  }, [setPresets, workspaceSlug])

  // 搜索过滤：名称 / 描述 / 提示词段 / Skill 白名单 / MCP 白名单
  const q = search.trim().toLowerCase()
  const filteredPresets = React.useMemo(() => {
    if (!q) return presets
    return presets.filter((p) => {
      const haystack = [
        p.name,
        p.description,
        ...(p.promptSections ?? []),
        ...(p.skillSlugs ?? []),
        ...(p.mcpServerNames ?? []),
      ].join('\n').toLowerCase()
      return haystack.includes(q)
    })
  }, [presets, q])

  React.useEffect(() => { void reload() }, [reload, capabilitiesVersion])

  const openCreate = React.useCallback(() => {
    setError('')
    setForm({ name: '', description: '', promptText: '', effort: '', permissionMode: '', skillSlugs: '', mcpServerNames: '', allowSubagents: '', disabledToolGroups: [], disabledTools: [], basePresetId: '' })
    setCreating(true)
  }, [])

  const openEdit = React.useCallback((preset: AgentPreset) => {
    setError('')
    setForm(presetToForm(preset))
    setEditing(preset)
  }, [])

  /**
   * 更新输入：始终传全量字段，null = 清除（manager 支持）；
   * suppressPromptSections 按工具组自动映射，保证提示词与工具一致。
   */
  const buildUpdateInput = React.useCallback((): AgentPresetUpdateInput => {
    const promptSections = form.promptText.trim()
      ? form.promptText.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
      : null
    const suppressPromptSections = form.disabledToolGroups.map((g) => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[g])
    return {
      name: form.name,
      description: form.description,
      promptSections,
      suppressPromptSections: suppressPromptSections.length > 0 ? suppressPromptSections : null,
      disabledToolGroups: form.disabledToolGroups.length > 0 ? form.disabledToolGroups : null,
      disabledTools: form.disabledTools.length > 0 ? form.disabledTools : null,
      effort: (form.effort || null) as AgentEffort | null,
      permissionMode: (form.permissionMode || null) as ProferPermissionMode | null,
      skillSlugs: form.skillSlugs.trim() ? parseSlugList(form.skillSlugs) : null,
      mcpServerNames: form.mcpServerNames.trim() ? parseSlugList(form.mcpServerNames) : null,
      allowSubagents: form.allowSubagents ? form.allowSubagents === 'yes' : null,
      // 派生基座：选内置=设置（切换）；留空=null（脱离基座，manager 冻结当前生效配置）
      basePresetId: form.basePresetId || null,
    }
  }, [form])

  /** 创建输入：从全量输入剔除 null（manager 创建时 null 表示未设置） */
  const buildCreateInput = React.useCallback((): AgentPresetCreateInput => {
    const u = buildUpdateInput()
    return {
      name: u.name ?? '',
      description: u.description ?? '',
      ...(u.promptSections && { promptSections: u.promptSections }),
      ...(u.suppressPromptSections && { suppressPromptSections: u.suppressPromptSections }),
      ...(u.disabledToolGroups && { disabledToolGroups: u.disabledToolGroups }),
      ...(u.disabledTools && { disabledTools: u.disabledTools }),
      ...(u.effort && { effort: u.effort }),
      ...(u.permissionMode && { permissionMode: u.permissionMode }),
      ...(u.skillSlugs && { skillSlugs: u.skillSlugs }),
      ...(u.mcpServerNames && { mcpServerNames: u.mcpServerNames }),
      ...(u.allowSubagents !== null && u.allowSubagents !== undefined && { allowSubagents: u.allowSubagents }),
      ...(form.basePresetId && { basePresetId: form.basePresetId }),
    }
  }, [buildUpdateInput, form.basePresetId])

  const handleSave = React.useCallback(async () => {
    if (!form.name.trim()) {
      setError('预设名称不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (!workspaceSlug) {
        setError('预设管理需要选择工作区')
        return
      }
      if (editing) {
        await window.electronAPI.updateAgentPreset(workspaceSlug, editing.id, buildUpdateInput())
        setEditing(null)
      } else {
        await window.electronAPI.createAgentPreset(workspaceSlug, buildCreateInput())
        setCreating(false)
      }
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 保存失败:', err)
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [editing, form.name, buildUpdateInput, buildCreateInput, workspaceSlug, reload, bumpCapabilities])

  const handleCopy = React.useCallback(async (preset: AgentPreset) => {
    if (!workspaceSlug) return
    try {
      await window.electronAPI.copyAgentPreset(workspaceSlug, preset.id)
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 复制失败:', err)
    }
  }, [workspaceSlug, reload, bumpCapabilities])

  const handleDelete = React.useCallback(async (preset: AgentPreset) => {
    if (!workspaceSlug) return
    try {
      await window.electronAPI.deleteAgentPreset(workspaceSlug, preset.id)
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 删除失败:', err)
    }
  }, [workspaceSlug, reload, bumpCapabilities])

  const handleSetDefault = React.useCallback(async (preset: AgentPreset) => {
    if (!workspaceSlug) return
    try {
      const id = await window.electronAPI.setDefaultAgentPreset(workspaceSlug, preset.id)
      setDefaultPresetId(id)
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 设默认失败:', err)
    }
  }, [workspaceSlug, bumpCapabilities])

  /** 导出全部预设为 JSON 文件（保存对话框由主进程弹出；取消则静默） */
  const handleExport = React.useCallback(async () => {
    if (!workspaceSlug) return
    setFileBusy(true)
    setFileNotice('')
    try {
      const result = await window.electronAPI.exportAgentPresets(workspaceSlug)
      if (result) {
        setFileNotice(`已导出 ${result.count} 个预设：${result.filePath}`)
      }
    } catch (err) {
      console.error('[预设设置] 导出失败:', err)
      setFileNotice(err instanceof Error ? `导出失败：${err.message}` : '导出失败')
    } finally {
      setFileBusy(false)
    }
  }, [workspaceSlug])

  /** 从 JSON 文件导入预设（打开对话框由主进程弹出；取消则静默） */
  const handleImport = React.useCallback(async () => {
    if (!workspaceSlug) return
    setFileBusy(true)
    setFileNotice('')
    try {
      const result = await window.electronAPI.importAgentPresets(workspaceSlug)
      if (result) {
        const renamed = result.renamedNames.length > 0
          ? `（重名自动改名的预设：${result.renamedNames.join(' / ')}）`
          : ''
        setFileNotice(`已导入 ${result.imported.length} 个预设${renamed}`)
        await reload()
        bumpCapabilities((v) => v + 1)
      }
    } catch (err) {
      console.error('[预设设置] 导入失败:', err)
      setFileNotice(err instanceof Error ? `导入失败：${err.message}` : '导入失败')
    } finally {
      setFileBusy(false)
    }
  }, [workspaceSlug, reload, bumpCapabilities])

  const formTitle = editing ? `编辑预设 · ${editing.name}` : '新建预设'

  const skillItems = React.useMemo<PickItem[]>(() =>
    availableSkills.map((s) => ({ value: s.slug, label: s.name, hint: s.enabled ? s.slug : `${s.slug} · 未启用（需在 Skills 页启用）`, disabled: !s.enabled })), [availableSkills])

  const mcpItems = React.useMemo<PickItem[]>(() =>
    availableMcpServers.map((m) => ({ value: m.name, label: m.name, hint: m.enabled ? '已启用' : '未启用', disabled: !m.enabled })), [availableMcpServers])

  return (
    <SettingsSection title="Agent 预设" description="预设 = 岗位 + 工作环境：把提示词、推理档位、权限模式、Skill/MCP 白名单与能力裁剪组合成可复用配置。预设为工作区级配置，可跨工作区导入；会话内可随时切换（下一轮消息完整生效），星标为新建会话的默认预设。">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={handleExport} disabled={fileBusy} title="把预设导出为 JSON 文件，便于跨机器分享">
          <Download size={14} />
          <span>导出</span>
        </Button>
        <Button size="sm" variant="outline" onClick={handleImport} disabled={fileBusy} title="从 Profer 预设 JSON 文件导入">
          <Upload size={14} />
          <span>导入</span>
        </Button>
        <Button size="sm" variant="outline" onClick={openCreate}>
          <Plus size={14} />
          <span>新建预设</span>
        </Button>
      </div>
      {fileNotice && (
        <p className="text-right text-xs text-muted-foreground break-all">{fileNotice}</p>
      )}
      <SettingsCard divided>
        {presets.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">加载中…</div>
        )}
        {presets.length > 0 && filteredPresets.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">没有匹配的预设，试试更换搜索关键词。</div>
        )}
        {filteredPresets.map((preset) => {
          const isDefault = preset.id === defaultPresetId
          const baseName = preset.basePresetId
            ? presets.find((p) => p.id === preset.basePresetId)?.name
            : undefined
          return (
            <div key={preset.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{preset.name}</span>
                  {preset.isBuiltin && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">内置</span>
                  )}
                  {!preset.isBuiltin && preset.basePresetId && (
                    <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400 shrink-0" title="派生预设只存差异，基座内置升级自动跟随">
                      基于「{baseName ?? preset.basePresetId}」
                    </span>
                  )}
                  {isDefault && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary shrink-0">默认</span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{preset.description}</p>
                {(preset.skillSlugs || preset.mcpServerNames || preset.effort || preset.permissionMode || preset.disabledToolGroups || preset.disabledTools || preset.allowSubagents !== undefined) && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {preset.effort && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">强度 {preset.effort}</span>}
                    {preset.permissionMode && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">权限 {preset.permissionMode}</span>}
                    {preset.skillSlugs && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">Skill×{preset.skillSlugs.length}</span>}
                    {preset.mcpServerNames && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">MCP×{preset.mcpServerNames.length}</span>}
                    {preset.promptSections && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">提示词段×{preset.promptSections.length}</span>}
                    {preset.allowSubagents === false && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/60">无委派</span>}
                    {preset.disabledToolGroups && <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">精简×{preset.disabledToolGroups.length}</span>}
                    {preset.disabledTools && <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">禁工具×{preset.disabledTools.length}</span>}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="icon" variant="ghost" className="size-8" onClick={() => handleSetDefault(preset)} title="设为默认">
                  <Star className={cn('size-4', isDefault ? 'fill-primary text-primary' : 'text-foreground/50')} />
                </Button>
                <Button size="icon" variant="ghost" className="size-8" onClick={() => handleCopy(preset)} title="复制">
                  <Copy className="size-4 text-foreground/60" />
                </Button>
                {!preset.isBuiltin && (
                  <>
                    <Button size="icon" variant="ghost" className="size-8" onClick={() => openEdit(preset)} title="编辑">
                      <Pencil className="size-4 text-foreground/60" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8 hover:text-destructive" onClick={() => handleDelete(preset)} title="删除">
                      <Trash2 className="size-4 text-foreground/60" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </SettingsCard>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) { setCreating(false); setEditing(null); setError('') } }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-thin sm:max-w-[680px]">
          <DialogHeader>
            <DialogTitle>{formTitle}</DialogTitle>
            <DialogDescription>
              提示词段之间用空行分隔。Skill / MCP 白名单在下方勾选（留空 = 不限制，工作区全部可用）。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground/70">名称 *</label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：研究模式" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground/70">描述</label>
                <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="一句话说明这个岗位" />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground/70">派生基座（可选）</label>
              <Select value={form.basePresetId} onValueChange={(v) => setForm((f) => ({ ...f, basePresetId: v }))}>
                <SelectTrigger><SelectValue placeholder="独立预设（不基于内置预设）" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">独立预设（不基于内置预设）</SelectItem>
                  <SelectItem value="standard">基于「标准」</SelectItem>
                  <SelectItem value="code">基于「代码」</SelectItem>
                  <SelectItem value="minimal">基于「极简」</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                派生预设只存储与基座的差异：内置预设升级（提示词段/能力裁剪调整）会自动跟随；表格中的字段仍可覆盖或追加。
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground/70">提示词段（追加到系统提示词）</label>
              <Textarea
                value={form.promptText}
                onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
                placeholder={'## 研究模式\n\n本会话专注调研，只读不写……'}
                rows={5}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground/70">推理强度</label>
                <Select value={form.effort} onValueChange={(v) => setForm((f) => ({ ...f, effort: v }))}>
                  <SelectTrigger><SelectValue placeholder="跟随全局设置" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">跟随全局设置</SelectItem>
                    <SelectItem value="low">低</SelectItem>
                    <SelectItem value="medium">中</SelectItem>
                    <SelectItem value="high">高</SelectItem>
                    <SelectItem value="max">最大</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground/70">权限模式</label>
                <Select value={form.permissionMode} onValueChange={(v) => setForm((f) => ({ ...f, permissionMode: v }))}>
                  <SelectTrigger><SelectValue placeholder="跟随会话默认" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">跟随会话默认</SelectItem>
                    <SelectItem value="auto">自动审批</SelectItem>
                    <SelectItem value="bypassPermissions">完全自动</SelectItem>
                    <SelectItem value="plan">计划模式</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground/70">Skill 白名单（留空 = 全部可用）</label>
                <PickList
                  items={skillItems}
                  selected={selectedSkillSlugs}
                  searchable
                  emptyHint={workspaceSlug ? '当前工作区暂无 Skill' : '需要选择工作区'}
                  onToggle={toggleSkillSlug}
                  onSelectAll={() => setForm((f) => ({ ...f, skillSlugs: availableSkills.map((s) => s.slug).join(', ') }))}
                  onClear={() => setForm((f) => ({ ...f, skillSlugs: '' }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground/70">MCP 白名单（留空 = 全部可用）</label>
                <PickList
                  items={mcpItems}
                  selected={selectedMcpNames}
                  emptyHint={workspaceSlug ? '当前工作区暂无 MCP' : '需要选择工作区'}
                  onToggle={toggleMcpName}
                  onSelectAll={() => setForm((f) => ({ ...f, mcpServerNames: availableMcpServers.map((m) => m.name).join(', ') }))}
                  onClear={() => setForm((f) => ({ ...f, mcpServerNames: '' }))}
                />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">白名单按名尽力匹配：预设里选了但工作区没有的项会自动忽略；标注「未启用」的项需先在 Skills/MCP 页启用。</p>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground/70">子 Agent 委派</label>
              <Select value={form.allowSubagents} onValueChange={(v) => setForm((f) => ({ ...f, allowSubagents: v }))}>
                <SelectTrigger><SelectValue placeholder="跟随默认策略" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">跟随默认策略</SelectItem>
                  <SelectItem value="yes">允许委派</SelectItem>
                  <SelectItem value="no">禁止委派</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground/70">精简能力（禁用产品内置工具组 / 单个工具）</label>
              <div className="flex flex-col gap-2 rounded-md border p-3">
                {TOOL_GROUP_OPTIONS.map((group) => {
                  const groupDisabled = form.disabledToolGroups.includes(group.value)
                  const groupTools = AGENT_PRESET_GROUP_TOOL_NAMES[group.value]
                  return (
                    <div key={group.value} className="flex flex-col gap-1.5">
                      <label className="flex cursor-pointer items-center justify-between gap-2 select-none">
                        <span className="flex min-w-0 flex-col">
                          <span className="text-xs">{group.label}</span>
                          <span className="truncate text-[10px] text-muted-foreground">{group.hint}</span>
                        </span>
                        <Switch
                          checked={groupDisabled}
                          onCheckedChange={(on) => setForm((f) => ({
                            ...f,
                            disabledToolGroups: on
                              ? [...f.disabledToolGroups, group.value]
                              : f.disabledToolGroups.filter((g) => g !== group.value),
                          }))}
                          className="scale-90 shrink-0"
                        />
                      </label>
                      {!groupDisabled && (
                        <details className="ml-1 border-l-2 border-border/60 pl-3">
                          <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground/80">
                            单工具裁剪（已禁 {form.disabledTools.filter((t) => (groupTools as readonly string[]).includes(t)).length} / {groupTools.length}）
                          </summary>
                          <div className="flex flex-wrap gap-1.5 pt-1.5">
                            {groupTools.map((toolName) => {
                              const checked = form.disabledTools.includes(toolName)
                              return (
                                <button
                                  key={toolName}
                                  type="button"
                                  onClick={() => toggleDisabledTool(toolName)}
                                  title={checked ? `已禁用 ${toolName}` : `禁用 ${toolName}`}
                                  className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors',
                                    checked
                                      ? 'border-destructive/60 bg-destructive/10 text-destructive'
                                      : 'border-border/80 text-foreground/70 hover:bg-foreground/[0.04]',
                                  )}
                                >
                                  {checked && <Check size={10} strokeWidth={3} />}
                                  <span>{toolName}</span>
                                </button>
                              )
                            })}
                          </div>
                        </details>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">禁用后对应工具不再注入，相关提示词段落自动隐藏（任务图/记忆/协作/定时任务）。组已整体禁用时无需再逐个勾选单工具；全部关 = 完整能力。</p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreating(false); setEditing(null); setError('') }}>取消</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
