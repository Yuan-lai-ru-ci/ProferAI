/**
 * 宿主语义类与主题 token 契约：CSS、token 真源、Skill 正文三者必须一致。
 *
 * 背景：Codex 的 `visualize.css` 顶部写着 `Agent-facing contract; keep in sync with SKILL.md`，
 * 靠注释约束同步；这里把它变成会失败的测试——宿主加了类/token 却没写进 Skill，模型就永远用不上；
 * Skill 写了宿主没有的类，模型写出裸 HTML 却不报错；基线 CSS 引用一个没搬到可视化侧的 token，
 * 片段在换肤/明暗切换后就会掉回默认色。三种漂移都在这里拦住。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  VISUALIZATION_HOST_PRIMITIVES,
  VISUALIZATION_INLINE_CSS,
} from '../../shared/visualization-style'
import { VISUALIZATION_THEME_TOKEN_NAMES, VISUALIZATION_FRAGMENT_TOKEN_NAMES } from '../../shared/visualization-theme'

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

  test('片段可见的 token 真源与 Skill 文档同步', () => {
    // 生成侧看到的 token 清单以 Skill 正文为准：漏写一个，模型写出的片段就会静默掉色。
    const missing = VISUALIZATION_FRAGMENT_TOKEN_NAMES.filter((token) => !skillBody.includes(token))
    expect(missing).toEqual([])
  })

  test('基线 CSS 只引用真的搬到可视化侧的 token', () => {
    // iframe 文档里没有 app 的样式表：引用一个没搬运的 token 只会让规则静默失效，
    // 而“静默失效”正是换肤后颜色不跟随这类问题的典型形态。
    const referenced = [...VISUALIZATION_INLINE_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!)
    expect(referenced.length).toBeGreaterThan(0)
    const allowed = new Set<string>([...VISUALIZATION_THEME_TOKEN_NAMES, '--profer-font-family'])
    expect([...new Set(referenced)].filter((token) => !allowed.has(token))).toEqual([])
  })

  test('Skill 不承诺宿主没有的近义类名', () => {
    for (const absent of ['.card', '.badge', '.modal', '.alert', '.tooltip', '.tile']) {
      expect(skillBody).not.toContain(absent)
    }
  })
})
