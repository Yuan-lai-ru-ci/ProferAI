/** 确定性任务信号；只用于推荐，不用于扩大预设权限或删掉合法 catalog。 */
import type { AgentPresetToolGroup } from '@profer/shared'

export interface SkillRoutingRules {
  keywords?: readonly string[]
  excludeKeywords?: readonly string[]
  requiredTools?: readonly string[]
  requiredMcpServers?: readonly string[]
  requiredToolGroups?: readonly AgentPresetToolGroup[]
  /** 默认 true。显式写成 false 时该 Skill 只接受 `/skill:<slug>` 类显式引用，不参与关键词与字符 n-gram 召回。 */
  implicit?: boolean
}

/**
 * 内置 Skill 的工具依赖兜底表。
 *
 * 依赖应由模块自己声明（SKILL.json 的 `dependencies`）——这是管理层的基本约定：模块说清自己需要
 * 什么，管理层只负责读取与校验。这里**只保留源码不在本仓库、因此加不了卡片的技能**（例如用户
 * 在某工作区自建的 agent-collaboration）；其余内置技能全部已迁到卡片。
 */
export const BUILTIN_SKILL_DEPENDENCIES: Readonly<Record<string, SkillRoutingRules>> = {
  // 源码在工作区自建目录（不是随包发布的 default-skills），无法在仓库里声明卡片。
  'agent-collaboration': { requiredToolGroups: ['collaboration'], requiredTools: ['delegate_agent'] },
}

const ACTION = /(?:请|帮我|修复|排查|实现|开发|优化|修改|重构|审查|检查|生成|创建|制作|合并|拆分|提取|总结|读取|分析|导出|转换|设计|构建|完善|补充|编写|做|\b(?:fix|debug|implement|build|create|review|refactor|merge|extract|summarize|convert|read|write|design|plan)\b)/i
const CODE = /(?:代码|单测|测试用例|回归测试|类型检查|适配器|源码|编译|接口|组件|前端|后端|[a-z0-9_-]+\.(?:tsx?|jsx?|py|rs|go|java|cpp)\b|\b(?:code|bug|adapter|runtime|sdk|api|react|typescript|test|typecheck)\b)/i
const NOT_CODE = /(?:不(?:要|用|需要)(?:再)?(?:写|改|修改)?代码|只(?:做|要)?分析|只读|只解释|do not (?:write|change) code)/i

export function cleanSkillTaskText(text: string): string {
  // 只看本次原始用户意图，不让引用历史、代码示例和内联 Skill 正文触发路由。
  return text.replace(/<(quoted_context|referenced_sessions|skill|skills|available_skills)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/```[^\n]*\n[\s\S]*?```/g, '')
}

function containsKeyword(text: string, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase()
  if (!normalized) return false
  const source = text.toLowerCase()
  if (!/^[a-z0-9_-]+$/.test(normalized)) return source.includes(normalized)
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:$|[^a-z0-9_-])`, 'i').test(source)
}

/** 返回可解释理由；undefined 表示不主动推荐，但合法 Skill 仍可发现。 */
export function skillTaskMatch(slug: string, message: string, rules: SkillRoutingRules): string | undefined {
  // 只允许显式引用：与 Codex 的 policy.allow_implicit_invocation=false 同义。
  if (rules.implicit === false) return undefined
  const text = cleanSkillTaskText(message)
  if (rules.excludeKeywords?.some(word => containsKeyword(text, word))) return undefined
  if (rules.keywords?.some(word => containsKeyword(text, word))) return 'configured-keyword'
  if (!ACTION.test(text)) return undefined
  switch (slug) {
    case 'code-honor': return CODE.test(text) && !NOT_CODE.test(text) ? 'code-task' : undefined
    case 'brainstorming': return CODE.test(text) && /(?:设计|新增|新功能|架构|需求|\b(?:design|new feature|architecture)\b)/i.test(text) && !NOT_CODE.test(text) ? 'feature-design' : undefined
    case 'writing-plans': return CODE.test(text) && /(?:计划|实施方案|任务拆分|分阶段|\b(?:implementation plan|plan)\b)/i.test(text) ? 'implementation-plan' : undefined
    case 'agent-collaboration': return /(?:并行|协作子|多个\s*Agent|多会话|委派|\b(?:parallel|delegate|subagents?)\b)/i.test(text) && !/(?:不要|无需|不用).{0,5}(?:并行|协作|委派|Agent)/i.test(text) ? 'parallel-task' : undefined
    case 'automation': return /(?:每天|每周|每月|定时|定期|周期|自动任务|运行记录|\b(?:recurring|scheduled|daily|weekly)\b)/i.test(text) && !/(?:不要|无需|不用).{0,5}(?:定时|自动|周期)|一次性|\b(?:one.off|do not schedule)\b/i.test(text) ? 'recurring-task' : undefined
    case 'in-app-browser': return /(?:浏览器|打开网页|网页操作|网站登录|\bbrowser\b|https?:\/\/)/i.test(text) && !/(?:不要|不使用|不用).{0,5}(?:浏览器|网页)|只用.*(?:API|MCP|CLI)/i.test(text) ? 'browser-task' : undefined
    case 'pdf': return /(?:\.pdf\b|\bPDF\b)/i.test(text) && !/(?:不要|无需|不用).{0,5}PDF/i.test(text) ? 'pdf-artifact' : undefined
    case 'docx': return /(?:\.docx\b|Word\s*(?:文档|文件)|\bWord document\b)/i.test(text) && !/(?:不要|无需|不用).{0,5}(?:Word|docx)/i.test(text) ? 'word-artifact' : undefined
    case 'xlsx': return /(?:\.(?:xlsx?|csv|tsv)\b|Excel|电子表格)/i.test(text) && !/(?:不要|无需|不用).{0,5}(?:Excel|电子表格)/i.test(text) ? 'spreadsheet-artifact' : undefined
    case 'pptx': return /(?:\.pptx\b|\bPPT\b|幻灯片|演示文稿|\bpresentation\b)/i.test(text) && !/(?:不要|无需|不用).{0,5}(?:PPT|幻灯片)|网页\s*PPT/i.test(text) ? 'presentation-artifact' : undefined
    default: return undefined
  }
}
