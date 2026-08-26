/**
 * Pi 的按需提示词注入。
 *
 * Pi 不使用 Claude 的 preset，因此完整 Profer prompt 会在每一轮随 Pi systemPrompt
 * 进入模型上下文。这里保留运行安全与交付底线，将低频产品 SOP 仅在用户任务命中且
 * 对应工具实际注册时追加。工具本身始终由 ToolDefinition 暴露，漏判只会少辅助说明，
 * 不会隐藏能力或改变权限。
 */

export interface PiTaskPromptOptions {
  /** 仅传 buildSystemPrompt() 的原始输出，不要在此之前拼接附件/预设自定义段落。 */
  basePrompt: string
  userMessage: string
  toolNames: Iterable<string>
  /** 自动任务运行时即使用户文本未出现周期关键词，也需要完整 Automation SOP。 */
  forceAutomation?: boolean
  /** PPT 专用能力是否已由会话级门禁激活。 */
  pptCapabilityActive?: boolean
}

interface PromptSection {
  text: string
  rest: string
}

function removeSection(prompt: string, startMarker: string, endMarker: string): PromptSection | undefined {
  const start = prompt.indexOf(startMarker)
  if (start < 0) return undefined
  const end = prompt.indexOf(endMarker, start + startMarker.length)
  if (end < 0) return undefined
  return {
    text: prompt.slice(start, end).trim(),
    rest: `${prompt.slice(0, start)}${prompt.slice(end)}`,
  }
}

function hasAnyTool(toolNames: Set<string>, predicate: (name: string) => boolean): boolean {
  return [...toolNames].some(predicate)
}

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text)
}

/**
 * 返回本轮 Pi 实际使用的 system prompt。
 *
 * 低频 SOP 从基础 prompt 中取出后按任务恢复，以保持其文案与 Claude 的完整版本一致，
 * 不在两个文件里复制长规则。所有 marker 都是本模块控制的稳定 heading；如果以后某段
 * 文案变更导致未找到 marker，函数保守地保留原始 prompt，绝不静默丢失安全指令。
 */
export function buildPiTaskPrompt(options: PiTaskPromptOptions): string {
  const tools = new Set(options.toolNames)
  const task = options.userMessage
  const lowFrequency: string[] = []
  let prompt = options.basePrompt

  const collaboration = removeSection(prompt, '## SubAgent 委派策略', '## Pi Agent Runtime')
  if (collaboration) {
    prompt = collaboration.rest
    const needsCollaboration = hasAnyTool(tools, (name) => name.startsWith('mcp__collaboration__'))
      && matches(task, /(?:\b(?:agent|agents|subagent|sub-agent|parallel|delegate|delegation)\b|子\s*Agent|多会话|并行|协作|委派)/i)
    if (needsCollaboration) lowFrequency.push(collaboration.text)
  }

  const piMemory = removeSection(prompt, '### Pi Runtime 与文件记忆', '## 用户信息')
  if (piMemory) {
    prompt = piMemory.rest
    const hasMemoryTool = hasAnyTool(tools, (name) => name.startsWith('mcp__memory-archive__') || name.startsWith('mcp__team-memory__'))
    // 完整的知识维护与收尾回写规则由常驻的「Profer 知识维护架构」承载；此处只保留
    // Pi 专属文件操作细节，按记忆任务按需恢复，避免普通本地任务重复携带长段落。
    const needsPiMemory = hasMemoryTool
      && matches(task, /(?:记住|记忆|沉淀|归档|复用|memory|memories|知识维护|经验记录|更新.*(?:MEMORY|记忆))/i)
    if (needsPiMemory) lowFrequency.push(piMemory.text)
  }

  const teamMemory = removeSection(prompt, '## 团队共享知识记忆', '## 不确定性处理')
  if (teamMemory) {
    prompt = teamMemory.rest
    const needsTeamMemory = hasAnyTool(tools, (name) => name.startsWith('mcp__team-memory__'))
      && matches(task, /(?:团队记忆|共享知识|团队规范|team memory|团队.*(?:记住|记录|经验))/i)
    if (needsTeamMemory) lowFrequency.push(teamMemory.text)
  }

  const knowledgeGovernance = removeSection(prompt, '## Profer 知识维护架构', '## 任务完成标准')
  if (knowledgeGovernance) {
    prompt = knowledgeGovernance.rest
    // 知识维护是跨任务的常驻行为约束，不能只在出现“记忆”关键词时注入。
    lowFrequency.push(knowledgeGovernance.text)
  }

  const automation = removeSection(prompt, '7. **定时任务**', '8. **发送既有本地图片**')
  if (automation) {
    prompt = automation.rest
    const needsAutomation = hasAnyTool(tools, (name) => name.startsWith('mcp__automation__'))
      && (options.forceAutomation || matches(task, /(?:定期|周期|每天|每周|每月|每隔|持续关注|持续观察|长期跟进|长期监控|自动检查|自动汇总|自动生成|自动复盘|无人值守|提醒|运行记录|自动任务|automation|scheduled|recurring|monitor)/i))
    if (needsAutomation) lowFrequency.push(automation.text)
  }

  const delivery = removeSection(prompt, '8. **发送既有本地图片**', '## Profer 受管浏览器')
  if (delivery) {
    prompt = delivery.rest
    const hasImageOutput = tools.has('send_local_image')
    const hasPptWorkflow = options.pptCapabilityActive === true
      && tools.has('plan_ppt_visuals')
      && tools.has('audit_ppt_delivery')
    const needsImageOutput = hasImageOutput
      && matches(task, /(?:发送|附上|展示|回复).*?(?:图片|图像|png|jpe?g|gif|webp)|(?:本地|已有).{0,8}(?:图片|图像)/i)
    const needsImageGenerationRouting = tools.has('generate_image')
      && matches(task, /(?:生成图片|画图|画一张|生图|p\s*图|修图|image generation)/i)
    const needsPpt = hasPptWorkflow && matches(task, /(?:\.pptx\b|\bppt\b|幻灯片|演示文稿|presentation|slides?)/i)
    if (needsImageOutput || needsImageGenerationRouting || needsPpt) lowFrequency.push(delivery.text)
  }

  // Browser 是 buildSystemPrompt 的最后一个 section，直接截取尾部；若日后在它后面
  // 新增常驻内容，应改为显式 end marker，避免把新常驻内容错误降级。
  const browserStart = prompt.indexOf('## Profer 受管浏览器')
  if (browserStart >= 0) {
    const browser = prompt.slice(browserStart).trim()
    prompt = prompt.slice(0, browserStart)
    const hasBrowser = hasAnyTool(tools, (name) => name.startsWith('Browser'))
    const needsBrowser = hasBrowser && matches(task, /(?:https?:\/\/|\b(?:browser|website|webpage|url|login|screenshot)\b|网页|网站|浏览|打开.*(?:页|网)|站内搜索|截图|登录)/i)
    if (needsBrowser) lowFrequency.push(browser)
  }

  return lowFrequency.length > 0 ? `${prompt.trim()}\n\n${lowFrequency.join('\n\n')}` : prompt.trim()
}
