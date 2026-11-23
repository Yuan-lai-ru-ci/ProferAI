/**
 * useAgentSkillsData — Agent 技能视图的数据层
 *
 * 封装当前工作区 Skills / MCP 的加载与增删改逻辑（IPC 调用），
 * 供「Agent 技能」全屏视图复用。所有写操作后会 bump
 * workspaceCapabilitiesVersionAtom，通知侧边栏等订阅方刷新。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
  workspaceCapabilitiesVersionAtom,
} from '@/atoms/agent-atoms'
import type { SkillMeta, WorkspaceMcpConfig } from '@profer/shared'
import { isWorkspaceLocalSkill, skillListKey } from './skillListSections'

export interface AgentSkillsData {
  /** 当前工作区（未选中时为 null） */
  workspaceSlug: string
  workspaceName: string
  hasWorkspace: boolean
  loading: boolean
  skills: SkillMeta[]
  /** 列表刚切换工作区尚未刷新时，不允许旧列表发起当前作用域的写操作。 */
  skillsWorkspaceSlug: string
  defaultSkillSlugs: Set<string>
  skillsDir: string
  mcpConfig: WorkspaceMcpConfig
  updatingSkill: string | null
  toggleSkill: (slug: string, enabled: boolean, sourceSkillId?: string) => Promise<void>
  deleteSkill: (slug: string, name: string, workspaceSkillId?: string) => Promise<boolean>
  updateSkill: (slug: string) => Promise<void>
  toggleMcp: (name: string, enabled: boolean) => Promise<void>
  deleteMcp: (name: string) => Promise<void>
}

