import * as React from 'react'
import { AgentPresetSettings } from './AgentPresetSettings'

/**
 * 兼容旧导入路径；全局预设实际交互统一由 AgentPresetSettings 承载。
 * 保留这个轻量包装，避免未来误接入已废弃的旧范围改绑实现。
 */
export function GlobalPresetSettings(): React.ReactElement {
  return <AgentPresetSettings globalMode />
}
