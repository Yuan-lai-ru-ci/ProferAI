/**
 * MainArea — 主内容区域
 *
 * 组合 TabBar + SplitContainer。设置以浮窗形式叠加显示。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { tabsAtom } from '@/atoms/tab-atoms'
import { Panel } from '@/components/app-shell/Panel'
import { SettingsDialog } from '@/components/settings'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import { TabBar } from './TabBar'
import { SplitContainer } from './SplitContainer'

export function MainArea(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)

  // [FLASH-DEBUG] 监控 tabs 变化，如果 tabs.length 变为 0 说明所有标签被卸载
  React.useEffect(() => {
    if (tabs.length === 0) {
      console.warn('[FLASH-DEBUG] MainArea: tabs.length === 0, showing WelcomeView!', new Error().stack)
    }
  }, [tabs.length])

  return (
    <>
      <Panel
        variant="grow"
        className="bg-content-area/95 backdrop-blur-xl rounded-2xl shadow-xl"
      >
        <TabBar />
        {tabs.length === 0 ? (
          <WelcomeView />
        ) : (
          <SplitContainer />
        )}
      </Panel>
      <SettingsDialog />
    </>
  )
}
