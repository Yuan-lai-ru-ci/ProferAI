import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 全屏视图会整块取代 TabBar，此时窗口按钮必须由页面自己声明宿主，
 * 否则 Windows 上最小化/最大化/关闭会整组消失。
 *
 * 这一约定至少被破坏过一次：AgentSkillsView 的宿主在后续重构里被移除，
 * 而 macOS 上的类型检查和单测都不会发现，Windows 打包 smoke test 也只验证
 * 进程存活。因此用源码级守卫把约定固化进 CI。
 *
 * 注意：本测试只保证「声明了宿主」，不替代 Windows 真机上对宿主位置、
 * 优先级、命中区的验收。
 */
const FULLSCREEN_VIEWS: Array<{ path: string; minHosts: number; why: string }> = [
  {
    path: '../components/planning/PlanningView.tsx',
    minHosts: 1,
    why: '规划中心全屏取代 TabBar',
  },
  {
    path: '../components/agent-skills/AgentSkillsView.tsx',
    // 正常页与「未选择工作区」空态是两个互斥的分支，各自都要有按钮
    minHosts: 2,
    why: 'Agent 技能全屏视图（含未选工作区空态）',
  },
  {
    path: '../components/agent-skills/AgentMemoryView.tsx',
    minHosts: 1,
    why: 'Agent 记忆全屏视图',
  },
]

function readSource(relativePath: string): string {
  return readFileSync(join(import.meta.dir, relativePath), 'utf8')
}

describe('全屏视图的窗口按钮宿主覆盖', () => {
  for (const view of FULLSCREEN_VIEWS) {
    test(`${view.why}：${view.path} 声明了 WindowControlsHost`, () => {
      const source = readSource(view.path)

      // 不固定引号风格：仓库内单双引号混用
      const hasImport = /import\s*\{[^}]*WindowControlsHost[^}]*\}\s*from\s*['"][^'"]*WindowControlsTemplate['"]/.test(
        source,
      )
      expect(hasImport, `${view.path} 缺少 WindowControlsHost 导入`).toBe(true)

      const usages = source.match(/<WindowControlsHost\b/g) ?? []
      expect(
        usages.length,
        `${view.path} 只出现 ${usages.length} 处 <WindowControlsHost，至少需要 ${view.minHosts} 处`,
      ).toBeGreaterThanOrEqual(view.minHosts)
    })
  }

  test('通用兜底宿主覆盖所有非 TabBar 分支', () => {
    const source = readSource('../components/tabs/MainArea.tsx')

    // 兜底条件是「定时任务表单 / 无 Tab / 非对话视图」，任一分支都不能漏
    expect(
      source.includes("automationFormOpen || tabs.length === 0 || activeView !== 'conversations'"),
      'MainArea 兜底宿主的 active 条件没有覆盖全部分支',
    ).toBe(true)

    // 兜底优先级必须低于 TabBar(10)，否则同一时刻两个 active 宿主会争抢按钮
    const fallback = source.match(/id="main-content"[\s\S]{0,240}?priority=\{(\d+)\}/)
    expect(fallback, 'MainArea 兜底宿主缺少 priority').not.toBeNull()
    expect(Number(fallback![1])).toBeLessThan(10)
  })
})
