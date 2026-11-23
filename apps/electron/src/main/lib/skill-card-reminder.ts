import { join } from 'node:path'
import type { SkillCardReminderDecision, SkillCardReminderTarget } from '@profer/shared'
import { resolveWorkspaceSkillCardTarget } from './agent-workspace-manager'
import { getConfigDir } from './config-paths'
import { resolveUserGlobalSkillCardDir } from './global-skill-manager'
import { writeJsonFileAtomic } from './safe-file'
import { ensureSkillCard, hasSkillCard, readSkillCardDismissals, skillCardDismissalKey, SKILL_CARD_DISMISSALS_FILE } from './skill-manifest'

export function resolveSkillCardReminder(target: SkillCardReminderTarget, decision: SkillCardReminderDecision): void {
  if (decision !== 'create' && decision !== 'dismiss') throw new Error('Skill 路由卡片提醒选项无效')
  if (target?.scope !== 'workspace' && target?.scope !== 'global') throw new Error('Skill 路由卡片提醒作用域无效')
  const { dir, id } = target.scope === 'workspace'
    ? resolveWorkspaceSkillCardTarget(target.workspaceSlug, target.skillSlug, target.workspaceSkillId)
    : { dir: resolveUserGlobalSkillCardDir(target.skillId), id: target.skillId }
  if (decision === 'create') {
    ensureSkillCard(dir)
  } else if (!hasSkillCard(dir)) {
    const configDir = getConfigDir()
    const dismissed = readSkillCardDismissals(configDir)
    dismissed.add(skillCardDismissalKey(target.scope, id, target.scope === 'workspace' ? target.workspaceSlug : undefined))
    writeJsonFileAtomic(join(configDir, SKILL_CARD_DISMISSALS_FILE), [...dismissed], true)
  }
}
