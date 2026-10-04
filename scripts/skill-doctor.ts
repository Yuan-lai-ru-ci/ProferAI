#!/usr/bin/env bun
/**
 * Skill 医生 CLI：对内置技能目录（或 --root 指定目录）产出可展示诊断。
 *
 * 这是模块管理层的第一个可用入口：作者与 CI 都能用它检查清单、描述质量、依赖与宿主契约。
 * 用法：
 *   bun scripts/skill-doctor.ts                       # 检查 apps/electron/default-skills
 *   bun scripts/skill-doctor.ts --root <dir>          # 检查任意 Skill 根目录
 *   bun scripts/skill-doctor.ts --strict              # 存在 error 级诊断时退出码 1
 *
 * 诊断永远不阻止加载：--strict 只用于 CI/交付前自检，不是运行时门禁。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseSkillRoot, formatSkillDoctorReport } from '../apps/electron/src/main/lib/skill-doctor'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const root = resolve(readArg('--root') ?? join(repoRoot, 'apps', 'electron', 'default-skills'))
const strict = process.argv.includes('--strict')

if (!existsSync(root)) {
  console.error(`目录不存在: ${root}`)
  process.exit(2)
}

// 同时接受「Skill 根目录」与「单个 Skill 目录」两种用法，避免作者多写一层壳。
const isSingleSkill = existsSync(join(root, 'SKILL.md'))
const reports = isSingleSkill ? diagnoseSkillRoot(dirname(root)) : diagnoseSkillRoot(root)
const target = reports.filter(report => !isSingleSkill || report.dir === root)

if (!target.length) {
  console.error(`没有找到含 SKILL.md 的 Skill 目录: ${root}`)
  process.exit(2)
}

console.log(`Skill 医生：${root}`)
console.log(formatSkillDoctorReport(target))

const errors = target.reduce((sum, report) => sum + report.counts.error, 0)
const warnings = target.reduce((sum, report) => sum + report.counts.warning, 0)
if (strict && errors > 0) process.exit(1)
if (!strict && errors + warnings > 0) {
  console.log('\n提示：加 --strict 可让 error 级诊断以退出码 1 结束（用于 CI 自检）。')
}
// 让「有诊断」在默认模式下也可被脚本消费，但不当作失败。
if (process.argv.includes('--json')) console.log(JSON.stringify(target, null, 2))
