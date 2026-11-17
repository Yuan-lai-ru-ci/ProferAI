/**
 * WebUI 发布位的可服务判定（读侧）。
 *
 * 白名单是持久化的，而会话状态会变（归档、删除）。写在设置里的 id 不能当成「仍然有效」，
 * 每次判定都要回到会话索引：
 *  - 归档：页面必须停（与「这件事结束了」一致）
 *  - 删除：索引里没有了，页面自然也不该存在
 *
 * 与 `webui-publication.ts` 分开是因为依赖方向不同：那边被会话存储反向调用，
 * 这边需要读会话索引，合并会形成循环。
 */
import { getAgentSessionMeta } from './agent-session-manager'

/** 这个会话当前是否还应该对外提供 WebUI 页面。 */
export function isSessionServableForWebui(sessionId: string): boolean {
  const meta = getAgentSessionMeta(sessionId)
  return Boolean(meta) && meta?.archived !== true
}

/**
 * 过滤掉已经不可服务的发布位。
 *
 * 用于设置面板与状态回显：老版本留下的「已归档但仍发布」条目不会继续显示成有效条目，
 * 用户不必手工清理。
 */
export function filterServablePublications(ids: readonly string[]): string[] {
  return ids.filter(isSessionServableForWebui)
}
