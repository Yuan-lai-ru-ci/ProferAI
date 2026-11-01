/**
 * navigation-items — 「消息导航」条目的纯逻辑。
 *
 * 背景：导航总数必须覆盖**整个会话**，而渲染层手里只有已加载的尾部消息（分页一页 60 条，
 * 本地还会再切一刀渲染窗口 30 组）。所以导航以主进程的全量轮次索引为骨架，本地已加载的
 * 分组只用于补头像、以及把「刚发出、尚未落盘」的尾部轮次追加到索引末尾。
 *
 * 这里只放无 React/Jotai 依赖的纯函数，便于单测锁住计数与去重语义。
 * 唯一键的实现抽在 `@/lib/navigation-item-key`，与面板列表共用同一份，避免两处各抄一份。
 */
import type { AgentNavigationIndexEntry, SDKMessage, SDKSystemMessage } from '@profer/shared'
import { stripUserContextBlocks } from '@profer/session-core'
import { getGroupNavKey, getGroupPreview, type MessageGroup } from './SDKMessageRenderer'
import { isTaskSourceInput, projectTaskInputTimeline } from '@/lib/task-input-timeline'
import { navigationItemKey } from '@/lib/navigation-item-key'

/** 与 ScrollMinimap 的 MinimapItem 结构一致（只取导航需要的最小字段）。 */
export interface NavigationItem {
  /** 滚动锚点 id（消息 uuid）；无 uuid 时为 null，需用 matchKey 回退匹配 */
  id: string | null
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
  /** 无 id 时的稳定匹配键（`${role}:${subtype}:${createdAt}`） */
  matchKey?: string
  /** 状态类来源卡也可能开启独立导航轮。 */
  startsTurn?: boolean
}

/** 导航条目的唯一键（有 uuid 用 uuid，无 uuid 用匹配键）；与面板列表共用同一实现。 */
export const navItemKey = navigationItemKey

/** 分组内可作滚动锚点的身份字段。 */
function groupIdentity(group: MessageGroup): { uuid: string | null; subtype: string; createdAt: string } {
  const anchor = (group.type === 'assistant-turn'
    ? group.assistantMessages[0]
    : group.message) as unknown as Record<string, unknown> | undefined
  const uuid = typeof anchor?.uuid === 'string' && anchor.uuid.length > 0 ? anchor.uuid : null
  const subtype = typeof anchor?.subtype === 'string' ? anchor.subtype : ''
  const createdAt = typeof anchor?._createdAt === 'number' ? String(anchor._createdAt) : ''
  return { uuid, subtype, createdAt }
}

/** 本地分组 → 导航条目的基础字段（不含头像，头像由调用方按 id/匹配键补）。 */
export function navigationItemFromGroup(group: MessageGroup): NavigationItem {
  const { uuid } = groupIdentity(group)
  const returnReferences = group.type === 'user' && Array.isArray(group.message._taskReturnReferences)
    ? group.message._taskReturnReferences
    : undefined
  return {
    // 磁盘上没有 uuid 的分组（interruption_record 等）在渲染层会拿到一个会话顺序相关的
    // 回退 id；那是 DOM 内部的 key，**不能**当导航身份（与主进程索引对不上），所以置 null，
    // 改用 matchKey 回退匹配。
    id: uuid,
    role: group.type === 'user' ? isTaskSourceInput(group.message) ? 'status' : 'user' : group.type === 'system' ? 'status' : 'assistant',
    preview: returnReferences?.length
      ? `子会话返回：${returnReferences.map(reference => reference.title).join('、')}`
      : getGroupPreview(group),
    startsTurn: !!returnReferences?.length,
    model: group.type === 'assistant-turn' ? group.model : undefined,
    matchKey: getGroupNavKey(group),
  }
}

/**
 * 把本地多出来的尾部轮次补到全量索引末尾。
 *
 * 索引按文件版本缓存，刚发出去、尚未落盘的一轮不在里面；这里按同一个键去重，
 * 只追加索引里没有的本地分组——保证「新增的一轮立刻出现在导航里」且不重复。
 * 只比较**尾部**：与索引重叠的历史轮次不应被重复追加。
 */
export function appendLocalOnlyItems(
  indexItems: ReadonlyArray<NavigationItem>,
  localGroups: ReadonlyArray<MessageGroup>,
): NavigationItem[] {
  const known = new Set(indexItems.map(navItemKey))
  const extra: NavigationItem[] = []
  for (const group of localGroups) {
    const item = navigationItemFromGroup(group)
    const key = navItemKey(item)
    if (known.has(key)) continue
    known.add(key)
    extra.push(item)
  }
  return extra
}

/** 从头像提供者补上头像（只有用户消息有头像）。 */
export function withAvatars(
  items: ReadonlyArray<NavigationItem>,
  avatarFor: (item: NavigationItem) => string | undefined,
): NavigationItem[] {
  return items.map((item) => item.role === 'user' ? { ...item, avatar: avatarFor(item) } : item)
}

/**
 * 由全量索引 + 本地已加载分组组装导航条目。
 *
 * - 索引可用（非空）：索引为骨架，顺序与总数固定；本地分组用于补头像与追加未落盘尾部。
 * - 索引不可用：回退到本地已加载分组（保持改动前的行为，不阻塞会话）。
 */
export function buildNavigationItems(
  indexEntries: ReadonlyArray<AgentNavigationIndexEntry> | null,
  localGroups: ReadonlyArray<MessageGroup>,
  userAvatar: string | undefined,
  messages: readonly SDKMessage[] = [],
): NavigationItem[] {
  const taskSourceKeys = new Set(localGroups.filter(group => group.type === 'user' && isTaskSourceInput(group.message)).map(group => navItemKey(navigationItemFromGroup(group))))
  const visible = new Set(projectTaskInputTimeline(messages))
  const hiddenKeys = new Set(messages.filter(message => !visible.has(message)).map(message => navItemKey(navigationItemFromGroup({ type: 'system', message: message as SDKSystemMessage }))))
  const project = (items: NavigationItem[]): NavigationItem[] => items
    .filter(item => !hiddenKeys.has(navItemKey(item)))
    .map(item => taskSourceKeys.has(navItemKey(item)) ? { ...item, role: 'status', avatar: undefined } : item)
  if (indexEntries && indexEntries.length > 0) {
    const skeleton: NavigationItem[] = indexEntries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      // 索引可能来自旧版本主进程（预览里带着 <quoted_context> 这类内部 XML），
      // 也可能命中进程内缓存；在展示层再洗一遍，保证导航里只出现人话。
      preview: entry.role === 'user' ? stripUserContextBlocks(entry.preview) : entry.preview,
      model: entry.model,
      matchKey: entry.matchKey,
    }))
    // 本地已加载分组的头像。只用“真实 uuid”做键，不用渲染层的回退 id，
    // 否则无 uuid 的条目会因回退 id 不同而匹配不上、头像白白丢掉。
    const avatarByUuid = new Map<string, string>()
    if (userAvatar) {
      for (const group of localGroups) {
        if (group.type !== 'user') continue
        const { uuid } = groupIdentity(group)
        if (uuid) avatarByUuid.set(uuid, userAvatar)
      }
    }
    const withAv = withAvatars(skeleton, (item) => item.id ? avatarByUuid.get(item.id) : undefined)
    return project([...withAv, ...appendLocalOnlyItems(skeleton, localGroups)])
  }

  return project(withAvatars(localGroups.map(navigationItemFromGroup), () => userAvatar))
}
