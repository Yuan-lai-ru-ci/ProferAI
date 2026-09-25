import type { ProferPluginViewInstance } from '@profer/plugin-api'

/**
 * 插件原生 View 的稳定实例键。
 *
 * Tab 和工具运行时使用独立实例，避免工具请求继承交互页面上下文。
 */
export function pluginViewKey(pluginId: string, pageId: string, instance: ProferPluginViewInstance = { kind: 'tab' }): string {
  if (instance.kind === 'tool') return `${pluginId}:${pageId}:tools`
  return instance.sessionId
    ? `${pluginId}:${pageId}:tab:${encodeURIComponent(instance.sessionId)}`
    : `${pluginId}:${pageId}:tab`
}
