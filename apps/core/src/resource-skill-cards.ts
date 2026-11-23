import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from '../../../packages/session-store/src/atomic-write'
import { parseSkillManifest, SKILL_MANIFEST_FILENAME, SKILL_MANIFEST_SCHEMA_VERSION, type WorkspaceSkillCardState } from '@profer/shared'
import { ensureSkillCard, hasSkillCard, readSkillCardDismissals, readSkillManifest, SKILL_CARD_DISMISSALS_FILE } from '@profer/agent-provider-pi/skills/skill-manifest'
import { assertResourcePath, readResourceObject, resourceObject } from './resource-paths'

export function readCoreSkillCardDismissals(configDir: string): Set<string> {
  assertResourcePath(join(configDir, SKILL_CARD_DISMISSALS_FILE))
  return readSkillCardDismissals(configDir)
}

export async function applyCoreSkillCardDecision(configDir: string, dir: string, key: string, decision: 'create' | 'dismiss'): Promise<void> {
  assertResourcePath(join(dir, SKILL_MANIFEST_FILENAME))
  if (decision === 'create') ensureSkillCard(dir)
  else if (!hasSkillCard(dir)) {
    const dismissed = readCoreSkillCardDismissals(configDir)
    dismissed.add(key)
    await atomicWriteJson(join(configDir, SKILL_CARD_DISMISSALS_FILE), [...dismissed])
  }
}

export function readCoreSkillCard(dir: string): WorkspaceSkillCardState {
  return { ...readSkillManifest(dir), doctor: [] }
}

export async function writeCoreSkillCard(dir: string, input: unknown): Promise<WorkspaceSkillCardState> {
  const path = join(dir, SKILL_MANIFEST_FILENAME)
  const merged = readResourceObject(path) ?? {}
  const isDefault = () => Object.keys(merged).every(key => key === 'schemaVersion')
  const keepDefault = merged.schemaVersion === SKILL_MANIFEST_SCHEMA_VERSION && isDefault()
  const patch = resourceObject(input)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') { delete merged[key]; continue }
    if (['interface', 'policy', 'triggers', 'dependencies', 'requires'].includes(key)) {
      const group = { ...resourceObject(merged[key] ?? {}) }
      for (const [field, v] of Object.entries(resourceObject(value))) {
        if (v === null || v === '' || Array.isArray(v) && v.length === 0) delete group[field]
        else group[field] = v
      }
      if (Object.keys(group).length) merged[key] = group; else delete merged[key]
    } else merged[key] = value
  }
  merged.schemaVersion = SKILL_MANIFEST_SCHEMA_VERSION
  const parsed = parseSkillManifest(merged)
  if (!parsed.manifest || parsed.issues.some(issue => issue.severity === 'error')) throw new Error('Core Skill卡片校验未通过')
  if (isDefault() && !keepDefault) rmSync(path, { force: true })
  else await atomicWriteJson(path, merged)
  return readCoreSkillCard(dir)
}
