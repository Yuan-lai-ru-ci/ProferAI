/**
 * AgentPresetSettings — 「Agent 技能」视图的「预设」tab 管理区块
 *
 * 内置预设只读可复制；自定义预设可编辑/删除；任意预设可设为默认（新建会话使用）。
 * 编辑表单覆盖五类能力：提示词段、推理档位、权限模式、Skill 白名单、MCP 白名单。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Plus, Copy, Pencil, Trash2, Star, Check, Download, Upload, ShieldCheck, SlidersHorizontal, Sparkles, BrainCircuit, LockKeyhole, Wrench, Layers3, ArrowRight } from 'lucide-react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { GlobalPresetScopePanel } from './GlobalPresetScopePanel'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { AgentWorkspace, PresetReferenceReport, PresetWorkspaceReference } from '@profer/shared'

function BuiltinPresetTag(): React.ReactElement {
  return <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300"><ShieldCheck size={11} />Profer 内置</span>
}

type PresetSortMode = 'default' | 'alpha' | 'updated'

const PRESET_SORT_STORAGE_KEYS: Record<'workspace' | 'global', string> = {
  workspace: 'profer.agent-presets.sort.workspace',
  global: 'profer.agent-presets.sort.global',
}

const PRESET_SORT_OPTIONS: Array<{ value: PresetSortMode; label: string }> = [
  { value: 'default', label: '默认排序' },
  { value: 'alpha', label: '按字母排序' },
  { value: 'updated', label: '按修改时间排序' },
]

function readPresetSortMode(scope: 'workspace' | 'global'): PresetSortMode {
  try {
    if (typeof window === 'undefined') return 'default'
    const saved = window.localStorage.getItem(PRESET_SORT_STORAGE_KEYS[scope])
    return saved === 'alpha' || saved === 'updated' ? saved : 'default'
  } catch {
    return 'default'
  }
}

import type { AgentPreset, AgentPresetCreateInput, AgentPresetUpdateInput, AgentPresetToolGroup, AgentEffort, ProferPermissionMode, SkillMeta } from '@profer/shared'
import { AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP, AGENT_PRESET_CAPABILITY_GROUPS } from '@profer/shared'
import type { AgentPresetSuppressKey } from '@profer/shared'

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

/** 产品内置能力组选项直接来自 shared registry，避免 UI 与运行时清单漂移。 */
/** Radix Select 保留空字符串给 placeholder，表单的“跟随/独立”状态使用非空哨兵值。 */
const SELECT_DEFAULT_VALUE = '__default__'

const TOOL_GROUP_OPTIONS = AGENT_PRESET_CAPABILITY_GROUPS

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
    <div className="rounded-xl bg-muted/35 p-3 ring-1 ring-border/45">
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
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onClear}>清空（全部禁用）</Button>
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
                    'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-all',
                    checked
                      ? 'border-primary/45 bg-primary/12 text-primary shadow-sm'
                      : 'border-border/70 bg-background/60 text-foreground/75 hover:-translate-y-px hover:border-primary/30 hover:bg-background',
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

function EditorSection({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }): React.ReactElement {
  return (
    <section className="rounded-xl bg-muted/20 p-3.5 ring-1 ring-border/45">
      <div className="mb-3 flex items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div>
        <div className="min-w-0"><h3 className="text-xs font-semibold text-foreground">{title}</h3><p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{description}</p></div>
      </div>
      {children}
    </section>
  )
}

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }): React.ReactElement {
  return <div className="mb-1.5 flex items-baseline justify-between gap-2"><label className="text-xs font-semibold text-foreground/80">{children}</label>{hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}</div>
}

