import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rendererRoot = resolve(import.meta.dir, '../..')
const agentView = readFileSync(resolve(rendererRoot, 'components/agent/AgentView.tsx'), 'utf8')
const border = readFileSync(resolve(rendererRoot, 'components/agent/PlanModeDashedBorder.tsx'), 'utf8')
const skinBase = readFileSync(resolve(rendererRoot, 'styles/skin-base.css'), 'utf8')

test('计划模式边框保留原 SVG 视觉实现并在计划态挂载', () => {
  expect(agentView).toContain("(isPlanMode || isPermissionPlanMode) && !isDragOver && <PlanModeDashedBorder />")
  expect(border).toContain('const DASH_LENGTH = 9')
  expect(border).toContain('const DASH_GAP = 7')
  expect(border).toContain('const STROKE_WIDTH = 2')
  expect(border).toContain('const BORDER_RADIUS = 17')
  expect(border).toContain('const OFFSET = 2')
  expect(border).toContain('strokeDasharray={`${DASH_LENGTH} ${DASH_GAP}`}')
  expect(border).toContain('strokeWidth={STROKE_WIDTH}')
  expect(border).toContain('rx={BORDER_RADIUS + OFFSET}')
  expect(border).toContain('strokeLinecap="round"')
  expect(border).toContain('pointer-events-none')
  expect(border).toContain('ResizeObserver')
  expect(border).toContain('<svg')
})

test('皮肤未定义专用描边 token 时回落到 primary 颜色', () => {
  expect(skinBase).toContain('stroke: var(--plan-mode-stroke-color, hsl(var(--primary) / 0.45));')
})
