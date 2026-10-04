/**
 * 旧路由侧车（profer-routing.json）迁入模块清单（SKILL.json）。
 *
 * 规则与运行时合并一致：清单已声明的触发词 / implicit 以清单为准，依赖取并集。
 * 只有迁移后的生效规则与迁移前完全一致才删除侧车；侧车无效、清单损坏或结果不一致时
 * 原样保留（路由仍会读取侧车），绝不丢配置。
 */
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { skillManifestToRoutingFields, SKILL_MANIFEST_FILENAME } from '@profer/shared'
import { readSkillManifest, skillManifestGateInvalid, writeSkillManifest } from './skill-manifest'
import { mergeSkillRoutingLayers } from './skill-routing'
import { parseRoutingSidecar, ROUTING_SIDECAR_FILENAME, type SkillRoutingRules } from './skill-routing-rules'

const MAX_SIDECAR_BYTES = 16 * 1024

export type RoutingSidecarMigration = 'none' | 'migrated' | 'kept'

function union(left?: readonly string[], right?: readonly string[]): string[] | undefined {
  const values = [...new Set([...(left ?? []), ...(right ?? [])])]
  return values.length ? values : undefined
}

/** 比较生效规则：数组按集合比较，空数组等同未声明。 */
function sameRules(left: SkillRoutingRules, right: SkillRoutingRules): boolean {
  const normalize = (rules: SkillRoutingRules): string => JSON.stringify(
    Object.entries(rules)
      .filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))
      .map(([field, value]) => [field, Array.isArray(value) ? [...value].sort() : value])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )
  return normalize(left) === normalize(right)
}

function readSidecar(path: string): SkillRoutingRules | undefined {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) return undefined
    return parseRoutingSidecar(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export function migrateRoutingSidecar(dir: string): RoutingSidecarMigration {
  const sidecarPath = join(dir, ROUTING_SIDECAR_FILENAME)
  if (!existsSync(sidecarPath)) return 'none'
  const sidecar = readSidecar(sidecarPath)
  if (!sidecar) return 'kept'
  const current = readSkillManifest(dir)
  if (skillManifestGateInvalid(current) || (current.present && !current.manifest)) return 'kept'

  const fields = skillManifestToRoutingFields(current.manifest)
  const before = mergeSkillRoutingLayers(sidecar, fields)
  const cardPath = join(dir, SKILL_MANIFEST_FILENAME)
  const original = current.present ? readFileSync(cardPath, 'utf8') : undefined
  const restore = (): void => {
    if (original === undefined) rmSync(cardPath, { force: true })
    else writeFileSync(cardPath, original, 'utf8')
  }
  try {
    writeSkillManifest(dir, {
      triggers: {
        keywords: fields.keywords ? undefined : sidecar.keywords,
        excludeKeywords: fields.excludeKeywords ? undefined : sidecar.excludeKeywords,
      },
      policy: { implicit: fields.implicit !== undefined ? undefined : sidecar.implicit },
      dependencies: {
        tools: union(fields.requiredTools, sidecar.requiredTools),
        mcpServers: union(fields.requiredMcpServers, sidecar.requiredMcpServers),
        toolGroups: union(fields.requiredToolGroups, sidecar.requiredToolGroups) as SkillRoutingRules['requiredToolGroups'],
      },
    })
    const after = mergeSkillRoutingLayers(skillManifestToRoutingFields(readSkillManifest(dir).manifest))
    if (!sameRules(before, after)) {
      restore()
      return 'kept'
    }
  } catch {
    restore()
    return 'kept'
  }
  rmSync(sidecarPath, { force: true })
  return 'migrated'
}
