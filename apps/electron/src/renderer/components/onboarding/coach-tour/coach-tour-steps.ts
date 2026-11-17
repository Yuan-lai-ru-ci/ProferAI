/**
 * coach-tour-steps — 界面蒙层引导的步骤定义
 *
 * 设计目标（v9 重写）：
 *  - **短**。首次进入时用户只想开始干活，不是来上产品培训课。5 步讲完
 *    「模式、新建、输入区、规划、技能」这五个真正常用的入口，其余交给教程与
 *    设置里的重播。
 *  - **不强制跳转**。旧版带 `view` 字段的步骤会把主内容区切到规划页/技能页，
 *    退出再切回来——用户会感觉界面自己在动。现在所有步骤都停留在用户当前
 *    所在的会话视图，只做「高亮 + 说明」。
 *  - **不强制点击**。旧版 `advanceOn: 'click-anchor'` 要求用户亲自点一下才能
 *    继续，点歪了就卡住。现在统一用「下一步」，键盘 → 与 Enter 同样可前进。
 *
 * 每步给出按优先级排列的 CSS 选择器，引擎取第一个「可见且非零尺寸」的元素作为
 * 高亮锚点；全部找不到时气泡居中降级，不阻断流程。
 *
 * 改动提示：增删步骤或大改文案时 +1 CURRENT_COACH_TOUR_VERSION，
 * 已看过的用户升级后会自动重播一次新版本。
 */

import type { CoachTourPlacement } from './coach-tour-position'

export interface CoachTourStep {
  key: string
  title: string
  body: string
  /** 依次尝试的 CSS 选择器；第一个可见元素作为高亮目标 */
  selectors: string[]
  /** 气泡相对目标的偏好方位；空间不足时自动回退其他方位 */
  placement: CoachTourPlacement
  /** 提供时取代 selectors：对所有命中元素取外接矩形作为锚点 */
  unionSelectors?: string[]
  /** 收尾步：气泡改用「完成卡片」样式，给出下一步建议 */
  finale?: boolean
}

export const COACH_TOUR_STEPS: CoachTourStep[] = [
  {
    key: 'mode-switch',
    title: 'Agent 与 Chat',
    body: 'Agent 会自己拆步骤、读文件、跑命令；Chat 只做问答。两边会话各自独立，随时切。',
    selectors: ['[data-tour="mode-switch"]', '[data-profer-navigation-region="mode-switcher"]'],
    placement: 'right',
  },
  {
    key: 'new-session',
    title: '一个任务一个会话',
    body: '每个会话的上下文是干净的。历史会话可以置顶，也能并排开两个对照着看。',
    selectors: ['[data-profer-navigation-item="new-session"]'],
    placement: 'right',
  },
  {
    key: 'composer',
    title: '输入区',
    body: '@ 引用文件，/ 调用 Skill，# 调用 MCP 工具，& 引用其他会话。先说目标，细节它会自己问。',
    selectors: ['[data-input-mode="agent"]', '[data-input-mode="chat"]'],
    placement: 'top',
  },
  {
    key: 'planning-entries',
    title: 'Todo、日程、定时任务',
    body: '三个独立入口：记要做的、排时间、到点自动跑。任务跑完会把结果写回会话。',
    selectors: [],
    // 文案讲的是「三个入口」，高亮必须把三个一起框进去，否则用户会以为只有 Todo 能用。
    unionSelectors: [
      '[data-profer-navigation-item="planning-todos"]',
      '[data-profer-navigation-item="planning-calendar"]',
      '[data-profer-navigation-item="planning-automations"]',
    ],
    placement: 'right',
  },
  {
    key: 'skills-entry',
    title: 'Agent 技能',
    body: '把跑通的流程存成 Skill，下次一句话调用。Skills、MCP 和岗位预设都在这里。',
    selectors: ['[data-profer-navigation-item="agent-skills"]'],
    placement: 'right',
  },
  {
    key: 'outro',
    title: '就这些',
    body: '五个入口都在左侧栏，随时能回到这里。现在开始第一个任务，比看完所有说明更有用。',
    selectors: [],
    placement: 'auto',
    finale: true,
  },
]

/** 引导内容版本：增删步骤/大改文案时 +1，老用户升级后自动重播一次新指引 */
export const CURRENT_COACH_TOUR_VERSION = 9
