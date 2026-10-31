/**
 * coach-tour-steps — 界面蒙层引导的步骤定义
 *
 * 每步给出按优先级排列的 CSS 选择器，引擎取第一个「可见且非零尺寸」
 * 的元素作为高亮锚点；全部找不到时气泡居中降级，不阻断流程。
 *
 * unionSelectors：锚点由多个分散容器组成（如技能页 = 头部 + 内容区两个并列
 * max-w-6xl 列，没有公共可见父级）时，对所有命中元素取外接矩形。
 *
 * view：进入该步前先把主内容区切到对应视图，保证锚点在正确的上下文里；
 * 引导退出时引擎会恢复用户原来的视图。
 *
 * advanceOn: 'click-anchor' 表示交互步骤——聚光灯镂空放行真实点击，
 * 等用户自己点击高亮区域（如侧栏入口）后才前进，让用户亲手走到目标页面；
 * 此时隐藏「下一步」按钮（锚点缺失时降级为手动下一步，不会卡住）。
 *
 * 改动提示：增删步骤或大改文案时 +1 CURRENT_COACH_TOUR_VERSION，
 * 已看过的用户升级后会自动重播一次新版本。
 */

import type { ActiveView } from '@/atoms/active-view'
import type { CoachTourPlacement } from './coach-tour-position'

export interface CoachTourStep {
  key: string
  title: string
  body: string
  /** 依次尝试的 CSS 选择器；第一个可见元素作为高亮目标 */
  selectors: string[]
  /** 气泡相对目标的偏好方位；空间不足时自动回退其他方位，auto 优先下方 */
  placement: CoachTourPlacement
  /** 进入该步前切换的主内容区视图；缺省不切 */
  view?: ActiveView
  /** 缺省为手动「下一步」；'click-anchor' 需用户亲自点击高亮锚点才前进 */
  advanceOn?: 'click-anchor'
  /** 提供时取代 selectors：对所有命中元素取外接矩形作为锚点 */
  unionSelectors?: string[]
  /** 收尾步：气泡改用「完成卡片」样式，给出下一步建议 */
  finale?: boolean
}

export const COACH_TOUR_STEPS: CoachTourStep[] = [
  {
    key: 'mode-switch',
    title: '两种工作模式',
    body: 'Agent 会自己规划并执行多步任务；Chat 专注轻量问答。两边会话独立，⌘B 可以收起侧栏。',
    selectors: ['[data-tour="mode-switch"]', '[data-profer-navigation-region="mode-switcher"]'],
    placement: 'right',
    view: 'conversations',
  },
  {
    key: 'new-session',
    title: '新建会话',
    body: '一个任务一个会话，上下文干净。历史会话可置顶，也能并排打开两个 Tab 对照。',
    selectors: ['[data-profer-navigation-item="new-session"]'],
    placement: 'right',
    view: 'conversations',
  },
  {
    key: 'chat-input',
    title: '输入区',
    body: '@ 引用文件，/ 调用 Skill，# 调用 MCP 工具，& 引用其他会话。点一下输入框试试。',
    selectors: ['[data-input-mode="chat"]', '[data-input-mode="agent"]'],
    placement: 'top',
    view: 'conversations',
    advanceOn: 'click-anchor',
  },
  {
    key: 'model-selector',
    title: '切换模型',
    body: '写作、分析、编程各有所长。这里随时切换，立刻生效；默认模型可以在设置里固定。',
    selectors: ['.model-selector-trigger'],
    placement: 'top',
    view: 'conversations',
  },
  {
    key: 'planning-enter',
    title: 'Todo、日程与定时任务',
    body: '三块各自一个入口：Todo 记要做的、日程排时间、定时任务到点自动跑。点 Todo 进去看看。',
    selectors: ['[data-profer-navigation-item="planning-todos"]'],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'planning-view',
    title: '三块互不打扰',
    body: '左边三个入口随时直达；任务跑完会把结果写回会话并推送提醒。',
    selectors: ['[data-tour="planning-panel"]', '[data-profer-navigation-region="planning"]'],
    placement: 'auto',
  },
  {
    key: 'skills-enter',
    title: 'Agent 技能',
    body: '把最佳实践沉淀成 Skill，一次写好、反复调用。点进去看看技能库。',
    selectors: ['[data-profer-navigation-item="agent-skills"]'],
    placement: 'right',
    advanceOn: 'click-anchor',
  },
  {
    key: 'skills-view',
    title: '技能库与岗位',
    body: 'Skills、MCP 和岗位预设集中在这里，开关控制它在哪些会话生效。',
    selectors: [],
    unionSelectors: ['[data-tour="agent-skills-header"]', '[data-tour="agent-skills-panel"]'],
    placement: 'auto',
  },
  {
    key: 'memory-enter',
    title: 'Agent 记忆',
    body: '工作区记忆已经独立成入口：项目规则、稳定偏好和踩过的坑都沉淀在这里，随时可查可改。',
    selectors: ['[data-profer-navigation-item="agent-memory"]'],
    placement: 'right',
  },
  {
    key: 'outro',
    title: '好了，剩下的交给你',
    body: '主要入口已经走了一遍。接下来最值得做的三件事：',
    selectors: [],
    placement: 'auto',
    finale: true,
  },
]

/** 引导内容版本：增删步骤/大改文案时 +1，老用户升级后自动重播一次新指引 */
export const CURRENT_COACH_TOUR_VERSION = 8
