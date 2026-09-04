/**
 * UiScaleContainer — 界面等比缩放容器
 *
 * 传统网页缩放实现：内容整体 `transform: scale(s)` 等比放大（px/rem 全部跟随，
 * 无畸变），同时容器宽高反补偿为 `(100/s)%` —— 视觉上放大后的内容恰好占满视口，
 * 不溢出、不裁切，有限区域保持不变。
 *
 * 结构始终渲染外层高度壳（h-[100dvh]），子组件统一用 h-full/w-full 占满；
 * s === 1（标准）时内层不加 transform，等效透传、零开销。
 * 注意：transform 会创建 containing block，容器内的 position:fixed 元素将相对本容器
 * 定位——本容器逻辑尺寸即 (100/s)% 视口，inset-0 的 fixed 视觉上仍铺满全屏，行为等价。
 * Radix 弹层（Dialog/Tooltip/Dropdown 等）默认 Portal 到 body，不受影响。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { uiScaleAtom, UI_SCALE_VALUES } from '@/atoms/ui-scale'

export function UiScaleContainer({ children }: { children: React.ReactNode }): React.ReactElement {
  const scale = useAtomValue(uiScaleAtom)
  const s = UI_SCALE_VALUES[scale]

  return (
    <div className="h-[100dvh] w-full overflow-hidden">
      <div
        className="h-full w-full"
        style={
          s === 1
            ? undefined
            : {
                transform: `scale(${s})`,
                transformOrigin: 'top left',
                width: `${100 / s}%`,
                height: `${100 / s}dvh`,
              }
        }
      >
        {children}
      </div>
    </div>
  )
}
