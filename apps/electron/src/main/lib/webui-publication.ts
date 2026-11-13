/**
 * WebUI 发布位的回收（写侧）。
 *
 * 「发布」= 把一个会话挂进 `webuiPublishedSessionIds`，对外提供 `/s/<id>` 页面。
 * 归档的语义是「这件事结束了」，留着一个还能访问的网页与之矛盾；删除更是直接指向不存在的会话。
 * 所以这两处必须顺手把发布位收回来，否则设置面板里会留幽灵条目、外部链接继续可用。
 *
 * 分层：本模块只依赖 settings-service 与 webui-routing，**不 import 会话存储**，
 * 这样才能被 `agent-session-manager` 反向调用而不形成循环依赖。
 * 读侧（「这个会话还能不能对外服务」）在 `webui-session-guard.ts`。
 */
import { getSettings, updateSettings } from './settings-service'
import { normalizePublishedIds } from './webui-routing'

/**
 * 取消某个会话的 WebUI 发布位。返回是否真的移除了条目。
 *
 * 归档 / 删除是主流程，不能被设置写入的失败阻断 —— 所以这里吞掉异常只记日志：
 * 结果是「设置里残留一个已经不可服务的 id」，由读侧兜底（路由 404、面板不显示）。
 */
export function retractWebuiPublication(sessionId: string): boolean {
  const current = normalizePublishedIds(getSettings().webuiPublishedSessionIds)
  if (!current.includes(sessionId)) return false
  const next = current.filter((id) => id !== sessionId)
  try {
    updateSettings({ webuiPublishedSessionIds: next })
    console.log(`[WebUI] 会话已归档或删除，自动取消发布: ${sessionId}`)
    return true
  } catch (error) {
    console.warn('[WebUI] 自动取消发布失败，将由访问侧兜底:', error)
    return false
  }
}
