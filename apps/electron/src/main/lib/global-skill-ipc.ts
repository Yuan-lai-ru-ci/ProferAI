import { registerCoreResourceHandler } from './core-resource-routing'
import { ipcMain } from 'electron'
import { GLOBAL_SKILL_IPC_CHANNELS, SKILL_MASTER_IPC_CHANNELS, type SkillManifestPatch } from '@profer/shared'
import {
  copyGlobalSkillToUserGlobal,
  copyGlobalSkillToWorkspace,
  createUserGlobalSkill,
  deleteUserGlobalSkill,
  editGlobalSkill,
  getGlobalSkillDeleteBlockers,
  getWorkspaceGlobalSkillOverrides,
  listGlobalSkills,
  readGlobalSkillContent,
  readGlobalSkillCard,
  writeGlobalSkillCard,
  readWorkspaceSkillCopyContent,
  restoreGlobalSkill,
  saveWorkspaceSkillCopyContent,
  setGlobalSkillEnabled,
} from './global-skill-manager'
import {
  detectSkillConflict,
  listMasterSkillHistory,
  listMasterSkills,
  readMasterSkillContent,
} from './skill-master-manager'
import { assertSafeSkillSegment } from './skill-path-security'

export function registerGlobalSkillIpc(): void {
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.LIST, async (_, workspaceSlug?: string) => {
    if (workspaceSlug !== undefined) assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return listGlobalSkills(workspaceSlug)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.READ, async (_, skillId: string) => readGlobalSkillContent(skillId))
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.READ_CARD, async (_, skillId: string) => readGlobalSkillCard(skillId))
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.WRITE_CARD, async (_, skillId: string, patch: SkillManifestPatch) => writeGlobalSkillCard(skillId, patch))
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.READ_WORKSPACE_COPY, async (_, workspaceSlug: string, workspaceSkillId: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    assertSafeSkillSegment(workspaceSkillId, 'workspaceSkillId')
    return readWorkspaceSkillCopyContent(workspaceSlug, workspaceSkillId)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.SAVE_WORKSPACE_COPY, async (_, workspaceSlug: string, workspaceSkillId: string, content: string): Promise<void> => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    assertSafeSkillSegment(workspaceSkillId, 'workspaceSkillId')
    saveWorkspaceSkillCopyContent(workspaceSlug, workspaceSkillId, content)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.SAVE, async (_, skillId: string, content: string, workspaceSlug: string, scope: 'global' | 'workspace') => {
    if (scope !== 'global' && scope !== 'workspace') throw new Error('必须明确选择全局版本或当前工作区')
    if (scope === 'workspace') assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return editGlobalSkill(skillId, workspaceSlug, scope, content)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.COPY_TO_USER, async (_, skillId: string, slug?: string) => {
    if (slug !== undefined) assertSafeSkillSegment(slug.trim(), 'global Skill slug')
    return copyGlobalSkillToUserGlobal(skillId, slug)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.CREATE_USER, async (_, slug: string, name: string, description: string, content: string, importMarkdown?: boolean) => {
    assertSafeSkillSegment(slug.trim(), 'global Skill slug')
    return createUserGlobalSkill(slug, name, description, content, { importMarkdown: importMarkdown === true })
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.COPY_TO_WORKSPACE, async (_, skillId: string, workspaceSlug: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return copyGlobalSkillToWorkspace(skillId, workspaceSlug)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.GET_DELETE_BLOCKERS, async (_, skillId: string) => getGlobalSkillDeleteBlockers(skillId))
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.DELETE_USER, async (_, skillId: string, confirmationToken?: string) => deleteUserGlobalSkill(skillId, confirmationToken))
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.SET_ENABLED, async (_, workspaceSlug: string, skillId: string, enabled: boolean) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return setGlobalSkillEnabled(workspaceSlug, skillId, enabled)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.RESTORE, async (_, workspaceSlug: string, skillId: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return restoreGlobalSkill(workspaceSlug, skillId)
  })
  registerCoreResourceHandler(GLOBAL_SKILL_IPC_CHANNELS.GET_OVERRIDES, async (_, workspaceSlug: string) => {
    assertSafeSkillSegment(workspaceSlug, 'workspaceSlug')
    return getWorkspaceGlobalSkillOverrides(workspaceSlug)
  })

  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.LIST, async () => listMasterSkills())
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.READ, async (_, slug: string) => readMasterSkillContent(slug))
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.SAVE, async (): Promise<never> => {
    throw new Error('旧元 Skill 写接口已停用，请通过全局 Skill 体系复制后编辑')
  })
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.RENAME_META, async (): Promise<never> => {
    throw new Error('旧元 Skill 写接口已停用，请通过全局 Skill 体系复制后编辑')
  })
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.LIST_HISTORY, async (_, slug: string) => listMasterSkillHistory(slug))
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.ROLLBACK, async (): Promise<never> => {
    throw new Error('旧元 Skill 写接口已停用，请通过全局 Skill 体系复制后编辑')
  })
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.SYNC_TO_WORKSPACES, async (): Promise<never> => {
    throw new Error('旧元 Skill 同步接口已停用，请使用全局 Skill 的工作区副本功能')
  })
  registerCoreResourceHandler(SKILL_MASTER_IPC_CHANNELS.DETECT_CONFLICT, async (_, workspaceSlug: string, skillSlug: string) => detectSkillConflict(workspaceSlug, skillSlug))
}
