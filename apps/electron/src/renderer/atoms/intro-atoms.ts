/**
 * intro-atoms — 开屏动画（Intro Overlay）重播状态
 *
 * 用于从主界面手动触发「开屏水波纹动画」：
 *  - replayIntroOpenAtom 置为 true 时，App 顶层渲染全屏 IntroOverlay
 *  - 动画结束（或用户点按跳过）后回调将 atom 重置为 false
 *
 * 该入口不影响 onboardingCompleted 等持久化状态，纯粹用于重播/测试动画。
 */
import { atom } from 'jotai'

/** 是否展示全屏开屏动画重播遮罩 */
export const replayIntroOpenAtom = atom(false)

/** 主界面重播结束后是否展示首次 onboarding 的环境配置页（仅测试，不持久化）。 */
export const replayIntroEnvironmentTestAtom = atom(false)
