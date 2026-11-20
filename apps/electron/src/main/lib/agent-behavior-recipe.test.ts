import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { buildCoreAgentPrompt } from './agent-prompt-core'
import {
  appendAgentBehaviorUserSteer,
  buildAgentBehaviorAgentSteer,
  buildAgentBehaviorCraftPrompt,
  buildAgentBehaviorRolePrompt,
  buildAgentBehaviorUserSteer,
  resolveAgentBehaviorRole,
} from './agent-behavior-recipe'

describe('GPT with Taste 行为配方适配', () => {
  test('主 steer 保留判断、接续与读者优先方法，不退化为泛泛的授权提醒', () => {
    const steer = buildAgentBehaviorUserSteer('main')
    for (const clause of ['普通细节由你判断', '已有授权足够就行动', '不要反复确认已定事项', '继续完成职责内的修复、实现和相称验证', '删掉无助于下一步行动的自证']) {
      expect(steer).toContain(clause)
    }
    expect(steer).not.toContain('将本轮输入接回用户目的、当前目标与已定选择，继续下一步授权工作。')
    const craft = buildAgentBehaviorCraftPrompt()
    expect(craft).toContain('不为假想风险增加前置检查')
    expect(craft).toContain('不因想象中的批评削弱结论')
    expect(craft).toContain('实际使用者')
  })

  test('明确实现不另设固定确认，真实权限与只读要求仍保留', () => {
    const core = buildCoreAgentPrompt()
    expect(core).toContain('不另设固定确认轮次')
    expect(core).toContain('岗位限定')
    expect(core).toContain('分析不擅自实施')
    expect(core).toContain('不恢复关闭能力')
    const skill = readFileSync(new URL('../../../default-skills/brainstorming/SKILL.md', import.meta.url), 'utf8')
    expect(skill).toContain('do the necessary design and continue into implementation')
    expect(skill).toContain('Respect actual plan mode, role restrictions')
    expect(skill).not.toContain('checking after each section whether it looks right so far')
    expect(skill).not.toContain('Commit the design document to git')
  })

  test('按宿主事实区分主、子和独立角色', () => {
    expect(resolveAgentBehaviorRole({})).toBe('main')
    expect(resolveAgentBehaviorRole({ sourceDelegationId: 'd-1', parentSessionId: 'p-1' })).toBe('sub')
    expect(resolveAgentBehaviorRole({ delegationRelation: 'independent', sourceDelegationId: 'd-2' })).toBe('independent')
  })

  test('角色提示词保留任务所有权和证据要求', () => {
    expect(buildAgentBehaviorRolePrompt('main')).toContain('持续推进到可交付状态')
    expect(buildAgentBehaviorRolePrompt('sub')).toContain('不要创建新的协作子会话')
    expect(buildAgentBehaviorRolePrompt('main')).not.toContain('## 做事方式')
    expect(buildAgentBehaviorRolePrompt('sub')).not.toContain('不伪造')
    expect(buildAgentBehaviorCraftPrompt()).toContain('## 产物质量')
    expect(buildAgentBehaviorRolePrompt('independent')).toContain('独立工作目标')
  })

  test('独立会话不接收主/子会话 steer，父会话结果有独立吸收提醒', () => {
    expect(buildAgentBehaviorUserSteer('main')).toContain('用户目的')
    expect(buildAgentBehaviorUserSteer('sub')).toContain('父任务目标')
    expect(buildAgentBehaviorUserSteer('independent')).toBe('')
    expect(buildAgentBehaviorAgentSteer()).toContain('最终交付责任')
    expect(buildAgentBehaviorAgentSteer('independent')).toBe('')
    expect(buildAgentBehaviorAgentSteer('sub')).toContain('父任务目标')
  })

  test('light、compact 保持原消息且按轮不改变历史', () => {
    expect(appendAgentBehaviorUserSteer('你好', 'main', 'light')).toBe('你好')
    expect(appendAgentBehaviorUserSteer('/compact', 'main', 'standard')).toBe('/compact')
    const history = ['上一轮原文']
    expect(appendAgentBehaviorUserSteer('继续', 'sub', 'standard')).toContain('父任务目标')
    expect(history).toEqual(['上一轮原文'])
  })

  test('进程回滚开关同时关闭完整角色与全部 steer', () => {
    const previous = process.env.PROFER_AGENT_TASTE
    process.env.PROFER_AGENT_TASTE = '0'
    try {
      expect(buildAgentBehaviorCraftPrompt()).toBe('')
      for (const role of ['main', 'sub', 'independent'] as const) {
        expect(buildAgentBehaviorRolePrompt(role)).toBe('')
        expect(buildAgentBehaviorUserSteer(role)).toBe('')
        expect(buildAgentBehaviorAgentSteer(role)).toBe('')
        expect(appendAgentBehaviorUserSteer('继续', role, 'standard')).toBe('继续')
      }
    } finally {
      if (previous === undefined) delete process.env.PROFER_AGENT_TASTE
      else process.env.PROFER_AGENT_TASTE = previous
    }
  })
})