export function AgentPresetSettings({ workspaceSlug, search = '', globalMode = false, onlyEffective = false, onPromote, onOpenGlobalConfig }: { workspaceSlug?: string; search?: string; globalMode?: boolean; onlyEffective?: boolean; onPromote?: (preset: AgentPreset) => void; onOpenGlobalConfig?: () => void }): React.ReactElement {
  const [workspacePresets, setWorkspacePresets] = useAtom(workspacePresetsAtom(workspaceSlug))
  const [globalPresets, setGlobalPresets] = React.useState<AgentPreset[]>([])
  const presets = globalMode ? globalPresets : workspacePresets
  const sortScope = globalMode ? 'global' : 'workspace'
  const [sortMode, setSortMode] = React.useState<PresetSortMode>(() => readPresetSortMode(sortScope))
  const [loading, setLoading] = React.useState(true)
  const [toggleBusy, setToggleBusy] = React.useState<Set<string>>(new Set())
  // 与 Skills/MCP 相同的刷新信号：预设写操作后 bump，通知会话工具栏等订阅方重拉
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)
  const [defaultPresetId, setDefaultPresetId] = React.useState<string>('')
  const [editing, setEditing] = React.useState<AgentPreset | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [form, setForm] = React.useState<PresetFormState>(presetToForm({ name: '', description: '', isBuiltin: false, createdAt: 0, updatedAt: 0 } as AgentPreset))
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [pendingGlobalDelete, setPendingGlobalDelete] = React.useState<AgentPreset | null>(null)
  const [globalDeleteReport, setGlobalDeleteReport] = React.useState<PresetReferenceReport | null>(null)
  const [globalDeleteBusy, setGlobalDeleteBusy] = React.useState(false)
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

  React.useEffect(() => {
    setSortMode(readPresetSortMode(sortScope))
  }, [sortScope])

  const handleSortChange = React.useCallback((value: PresetSortMode) => {
    setSortMode(value)
    try { window.localStorage.setItem(PRESET_SORT_STORAGE_KEYS[sortScope], value) } catch { /* 本地存储不可用时仍保留本次会话选择 */ }
  }, [sortScope])

  const reload = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true)
    try {
      const list = globalMode
        ? await window.electronAPI.listGlobalAgentPresets()
        : await window.electronAPI.listAgentPresets(workspaceSlug, true)
      if (globalMode) {
        setGlobalPresets(list)
        setDefaultPresetId('')
      } else {
        setWorkspacePresets(list)
        setDefaultPresetId(await window.electronAPI.getDefaultAgentPreset(workspaceSlug))
      }
    } catch (err) {
      console.error('[预设设置] 加载失败:', err)
    } finally {
      if (!options?.silent) setLoading(false)
    }
  }, [globalMode, setWorkspacePresets, workspaceSlug])

  // 搜索过滤：名称 / 描述 / 提示词段 / Skill 白名单 / MCP 白名单
  const q = search.trim().toLowerCase()
  const filteredPresets = React.useMemo(() => {
    const scoped = globalMode || !onlyEffective ? presets : presets.filter((preset) => preset.scope === 'workspace' || preset.enabledInWorkspace === true)
    const defaultOrder = new Map(presets.map((preset, index) => [preset.id, index]))
    const compare = (a: AgentPreset, b: AgentPreset): number => {
      if (sortMode === 'alpha') {
        const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        if (byName !== 0) return byName
        const byScope = (a.scope ?? 'workspace').localeCompare(b.scope ?? 'workspace')
        return byScope !== 0 ? byScope : a.id.localeCompare(b.id)
      }
      if (sortMode === 'updated') {
        const byUpdated = (b.updatedAt || 0) - (a.updatedAt || 0)
        return byUpdated !== 0 ? byUpdated : (defaultOrder.get(a.id) ?? 0) - (defaultOrder.get(b.id) ?? 0)
      }
      return (defaultOrder.get(a.id) ?? 0) - (defaultOrder.get(b.id) ?? 0)
    }
    const sorted = [...scoped].sort(compare)
    if (!q) return sorted
    return sorted.filter((p) => {
      const haystack = [
        p.name,
        p.description,
        ...(p.promptSections ?? []),
        ...(p.skillSlugs ?? []),
        ...(p.mcpServerNames ?? []),
      ].join('\n').toLowerCase()
      return haystack.includes(q)
    })
  }, [globalMode, onlyEffective, presets, q, sortMode])

  // 首次进入/切换工作区时显示加载态；能力开关等外部刷新沿用当前列表，避免整页白屏和滚动位置跳动。
  React.useEffect(() => { void reload() }, [reload])
  React.useEffect(() => {
    if (capabilitiesVersion > 0) void reload({ silent: true })
  }, [capabilitiesVersion, reload])

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
    const suppressPromptSections = form.disabledToolGroups
      .map((g) => AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP[g])
      .filter((key): key is AgentPresetSuppressKey => key !== undefined)
    return {
      name: form.name,
      description: form.description,
      promptSections,
      suppressPromptSections: suppressPromptSections.length > 0 ? suppressPromptSections : null,
      disabledToolGroups: form.disabledToolGroups.length > 0 ? form.disabledToolGroups : null,
      disabledTools: form.disabledTools.length > 0 ? form.disabledTools : null,
      effort: (form.effort || null) as AgentEffort | null,
      permissionMode: (form.permissionMode || null) as ProferPermissionMode | null,
      // 白名单必须显式保存：空数组表示不注入，只有「全选」才是全部可用。
      skillSlugs: parseSlugList(form.skillSlugs),
      mcpServerNames: parseSlugList(form.mcpServerNames),
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
      if (globalMode) {
        if (editing) {
          await window.electronAPI.updateGlobalAgentPreset(editing.id, buildUpdateInput())
          setEditing(null)
        } else {
          await window.electronAPI.createGlobalAgentPreset(buildCreateInput())
          setCreating(false)
        }
      } else {
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
      }
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 保存失败:', err)
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [editing, form.name, buildUpdateInput, buildCreateInput, globalMode, workspaceSlug, reload, bumpCapabilities])

  const handleCopy = React.useCallback(async (preset: AgentPreset) => {
    if (!workspaceSlug || globalMode) return
    try {
      await window.electronAPI.copyAgentPreset(workspaceSlug, preset.id)
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 复制失败:', err)
    }
  }, [globalMode, workspaceSlug, reload, bumpCapabilities])

  const handleDelete = React.useCallback(async (preset: AgentPreset) => {
    try {
      if (globalMode) {
        const report = await window.electronAPI.getPresetReferenceReport({ presetId: preset.id, presetScope: preset.scope ?? 'user-global' })
        setGlobalDeleteReport(report)
        if (report.canDelete) setPendingGlobalDelete(preset)
        else {
          const message = `无法删除「${preset.name}」：仍有 ${report.totalCount} 个有效引用，请先解除对应工作区范围。`
          setError(message)
          toast.error(message)
        }
        return
      }
      if (!workspaceSlug) return
      await window.electronAPI.deleteAgentPreset(workspaceSlug, preset.id)
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 删除失败:', err)
      const message = err instanceof Error ? err.message : '删除失败'
      setError(message)
      toast.error(message)
    }
  }, [globalMode, workspaceSlug, reload, bumpCapabilities])

  const confirmGlobalDelete = React.useCallback(async () => {
    if (!pendingGlobalDelete) return
    setGlobalDeleteBusy(true)
    try {
      await window.electronAPI.deleteGlobalAgentPreset({ presetId: pendingGlobalDelete.id, presetScope: pendingGlobalDelete.scope ?? 'user-global' })
      setPendingGlobalDelete(null)
      setGlobalDeleteReport(null)
      setError('')
      await reload()
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setGlobalDeleteBusy(false)
    }
  }, [pendingGlobalDelete, reload, bumpCapabilities])

  const handleTogglePreset = React.useCallback(async (preset: AgentPreset, enabled: boolean) => {
    if (!workspaceSlug) return
    const busyId = preset.id
    if (enabled) {
      const counterpart = presets.find((candidate) => candidate.id !== preset.id && candidate.name === preset.name && candidate.scope !== preset.scope && candidate.enabledInWorkspace !== false)
      if (counterpart && !window.confirm('当前工作区同时存在同名的工作区预设与全局/元预设，同时启用可能导致配置重复或行为冲突，不推荐这样使用。是否仍要继续启用？')) return
    }
    const previousEnabled = preset.scope === 'workspace' ? preset.enabledInWorkspace !== false : preset.enabledInWorkspace === true
    setToggleBusy((previous) => new Set(previous).add(busyId))
    const updateList = (items: AgentPreset[], nextEnabled: boolean): AgentPreset[] => items.map((item) => item.id === preset.id ? { ...item, enabledInWorkspace: nextEnabled } : item)
    if (!globalMode) setWorkspacePresets(updateList(workspacePresets, enabled))
    else setGlobalPresets(updateList(globalPresets, enabled))
    try {
      if (preset.scope === 'workspace') {
        await window.electronAPI.setWorkspacePresetEnabled(workspaceSlug, preset.id, enabled)
      } else {
        const reference = { presetId: preset.id, presetScope: preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'user-global') } as const
        if (enabled) await window.electronAPI.enableGlobalPresetInWorkspace(workspaceSlug, reference)
        else await window.electronAPI.disableGlobalPresetInWorkspace(workspaceSlug, reference)
      }
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 切换预设生效状态失败:', err)
      if (globalMode) setGlobalPresets(updateList(globalPresets, previousEnabled))
      else setWorkspacePresets(updateList(workspacePresets, previousEnabled))
      toast.error(err instanceof Error ? err.message : '切换预设生效状态失败')
    } finally {
      setToggleBusy((previous) => { const next = new Set(previous); next.delete(busyId); return next })
    }
  }, [bumpCapabilities, globalMode, globalPresets, setGlobalPresets, setWorkspacePresets, workspacePresets, workspaceSlug])

  const handleCopyToWorkspace = React.useCallback(async (preset: AgentPreset) => {
    if (!workspaceSlug || preset.scope === 'workspace') return
    try {
      await window.electronAPI.copyPresetToWorkspace({ presetId: preset.id, presetScope: preset.scope ?? (preset.isBuiltin ? 'builtin-meta' : 'user-global') }, workspaceSlug)
      await reload({ silent: true })
      bumpCapabilities((v) => v + 1)
      toast.success(`已复制「${preset.name}」到当前工作区`)
    } catch (err) {
      console.error('[预设设置] 复制到工作区失败:', err)
      toast.error(err instanceof Error ? err.message : '复制到工作区失败')
    }
  }, [bumpCapabilities, globalMode, reload, workspaceSlug])

  const handleSetDefault = React.useCallback(async (preset: AgentPreset) => {
    if (!workspaceSlug || globalMode) return
    try {
      const id = await window.electronAPI.setDefaultAgentPreset(workspaceSlug, defaultPresetId === preset.id ? '' : preset.id)
      setDefaultPresetId(id)
      bumpCapabilities((v) => v + 1)
    } catch (err) {
      console.error('[预设设置] 设默认失败:', err)
    }
  }, [defaultPresetId, globalMode, workspaceSlug, bumpCapabilities])

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
    <SettingsSection title={globalMode ? '全局预设' : 'Agent 预设'} description="把提示词、模型策略与工具能力组合成可复用的工作模式。会话内可随时切换，星标预设将用于新建会话。">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/35 p-2 ring-1 ring-border/40">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-background text-primary shadow-sm ring-1 ring-border/40"><SlidersHorizontal size={15} /></div>
          <span className="text-xs font-medium text-foreground/75">管理预设</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">按名称或最近修改时间整理</span>
          <span className="text-xs text-muted-foreground">排序</span>
          <Select value={sortMode} onValueChange={(value) => handleSortChange(value as PresetSortMode)}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRESET_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {!globalMode && onOpenGlobalConfig && <Button size="sm" variant="ghost" onClick={onOpenGlobalConfig}>全局配置</Button>}
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-8" onClick={handleExport} disabled={fileBusy} title="把预设导出为 JSON 文件，便于跨机器分享">
          <Download size={14} />
          <span>导出</span>
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={handleImport} disabled={fileBusy} title="从 Profer 预设 JSON 文件导入">
          <Upload size={14} />
          <span>导入</span>
        </Button>
        <Button size="sm" className="h-8 shadow-sm" onClick={openCreate}>
          <Plus size={14} />
          <span>{globalMode ? '新建全局预设' : '新建预设'}</span>
        </Button>
        </div>
      </div>
      {fileNotice && (
        <p className="text-right text-xs text-muted-foreground break-all">{fileNotice}</p>
      )}
      <SettingsCard divided={false} className="overflow-hidden bg-card/80 shadow-sm ring-1 ring-border/50">
        {presets.length === 0 && loading && (
          <div className="p-4 text-sm text-muted-foreground">加载中…</div>
        )}
        {!loading && presets.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">暂无预设。</div>
        )}
        {!loading && presets.length > 0 && filteredPresets.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">没有匹配的预设，试试更换搜索关键词。</div>
        )}
        {(['workspace', 'user-global', 'builtin-meta'] as const).map((scope) => {
          const sectionPresets = filteredPresets.filter((preset) => globalMode ? (scope === 'user-global' ? preset.scope === 'user-global' : scope === 'builtin-meta' ? preset.scope === 'builtin-meta' : false) : preset.scope === scope)
          if (sectionPresets.length === 0) return null
          const sectionTitle = scope === 'workspace' ? '工作区预设' : scope === 'user-global' ? '全局预设' : '元预设'
          return <React.Fragment key={scope}><div className="flex items-center gap-2 border-t border-border/50 bg-muted/25 px-4 py-2.5 first:border-t-0"><span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{sectionTitle}</span><span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground shadow-sm ring-1 ring-border/40">{sectionPresets.length}</span></div>{sectionPresets.map((preset) => {
          const isDefault = preset.id === defaultPresetId
          const baseName = preset.basePresetId
            ? presets.find((p) => p.id === preset.basePresetId)?.name
            : undefined
          return (
            <div key={preset.id} className={cn('group flex items-center justify-between gap-4 p-4 transition-colors hover:bg-muted/25', globalMode && 'cursor-pointer')} onClick={globalMode ? () => openEdit(preset) : undefined}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles size={15} /></div>
                  <span className="truncate text-sm font-semibold">{preset.name}</span>
                  {globalMode && preset.scope === 'builtin-meta' ? <BuiltinPresetTag /> : preset.isBuiltin && (
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
                  <p className="mt-2 flex flex-wrap gap-1.5">
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
                {!globalMode && <Switch checked={preset.scope === 'workspace' ? preset.enabledInWorkspace !== false : preset.enabledInWorkspace === true} disabled={toggleBusy.has(preset.id)} onCheckedChange={(enabled) => void handleTogglePreset(preset, enabled)} aria-label={`${preset.name} 在当前工作区生效`} />}
                {!globalMode && preset.scope !== 'workspace' && <Button size="icon" variant="ghost" className="size-8" onClick={(event) => { event.stopPropagation(); void handleCopyToWorkspace(preset) }} title="创建工作区副本"><Copy className="size-4 text-foreground/60" /></Button>}
                {!globalMode && preset.scope !== 'workspace' && onOpenGlobalConfig && <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-primary" onClick={(event) => { event.stopPropagation(); onOpenGlobalConfig() }} title="请打开全局配置进行编辑">编辑全局预设</Button>}
                {!globalMode && preset.scope === 'workspace' && onPromote && <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-primary" onClick={(event) => { event.stopPropagation(); onPromote(preset) }} title="提升为全局预设">提升为全局</Button>}
                {!globalMode && preset.scope === 'workspace' && <Button size="icon" variant="ghost" className="size-8" onClick={() => void handleSetDefault(preset)} title={isDefault ? '取消默认' : '设为默认'}>
                  <Star className={cn('size-4', isDefault ? 'fill-primary text-primary' : 'text-foreground/50')} />
                </Button>}
                {!globalMode && preset.scope === 'workspace' && <Button size="icon" variant="ghost" className="size-8" onClick={() => void handleCopy(preset)} title="复制">
                  <Copy className="size-4 text-foreground/60" />
                </Button>}
                {!globalMode && preset.scope === 'workspace' && !preset.isBuiltin && (
                  <>
                    <Button size="icon" variant="ghost" className="size-8" onClick={() => openEdit(preset)} title="编辑">
                      <Pencil className="size-4 text-foreground/60" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8 hover:text-destructive" onClick={() => handleDelete(preset)} title="删除">
                      <Trash2 className="size-4 text-foreground/60" />
                    </Button>
                  </>
                )}
                {globalMode && workspaceSlug && preset.scope !== 'workspace' && <Button size="icon" variant="ghost" className="size-8" onClick={(event) => { event.stopPropagation(); void handleCopyToWorkspace(preset) }} title="复制到当前工作区"><Copy className="size-4 text-foreground/60" /></Button>}
                {globalMode && preset.scope === 'user-global' && <Button size="icon" variant="ghost" className="size-8 hover:text-destructive" onClick={(event) => { event.stopPropagation(); void handleDelete(preset) }} title="删除全局预设"><Trash2 className="size-4 text-foreground/60" /></Button>}
              </div>
            </div>
          )
        })}</React.Fragment>
        })}

      </SettingsCard>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) { setCreating(false); setEditing(null); setError('') } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto bg-background/95 p-0 scrollbar-thin sm:max-w-[760px]">
          <DialogHeader className="border-b border-border/50 bg-gradient-to-br from-primary/[0.12] via-primary/[0.04] to-transparent px-6 pb-5 pt-6 pr-12">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-sm"><Sparkles size={19} /></div>
              <div><DialogTitle className="text-base">{formTitle}</DialogTitle><DialogDescription className="mt-1 text-xs">将一组提示词、模型策略和工具能力保存为可复用的工作模式。</DialogDescription></div>
            </div>
            {globalMode && editing && <GlobalPresetScopePanel preset={editing} />}
          </DialogHeader>
          {!(globalMode && editing?.scope === 'builtin-meta') && <div className="flex flex-col gap-4 p-5">
            <EditorSection icon={<Layers3 size={15} />} title="基本信息" description="给这个工作模式一个清晰的名字，方便快速识别。">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <FieldLabel>名称 *</FieldLabel>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="如：研究模式" className="bg-background/70" />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>描述</FieldLabel>
                <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="一句话说明这个岗位" className="bg-background/70" />
              </div>
            </div>
            </EditorSection>
            <EditorSection icon={<ArrowRight size={15} />} title="继承关系" description="派生预设只保存差异，内置基座升级后会自动跟随。">
              <FieldLabel hint="可选">派生基座</FieldLabel>
              <Select value={form.basePresetId || SELECT_DEFAULT_VALUE} onValueChange={(v) => setForm((f) => ({ ...f, basePresetId: v === SELECT_DEFAULT_VALUE ? '' : v }))}>
                <SelectTrigger><SelectValue placeholder="独立预设（不基于内置预设）" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_DEFAULT_VALUE}>独立预设（不基于内置预设）</SelectItem>
                  <SelectItem value="standard">基于「标准」</SelectItem>
                  <SelectItem value="code">基于「代码」</SelectItem>
                  <SelectItem value="minimal">基于「极简」</SelectItem>
                </SelectContent>
              </Select>
            </EditorSection>
            <EditorSection icon={<BrainCircuit size={15} />} title="行为指令" description="这些内容会追加到系统提示词中，段落之间用空行分隔。">
              <FieldLabel hint="Markdown">提示词段</FieldLabel>
              <Textarea
                value={form.promptText}
                onChange={(e) => setForm((f) => ({ ...f, promptText: e.target.value }))}
                placeholder={'## 研究模式\n\n本会话专注调研，只读不写……'}
                rows={5}
                className="resize-y bg-background/70 font-mono text-xs leading-5"
              />
            </EditorSection>
            <EditorSection icon={<SlidersHorizontal size={15} />} title="运行策略" description="控制模型的思考投入、操作权限和是否允许拆分任务。">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <FieldLabel>推理强度</FieldLabel>
                <Select value={form.effort || SELECT_DEFAULT_VALUE} onValueChange={(v) => setForm((f) => ({ ...f, effort: v === SELECT_DEFAULT_VALUE ? '' : v }))}>
                  <SelectTrigger><SelectValue placeholder="跟随全局设置" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_DEFAULT_VALUE}>跟随全局设置</SelectItem>
                    <SelectItem value="low">低</SelectItem>
                    <SelectItem value="medium">中</SelectItem>
                    <SelectItem value="high">高</SelectItem>
                    <SelectItem value="max">最大</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>权限模式</FieldLabel>
                <Select value={form.permissionMode || SELECT_DEFAULT_VALUE} onValueChange={(v) => setForm((f) => ({ ...f, permissionMode: v === SELECT_DEFAULT_VALUE ? '' : v }))}>
                  <SelectTrigger><SelectValue placeholder="跟随会话默认" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_DEFAULT_VALUE}>跟随会话默认</SelectItem>
                    <SelectItem value="auto">自动审批</SelectItem>
                    <SelectItem value="bypassPermissions">完全自动</SelectItem>
                    <SelectItem value="plan">计划模式</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>子 Agent 委派</FieldLabel>
                <Select value={form.allowSubagents || SELECT_DEFAULT_VALUE} onValueChange={(v) => setForm((f) => ({ ...f, allowSubagents: v === SELECT_DEFAULT_VALUE ? '' : v }))}>
                  <SelectTrigger className="bg-background/70"><SelectValue placeholder="跟随默认策略" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_DEFAULT_VALUE}>跟随默认策略</SelectItem><SelectItem value="yes">允许委派</SelectItem><SelectItem value="no">禁止委派</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            </EditorSection>
            <EditorSection icon={<Wrench size={15} />} title="能力白名单" description="留空表示不注入任何项；需要完整能力时，请在列表中点击「全选」。">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <FieldLabel>Skill 白名单</FieldLabel>
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
                <FieldLabel>MCP 白名单</FieldLabel>
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
            </EditorSection>
            <p className="px-1 text-[10px] leading-4 text-muted-foreground">白名单按名尽力匹配：预设里选了但工作区没有的项会自动忽略；标注「未启用」的项需先在 Skills/MCP 页启用。</p>
            <EditorSection icon={<LockKeyhole size={15} />} title="能力裁剪" description="关闭不需要的内置能力，相关工具和提示词段会同步隐藏。">
              <FieldLabel>精简能力</FieldLabel>
              <div className="rounded-xl bg-background/60 p-3 ring-1 ring-border/45">
                {TOOL_GROUP_OPTIONS.map((group) => {
                  const groupDisabled = form.disabledToolGroups.includes(group.id)
                  const groupTools = group.toolNames
                  return (
                    <div key={group.id} className="flex flex-col gap-1.5 border-b border-border/40 py-2.5 first:pt-0 last:border-b-0 last:pb-0">
                      <label className="flex cursor-pointer items-center justify-between gap-2 select-none">
                        <span className="flex min-w-0 flex-col"><span className="text-xs font-medium">{group.label}</span><span className="truncate text-[10px] text-muted-foreground">{group.hint}</span></span>
                        <Switch checked={groupDisabled} onCheckedChange={(on) => setForm((f) => ({ ...f, disabledToolGroups: on ? [...f.disabledToolGroups, group.id] : f.disabledToolGroups.filter((g) => g !== group.id) }))} className="scale-90 shrink-0" />
                      </label>
                      {!groupDisabled && <details className="ml-1 border-l-2 border-border/60 pl-3"><summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground/80">单工具裁剪（已禁 {form.disabledTools.filter((t) => (groupTools as readonly string[]).includes(t)).length} / {groupTools.length}）</summary><div className="flex flex-wrap gap-1.5 pt-1.5">
                        {groupTools.map((toolName: string) => { const checked = form.disabledTools.includes(toolName); return <button key={toolName} type="button" onClick={() => toggleDisabledTool(toolName)} title={checked ? `已禁用 ${toolName}` : `禁用 ${toolName}`} className={cn('inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[10px] transition-colors', checked ? 'border-destructive/60 bg-destructive/10 text-destructive' : 'border-border/70 bg-background/60 text-foreground/70 hover:bg-muted')}>{checked && <Check size={10} strokeWidth={3} />}{toolName}</button> })}
                      </div></details>}
                    </div>
                  )
                })}
              </div>
              <p className="mt-2 text-[10px] leading-4 text-muted-foreground">禁用后对应工具不再注入，相关提示词段落自动隐藏。全部关闭 = 保留完整能力。</p>
            </EditorSection>
            {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
          </div>}
          {globalMode && editing?.scope === 'builtin-meta' && <p className="rounded-lg bg-blue-500/10 p-3 text-xs text-blue-700 dark:text-blue-300">这是 Profer 内置元预设，只读，不能编辑、重命名或删除。</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreating(false); setEditing(null); setError('') }}>取消</Button>
            {!(globalMode && editing?.scope === 'builtin-meta') && <Button onClick={handleSave} disabled={saving}>{saving ? '保存中…' : '保存'}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {globalMode && globalDeleteReport && globalDeleteReport.blockers.length > 0 && <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"><p className="font-medium">当前预设存在有效引用，暂不可删除</p><ul className="mt-1 list-disc space-y-1 pl-4">{globalDeleteReport.blockers.map((blocker) => <li key={`${blocker.workspaceSlug}:${blocker.reason}`}>{blocker.workspaceName} · {blocker.reason} · {blocker.objectCount} 项</li>)}</ul></div>}
      <ConfirmDialog open={pendingGlobalDelete !== null} onOpenChange={(open) => { if (!open && !globalDeleteBusy) { setPendingGlobalDelete(null); setGlobalDeleteReport(null) } }} title={`确认删除全局预设「${pendingGlobalDelete?.name ?? ''}」？`} description="删除后不可恢复，且不会自动替换其他会话或工作区配置。" confirmLabel="删除" loadingLabel="删除中…" loading={globalDeleteBusy} onConfirm={() => void confirmGlobalDelete()} />
    </SettingsSection>
  )
}
