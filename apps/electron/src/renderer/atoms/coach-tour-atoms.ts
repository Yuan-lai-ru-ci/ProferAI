/**
 * coach-tour-atoms — 界面蒙层引导（CoachTour）触发状态
 *
 * 触发入口在设置页与教程横幅（顶栏不再放常驻按钮），把 coachTourOpenAtom 置为 true，
 * App 顶层渲染 CoachTourOverlay；完成或跳过（Esc）后重置为 false。
 *
 * 纯会话内状态，不写持久化；「首次进入后自动接力播放」需要
 * settings 持久化字段，另行接入。
 */
import { atom } from 'jotai'

/** 是否展示界面蒙层引导 */
export const coachTourOpenAtom = atom(false)