export function useAgentSkillsData(): AgentSkillsData {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const bumpCapabilitiesVersion = useSetAtom(workspaceCapabilitiesVersionAtom)
  const capabilitiesVersion = useAtomValue(workspaceCapabilitiesVersionAtom)

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId)
  const workspaceSlug = currentWorkspace?.slug ?? ''

  const [loading, setLoading] = React.useState(true)
  const [skills, setSkills] = React.useState<SkillMeta[]>([])
  const [skillsWorkspaceSlug, setSkillsWorkspaceSlug] = React.useState('')
  const [defaultSkillSlugs, setDefaultSkillSlugs] = React.useState<Set<string>>(new Set())
  const [skillsDir, setSkillsDir] = React.useState('')
  const [mcpConfig, setMcpConfig] = React.useState<WorkspaceMcpConfig>({ servers: {} })
  const [updatingSkill, setUpdatingSkill] = React.useState<string | null>(null)

  const loadData = React.useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!workspaceSlug) {
      if (!isCurrent()) return

      setSkills([])
      setSkillsWorkspaceSlug('')
      setMcpConfig({ servers: {} })
      setLoading(false)
      return
    }
    try {
      const [config, skillList, dir, defaultSlugs] = await Promise.all([
        window.electronAPI.getWorkspaceMcpConfig(workspaceSlug),
        window.electronAPI.getWorkspaceSkills(workspaceSlug),
        window.electronAPI.getWorkspaceSkillsDir(workspaceSlug),
        window.electronAPI.getDefaultSkillSlugs(),
      ])
      if (!isCurrent()) return
      setMcpConfig(config)
      setSkills(skillList)
      setSkillsWorkspaceSlug(workspaceSlug)
      setSkillsDir(dir)
      setDefaultSkillSlugs(new Set(defaultSlugs))
    } catch (error) {
      console.error('[Agent 技能] 加载工作区配置失败:', error)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [workspaceSlug])

  // workspaceSlug 或外部能力版本变化时重新拉取
  React.useEffect(() => {
    // 保留现有列表，避免单个开关或其他能力变化导致整页白屏闪烁。
    let cancelled = false
    void loadData(() => !cancelled)
    return () => { cancelled = true }
  }, [loadData, capabilitiesVersion])

  /**
   * 乐观更新按身份定位目标行，不能只按 slug：
   * - 工作区副本（含已关闭、位于 skills-inactive/ 的）用 workspaceSkillId 识别；
   *   用 `!sourceSkillId` 会把同名全局定义当成副本，改错行的开关状态。
   * - 与主进程的三态路由保持一致：非空 ID = 全局定义；'' = 明确本地；未传 = 本地优先、否则回退全局。
   */
  const resolveToggleTargetKey = React.useCallback(
    (slug: string, sourceSkillId: string | undefined, rows: SkillMeta[]): string | null => {
      if (sourceSkillId) return `global:${sourceSkillId}`
      const local = rows.find((s) => s.slug === slug && isWorkspaceLocalSkill(s))
      if (local) return skillListKey(local)
      if (sourceSkillId === undefined) {
        const global = rows.find((s) => s.slug === slug && !isWorkspaceLocalSkill(s))
        if (global) return skillListKey(global)
      }
      return null
    },
    [],
  )

  const toggleSkill = React.useCallback(async (slug: string, enabled: boolean, sourceSkillId?: string) => {
    if (enabled) {
      const targetKey = resolveToggleTargetKey(slug, sourceSkillId, skills)
      const duplicate = skills.find(
        (skill) => skill.slug === slug && skill.enabled && skillListKey(skill) !== targetKey,
      )
      if (duplicate && typeof window !== 'undefined' && !window.confirm('当前工作区同时存在该 Skill 的工作区副本与全局/元 Skill，同时启用可能导致能力重复或行为冲突，不推荐这样使用。是否仍要继续启用？')) return
    }
    try {
      await window.electronAPI.toggleWorkspaceSkill(workspaceSlug, slug, enabled, sourceSkillId)
      setSkills((prev) => {
        const targetKey = resolveToggleTargetKey(slug, sourceSkillId, prev)
        return prev.map((s) =>
          targetKey !== null && skillListKey(s) === targetKey ? { ...s, enabled } : s,
        )
      })
      bumpCapabilitiesVersion((v) => v + 1)
    } catch (error) {
      console.error('[Agent 技能] 切换 Skill 状态失败:', error)
      toast.error('切换 Skill 状态失败')
    }
  }, [skills, workspaceSlug, bumpCapabilitiesVersion, resolveToggleTargetKey])

  /**
   * 删除只对工作区副本生效；同名全局定义是另一行，不能一起从列表里抹掉，
   * 否则要等到下次重新拉取才会恢复。优先按 workspaceSkillId 精确命中。
   */
  const deleteSkill = React.useCallback(async (slug: string, name: string, workspaceSkillId?: string): Promise<boolean> => {
    try {
      await window.electronAPI.deleteWorkspaceSkill(workspaceSlug, slug)
      setSkills((prev) =>
        prev.filter((s) =>
          workspaceSkillId
            ? s.workspaceSkillId !== workspaceSkillId
            : !(s.slug === slug && isWorkspaceLocalSkill(s)),
        ),
      )
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(`已删除 Skill：${name}`)
      return true
    } catch (error) {
      console.error('[Agent 技能] 删除 Skill 失败:', error)
      toast.error('删除 Skill 失败')
      return false
    }
  }, [workspaceSlug, bumpCapabilitiesVersion])

  const updateSkill = React.useCallback(async (slug: string) => {
    if (!workspaceSlug || updatingSkill) return
    setUpdatingSkill(slug)
    try {
      const updated = await window.electronAPI.updateSkillFromSource(workspaceSlug, slug)
      setSkills((prev) => prev.map((s) => (s.slug === slug ? updated : s)))
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(`已同步更新 Skill：${updated.name}`)
    } catch (error) {
      console.error('[Agent 技能] 更新 Skill 失败:', error)
      const message = error instanceof Error ? error.message : '未知错误'
      toast.error('更新 Skill 失败', { description: message })
    } finally {
      setUpdatingSkill(null)
    }
  }, [workspaceSlug, updatingSkill, bumpCapabilitiesVersion])

  const toggleMcp = React.useCallback(async (name: string, enabled: boolean) => {
    try {
      const entry = mcpConfig.servers[name]
      if (!entry) return
      const newConfig: WorkspaceMcpConfig = {
        servers: { ...mcpConfig.servers, [name]: { ...entry, enabled } },
      }
      await window.electronAPI.saveWorkspaceMcpConfig(workspaceSlug, newConfig)
      setMcpConfig(newConfig)
      bumpCapabilitiesVersion((v) => v + 1)
    } catch (error) {
      console.error('[Agent 技能] 切换 MCP 服务器状态失败:', error)
      toast.error('切换 MCP 状态失败')
    }
  }, [workspaceSlug, mcpConfig, bumpCapabilitiesVersion])

  const deleteMcp = React.useCallback(async (name: string) => {
    const entry = mcpConfig.servers[name]
    if (entry?.isBuiltin) return
    try {
      const newServers = { ...mcpConfig.servers }
      delete newServers[name]
      const newConfig: WorkspaceMcpConfig = { servers: newServers }
      await window.electronAPI.saveWorkspaceMcpConfig(workspaceSlug, newConfig)
      setMcpConfig(newConfig)
      bumpCapabilitiesVersion((v) => v + 1)
      toast.success(`已删除 MCP 服务器：${name}`)
    } catch (error) {
      console.error('[Agent 技能] 删除 MCP 服务器失败:', error)
      toast.error('删除 MCP 服务器失败')
    }
  }, [workspaceSlug, mcpConfig, bumpCapabilitiesVersion])

  return {
    workspaceSlug,
    workspaceName: currentWorkspace?.name ?? '',
    hasWorkspace: !!currentWorkspace,
    loading,
    skills,
    skillsWorkspaceSlug,
    defaultSkillSlugs,
    skillsDir,
    mcpConfig,
    updatingSkill,
    toggleSkill,
    deleteSkill,
    updateSkill,
    toggleMcp,
    deleteMcp,
  }
}
