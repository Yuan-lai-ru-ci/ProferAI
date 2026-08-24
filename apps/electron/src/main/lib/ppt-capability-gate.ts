export type PptCapabilityDecision = 'activate' | 'stay_active' | 'deactivate' | 'inactive'

export interface EvaluatePptCapabilityInput {
  userMessage: string
  active: boolean
  hasActiveDeckProject: boolean
}

export interface EvaluatePptCapabilityResult {
  decision: PptCapabilityDecision
  active: boolean
  reason: 'explicit_exit' | 'explicit_ppt_intent' | 'active_session' | 'deck_continuation' | 'no_ppt_intent'
}

const PPT_ARTIFACT_PATTERN = /(?:\.pptx\b|\bppt\b|幻灯片|演示文稿|演示稿|slides?|presentation)/i
const PPT_ACTION_PATTERN = /(?:创建|制作|生成|做成|导出|输出|修改|编辑|重做|预览|打开|继续|汇报|课件|演示|presentation|slides?)/i
const DECK_CONTINUATION_PATTERN = /(?:第\s*\d+\s*页|这份(?:PPT|幻灯片|演示文稿)|这个\s*deck|刚才的(?:PPT|幻灯片|演示)|继续(?:做|修改|完善)|刷新预览|打开预览)/i
const EXIT_PATTERN = /(?:退出|关闭|停止|不要(?:再)?继续|先不要).*?(?:PPT|幻灯片|演示文稿|演示稿|slides?|presentation).*?(?:模式|工作流|任务)?/i

/**
 * Determine whether the current session should expose PPT-specific capability.
 * This is intentionally a pure, conservative gate: activation exposes tools only;
 * Deck Brief confirmation remains a separate compile-time write gate.
 */
export function evaluatePptCapability(input: EvaluatePptCapabilityInput): EvaluatePptCapabilityResult {
  const message = input.userMessage.trim()
  if (EXIT_PATTERN.test(message)) {
    return { decision: 'deactivate', active: false, reason: 'explicit_exit' }
  }

  if (input.active) {
    return { decision: 'stay_active', active: true, reason: 'active_session' }
  }

  const explicitPptIntent = PPT_ARTIFACT_PATTERN.test(message) && PPT_ACTION_PATTERN.test(message)
  if (explicitPptIntent) {
    return { decision: 'activate', active: true, reason: 'explicit_ppt_intent' }
  }

  if (input.hasActiveDeckProject && DECK_CONTINUATION_PATTERN.test(message)) {
    return { decision: 'activate', active: true, reason: 'deck_continuation' }
  }

  return { decision: 'inactive', active: false, reason: 'no_ppt_intent' }
}
