/**
 * 界面缩放状态原子
 *
 * 六档界面大小（标准 100% … 最大 200%），缩放实现为「传统网页等比缩放」：
 * `<UiScaleContainer>` 组件把内容整体 `transform: scale(s)` 等比放大（px/rem 全部
 * 一起放大，无畸变），同时把容器宽高反补偿为 `(100/s)%`，视觉上恰好占满视口、
 * 不溢出——区域保持有限，只放大 UI。
 *
 * ⚠️ 不要改回 documentElement 级缩放（CSS zoom / 根 font-size）：
 * - zoom：布局尺寸一起放大，视口约束被打破，内容溢出裁切（用户反馈“打破有限区域”）；
 * - 根 font-size（rem）：固定 px 元素不跟随，比例失调畸变（用户反馈“畸变”）。
 * transform:scale + 容器反补偿是同时满足“等比 + 区域保持”的唯一正解。
 *
 * 桌面与平板共用同一套代码：
 *   - 桌面：localStorage 缓存（同步读取防启动闪烁）+ settings.json 持久化（权威，
 *     经 electronAPI.updateSettings，字段见 AppSettings.uiScale）
 *   - 平板：localStorage 缓存（electronapi-stub 的 getSettings/updateSettings 为空实现，
 *     自动降级到纯本地缓存）
 * - 平板端首次访问无缓存时保持 standard（与原版观感一致），需要放大时在设置里调节；
 *   tablet/main.tsx 调用 initTabletUiScale(store) 覆盖默认值；桌面保持 standard。
 */

import { atom } from 'jotai'
import { DEFAULT_UI_SCALE } from '../../types/settings'
import type { UiScale } from '../../types/settings'

/** 各档位对应的整体缩放比例 */
export const UI_SCALE_VALUES: Record<UiScale, number> = {
  standard: 1,
  large: 1.1,
  xlarge: 1.25,
  huge: 1.5,
  massive: 1.75,
  max: 2,
}

/** 设置页选项 */
export const UI_SCALE_OPTIONS: { value: UiScale; label: string }[] = [
  { value: 'standard', label: '标准 100%' },
  { value: 'large', label: '大 110%' },
  { value: 'xlarge', label: '特大 125%' },
  { value: 'huge', label: '超大 150%' },
  { value: 'massive', label: '巨大 175%' },
  { value: 'max', label: '最大 200%' },
]

/** localStorage 缓存键 */
const UI_SCALE_CACHE_KEY = 'profer-ui-scale'

/**
 * 从 localStorage 读取缓存的界面缩放档位（无缓存返回 null）
 */
function getCachedUiScale(): UiScale | null {
  try {
    const cached = localStorage.getItem(UI_SCALE_CACHE_KEY)
    if (cached && cached in UI_SCALE_VALUES) {
      return cached as UiScale
    }
  } catch {
    // localStorage 不可用时忽略
  }
  return null
}

/**
 * 缓存界面缩放档位到 localStorage
 */
function cacheUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(UI_SCALE_CACHE_KEY, scale)
  } catch {
    // localStorage 不可用时忽略
  }
}

/** 用户选择的界面缩放档位 */
export const uiScaleAtom = atom<UiScale>(getCachedUiScale() ?? DEFAULT_UI_SCALE)

/**
 * 更新界面缩放档位并持久化（localStorage + settings.json；平板 stub 自动降级）。
 * DOM 应用由 <UiScaleContainer> 依据 uiScaleAtom 自动完成，此处无需操作 DOM。
 */
export async function updateUiScale(scale: UiScale): Promise<void> {
  cacheUiScale(scale)
  try {
    await window.electronAPI.updateSettings({ uiScale: scale })
  } catch (error) {
    console.error('[界面缩放] 持久化失败:', error)
  }
}

/**
 * 初始化界面缩放（桌面）
 *
 * 从主进程读取持久化设置并同步到 atom + localStorage（localStorage 已有值时以
 * settings.json 为权威校正）。DOM 应用由 <UiScaleContainer> 依据 atom 完成。
 */
export async function initializeUiScale(
  setScale: (scale: UiScale) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const stored = settings.uiScale
    if (stored && stored in UI_SCALE_VALUES) {
      setScale(stored as UiScale)
      cacheUiScale(stored as UiScale)
    }
  } catch (error) {
    console.error('[界面缩放] 初始化失败:', error)
  }
}

/**
 * 初始化界面缩放（平板）
 *
 * 平板无 Electron settings.json（stub 为空实现），只使用 localStorage。
 * 首次访问无缓存时保持 standard（100%，与原版观感一致，需要放大时在设置里调）；
 * 已有用户选择则保持。
 * 需在 tablet/main.tsx 渲染前调用，并把档位写入平板 store 的 uiScaleAtom
 * （atom 默认值在模块加载时已固定，直接改 localStorage 不会驱动组件）。
 */
export function initTabletUiScale(store: { set: (atom: typeof uiScaleAtom, value: UiScale) => void }): void {
  const cached = getCachedUiScale()
  const next: UiScale = (cached && cached in UI_SCALE_VALUES) ? cached : 'standard'
  if (!cached) cacheUiScale(next)
  store.set(uiScaleAtom, next)
}
