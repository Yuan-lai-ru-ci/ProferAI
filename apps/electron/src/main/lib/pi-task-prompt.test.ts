import { describe, expect, test } from 'bun:test'
import { buildPiTaskPrompt } from './pi-task-prompt'

const BASE_PROMPT = `# Core

## SubAgent 委派策略
COLLABORATION_RULES

## Pi Agent Runtime
CORE_PI_RULES

### Pi Runtime 与文件记忆
PI_MEMORY_RULES

## 用户信息
USER

## 团队共享知识记忆
TEAM_MEMORY_RULES

## 不确定性处理
UNCERTAINTY

## Profer 知识维护架构
KNOWLEDGE_GOVERNANCE_RULES

## 任务完成标准
DELIVERY_CORE

## 交互规范
COMMON_INTERACTION

7. **定时任务**
AUTOMATION_RULES

8. **发送既有本地图片**
LOCAL_IMAGE_RULES
9. **AI 生图**
IMAGE_GENERATION_RULES
10. **PPT 视觉交付门禁**
PPT_VISUAL_GATE

## Profer 受管浏览器
BROWSER_RULES`

const ALL_TOOLS = [
  'BrowserObserve',
  'mcp__automation__create_automation',
  'mcp__collaboration__delegate_agent',
  'mcp__memory-archive__search_memory',
  'mcp__team-memory__search_team_memories',
  'send_local_image',
  'generate_image',
  'plan_ppt_visuals',
  'audit_ppt_delivery',
]

describe('buildPiTaskPrompt', () => {
  test('普通本地任务不携带低频产品 SOP，但保留 Pi 核心规则', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '帮我检查这个 TypeScript 文件的类型错误。',
      toolNames: ALL_TOOLS,
    })

    expect(prompt).toContain('CORE_PI_RULES')
    expect(prompt).toContain('UNCERTAINTY')
    expect(prompt).toContain('DELIVERY_CORE')
    expect(prompt).not.toContain('COLLABORATION_RULES')
    // 收尾候选检查由常驻的知识治理架构承担；Pi 专属文件记忆细节只在记忆任务按需恢复。
    expect(prompt).not.toContain('PI_MEMORY_RULES')
    expect(prompt).not.toContain('TEAM_MEMORY_RULES')
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).not.toContain('LOCAL_IMAGE_RULES')
    expect(prompt).not.toContain('PPT_VISUAL_GATE')
    expect(prompt).not.toContain('BROWSER_RULES')
  })

  test('PPT 任务在能力未激活时不恢复 PPT SOP，即使工具名称存在', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '请做成一个 pptx 幻灯片。',
      toolNames: ['plan_ppt_visuals', 'audit_ppt_delivery'],
      pptCapabilityActive: false,
    })
    expect(prompt).not.toContain('PPT_VISUAL_GATE')
  })

  test('网页与 PPT 任务仅恢复对应的实际可用工作流规则', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '打开 https://example.com，整理后做成一个 .pptx 演示文稿。',
      toolNames: ['BrowserObserve', 'inspect_deck_sources', 'create_deck_project', 'confirm_deck_brief', 'compile_deck_project', 'plan_ppt_visuals', 'audit_ppt_delivery'],
      pptCapabilityActive: true,
    })

    expect(prompt).toContain('BROWSER_RULES')
    expect(prompt).toContain('PPT_VISUAL_GATE')
    expect(prompt).toContain('PPT_VISUAL_GATE')
    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).not.toContain('COLLABORATION_RULES')
    expect(prompt).not.toContain('PI_MEMORY_RULES')
  })

  test('生图或修图任务仅在 generate_image 实际注册时恢复图片 SOP', () => {
    const enabled = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '请生成图片并把这张本地参考图修成绿色。',
      toolNames: ['generate_image'],
    })
    expect(enabled).toContain('IMAGE_GENERATION_RULES')

    const unavailable = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '请生成图片。',
      toolNames: [],
    })
    expect(unavailable).not.toContain('IMAGE_GENERATION_RULES')
  })

  test('长期自动化、协作与记忆任务恢复对应规则', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '开几个子 Agent 并行研究，并且每周自动汇总；把结论记住供跨会话复用。',
      toolNames: ALL_TOOLS,
    })

    expect(prompt).toContain('COLLABORATION_RULES')
    expect(prompt).toContain('AUTOMATION_RULES')
    expect(prompt).toContain('PI_MEMORY_RULES')
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
    expect(prompt).not.toContain('BROWSER_RULES')
  })

  test('自动任务运行上下文强制保留 automation SOP，避免用户任务文本本身不含周期词时漏注入', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '检查上次汇总的失败原因。',
      toolNames: ['mcp__automation__get_automation'],
      forceAutomation: true,
    })

    expect(prompt).toContain('AUTOMATION_RULES')
  })

  test('语义命中但能力未注册时，不注入会暗示不存在工具的 SOP', () => {
    const prompt = buildPiTaskPrompt({
      basePrompt: BASE_PROMPT,
      userMessage: '请访问网页，每天自动检查并开多个子 Agent。',
      toolNames: [],
    })

    expect(prompt).not.toContain('BROWSER_RULES')
    expect(prompt).not.toContain('AUTOMATION_RULES')
    expect(prompt).not.toContain('COLLABORATION_RULES')
    // 知识治理即使没有记忆工具也属于常驻行为规则，避免普通任务完全跳过收尾检查。
    expect(prompt).toContain('KNOWLEDGE_GOVERNANCE_RULES')
  })
})
