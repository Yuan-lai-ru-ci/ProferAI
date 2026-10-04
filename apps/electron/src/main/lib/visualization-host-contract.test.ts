/**
 * 宿主语义类契约：CSS、Skill 正文、生成侧认知三者必须一致。
 *
 * 背景：Codex 的 `visualize.css` 顶部写着 `Agent-facing contract; keep in sync with SKILL.md`，
 * 靠注释约束同步；这里把它变成会失败的测试——宿主加了类却没写进 Skill，模型就永远用不上；
 * Skill 写了宿主没有的类，模型写出裸 HTML 却不报错。两种漂移都在这里拦住。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  VISUALIZATION_HOST_PRIMITIVES,
  VISUALIZATION_INLINE_CSS,
} from '../../shared/visualization-style'

const skillBody = readFileSync(
  new URL('../../../default-skills/present-visualization/SKILL.md', import.meta.url),
  'utf8',
)

describe('可视化宿主契约与 Skill 同步', () => {
  test('清单里的每一项都是宿主真的提供的语义类', () => {
    const missing = VISUALIZATION_HOST_PRIMITIVES.filter(
      (primitive) => !VISUALIZATION_INLINE_CSS.includes(primitive),
    )
    expect(missing).toEqual([])
  })

  test('清单里的每一项都写进了内置 Skill', () => {
    const missing = VISUALIZATION_HOST_PRIMITIVES.filter(
      (primitive) => !skillBody.includes(primitive),
    )
    expect(missing).toEqual([])
  })

  test('宿主 token 白名单覆盖 Skill 承诺的颜色 token', () => {
    const bridge = readFileSync(
      new URL('../../renderer/lib/visualization-bridge.ts', import.meta.url),
      'utf8',
    )
    for (const token of ['--foreground', '--muted-foreground', '--border', '--primary', '--accent', '--destructive']) {
      expect(bridge).toContain(`'${token}'`)
      expect(skillBody).toContain(`var(${token})`)
    }
  })

  test('Skill 不承诺宿主没有的近义类名', () => {
    for (const absent of ['.card', '.badge', '.modal', '.alert', '.tooltip', '.tile']) {
      expect(skillBody).not.toContain(absent)
    }
  })
})
