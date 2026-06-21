/**
 * 飞书群聊辅助工具函数
 *
 * 从 feishu-bridge.ts 提取的群聊相关纯函数和工具方法。
 */
import type { FeishuMention, FeishuGroupInfo, FeishuGroupMember } from '@proma/shared'

/** 群聊信息缓存 TTL（1 小时） */
export const GROUP_CACHE_TTL = 3_600_000

/** 去重集合最大容量 */
export const DEDUP_MAX = 2000

/** 有界去重：添加元素，保持集合不超过上限 */
export function addToDedup(set: Set<string>, id: string, maxSize: number = DEDUP_MAX): void {
  set.add(id)
  if (set.size > maxSize) {
    const first = set.values().next().value as string
    set.delete(first)
  }
}

/** 从 mention.id 中提取 open_id */
export function extractMentionOpenId(mention: FeishuMention): string | null {
  const { id } = mention
  if (typeof id === 'string') return id
  if (typeof id === 'object' && id !== null) return id.open_id ?? null
  return null
}

/** 获取群聊信息（带缓存） */
export async function fetchGroupInfo(
  client: any,
  chatId: string,
  cache: Map<string, FeishuGroupInfo>,
  userNameCache: Map<string, string>,
): Promise<FeishuGroupInfo | null> {
  const cached = cache.get(chatId)
  if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL) return cached

  if (!client) return null

  try {
    const [chatResp, members] = await Promise.all([
      client.im.chat.get({ path: { chat_id: chatId } }),
      fetchGroupMembers(client, chatId),
    ])
    const name = chatResp?.data?.name ?? '未知群组'
    const description = chatResp?.data?.description

    const rawUserCount = chatResp?.data?.user_count
    const userCount = rawUserCount != null ? Number(rawUserCount) : undefined
    const normalizedUserCount = Number.isFinite(userCount) ? userCount : undefined
    if (normalizedUserCount === undefined) {
      console.warn(
        `[飞书 Bridge] chat.get 未返回 user_count（chatId=${chatId}）——` +
        `请确认已申请并发布 im:chat 权限（读取群基础信息），否则「仅你和 Bot 的群」无法免 @ 续聊。`,
      )
    }

    const info: FeishuGroupInfo = {
      chatId, name, description, members, userCount: normalizedUserCount, cachedAt: Date.now(),
    }
    cache.set(chatId, info)

    for (const m of members) {
      userNameCache.set(m.openId, m.name)
    }

    return info
  } catch (error) {
    console.warn('[飞书 Bridge] 获取群聊信息失败:', error)
    return null
  }
}

/** 拉取群成员列表（最多 100 人，不含机器人） */
export async function fetchGroupMembers(
  client: any,
  chatId: string,
): Promise<FeishuGroupMember[]> {
  if (!client) return []

  try {
    const resp = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100 },
    })
    const items = resp?.data?.items ?? []
    return items
      .filter((item: any) => item.member_id && item.name)
      .map((item: any) => ({ openId: item.member_id!, name: item.name! }))
  } catch (error) {
    console.warn('[飞书 Bridge] 获取群成员列表失败:', error)
    return []
  }
}

/** 获取用户显示名称（带缓存） */
export async function fetchUserName(
  client: any,
  openId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(openId)
  if (cached) return cached

  if (!client) return openId.slice(0, 8)

  try {
    const resp = await client.contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    })
    const name = resp?.data?.user?.name
    if (name) {
      cache.set(openId, name)
      return name
    }
  } catch (error) {
    console.warn('[飞书 Bridge] 获取用户信息失败:', error)
  }

  return openId.slice(0, 8)
}

/**
 * 检测消息的 mentions 列表中是否包含 @Bot
 *
 * @param botOpenId - 机器人 open_id（可通过 fetchBotOpenId 获取）
 * @param mentions - 消息 mentions 列表
 */
export async function isBotMentionedWithId(
  botOpenId: string | null,
  mentions: FeishuMention[] | undefined,
  client?: any,
): Promise<{ isMentioned: boolean; botOpenId: string | null }> {
  if (!mentions || mentions.length === 0) return { isMentioned: false, botOpenId }

  const mentionIds = mentions
    .map((m) => ({ name: m.name, openId: extractMentionOpenId(m) }))
    .filter((m) => m.openId && m.openId !== 'all')
  if (mentionIds.length === 0) return { isMentioned: false, botOpenId }

  let resolvedId = botOpenId

  if (!resolvedId && client) {
    try {
      const botInfoResp = await client.request<{
        bot?: { open_id?: string }
        data?: { bot?: { open_id?: string } }
      }>({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info/',
      })
      resolvedId = botInfoResp?.bot?.open_id ?? botInfoResp?.data?.bot?.open_id ?? null
      if (resolvedId) console.log(`[飞书 Bridge] 延迟获取 Bot open_id 成功: ${resolvedId}`)
    } catch (error) {
      console.warn('[飞书 Bridge] 延迟获取 Bot info 失败:', error)
    }
  }

  if (resolvedId) {
    const matched = mentionIds.some((m) => m.openId === resolvedId)
    if (!matched) {
      console.log(`[飞书 Bridge] @Bot 未匹配 — botOpenId=${resolvedId}, mentions=[${mentionIds.map((m) => `${m.name}(${m.openId})`).join(', ')}]`)
    }
    return { isMentioned: matched, botOpenId: resolvedId }
  }

  console.warn(`[飞书 Bridge] botOpenId 未获取，无法精确匹配，跳过消息（mentions: ${mentionIds.map((m) => `${m.name}(${m.openId})`).join(', ')}）`)
  return { isMentioned: false, botOpenId: resolvedId }
}
