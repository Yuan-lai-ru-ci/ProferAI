import { describe, expect, test } from 'bun:test'
import { skillTaskMatch } from './skill-routing-rules'

/** 离线路由评测集：这些指标衡量确定性推荐，不冒充真实模型采用率。 */
const cases: Array<{ task: string; slug: string; expected: boolean }> = [
  { task: '修复 Claude adapter 的白名单透传并补回归测试', slug: 'code-honor', expected: true },
  { task: 'Please implement the API and test the code', slug: 'code-honor', expected: true },
  { task: '帮我优化 Button.tsx 的键盘交互', slug: 'code-honor', expected: true },
  { task: '设计新的 React 组件架构', slug: 'brainstorming', expected: true },
  { task: '请给出代码重构的分阶段实施计划', slug: 'writing-plans', expected: true },
  { task: '帮我并行开多个 Agent 审查源码', slug: 'agent-collaboration', expected: true },
  { task: 'Please delegate the code review in parallel', slug: 'agent-collaboration', expected: true },
  { task: '每天自动检查项目并汇总', slug: 'automation', expected: true },
  { task: '创建每周定时任务', slug: 'automation', expected: true },
  { task: '打开网页 https://example.com 并检查登录状态', slug: 'in-app-browser', expected: true },
  { task: '帮我合并附件合同.pdf 和 appendix.pdf', slug: 'pdf', expected: true },
  { task: '读取并总结附件里的 PDF', slug: 'pdf', expected: true },
  { task: '请创建 Word 文档并写好会议纪要', slug: 'docx', expected: true },
  { task: '清理 budget.xlsx 并转换为季度电子表格', slug: 'xlsx', expected: true },
  { task: 'Create a presentation for the quarterly review', slug: 'pptx', expected: true },
  { task: '你好', slug: 'code-honor', expected: false },
  { task: 'API 是什么意思？', slug: 'code-honor', expected: false },
  { task: '不要修改代码，只分析原因', slug: 'code-honor', expected: false },
  { task: '解释如何创建 PDF，但不要 PDF 文件', slug: 'pdf', expected: false },
  { task: 'PDF 和 Word 有什么区别？', slug: 'pdf', expected: false },
  { task: '请一次性检查项目，不要定时任务', slug: 'automation', expected: false },
  { task: '请检查 API，不用浏览器', slug: 'in-app-browser', expected: false },
  { task: '帮我审查源码，不要并行', slug: 'agent-collaboration', expected: false },
  { task: '<quoted_context>创建 PPT 幻灯片</quoted_context>你好', slug: 'pptx', expected: false },
  { task: '解释示例\n```text\n每天自动检查项目\n```', slug: 'automation', expected: false },
  { task: 'Skill 门禁的设计有什么问题？', slug: 'brainstorming', expected: false },
  { task: '帮我写一封感谢邮件', slug: 'docx', expected: false },
  { task: '创建普通 HTML 页面，不要 PPT', slug: 'pptx', expected: false },
  { task: '我不需要定时任务，帮我理解一下日报周报自动汇总这件事的长期价值', slug: 'automation', expected: false },
  { task: '帮我审查源码，不需要并行', slug: 'agent-collaboration', expected: false },
  { task: '请检查 API，不需要浏览器', slug: 'in-app-browser', expected: false },
  { task: '创建普通 HTML 页面，不需要 PPT', slug: 'pptx', expected: false },
]

describe('Skill 触发离线评测', () => {
  for (const sample of cases) test(`${sample.expected ? '应推荐' : '不应推荐'} ${sample.slug}: ${sample.task}`, () => {
    expect(Boolean(skillTaskMatch(sample.slug, sample.task, {}))).toBe(sample.expected)
  })
  test('自定义关键字按单词边界匹配，排除关键字优先', () => {
    expect(skillTaskMatch('custom', 'internet', { keywords: ['net'] })).toBeUndefined()
    expect(skillTaskMatch('custom', 'run net check', { keywords: ['net'] })).toBe('configured-keyword')
    expect(skillTaskMatch('custom', '不要发票核验', { keywords: ['发票'], excludeKeywords: ['不要'] })).toBeUndefined()
  })
})
