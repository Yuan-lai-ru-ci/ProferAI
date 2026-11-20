import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SDKMessage } from '@profer/shared'
import { buildAutomationFeishuCard, extractAssistantText, shouldNotifyAutomationTarget } from '@profer/shared/utils'
import type { CoreAutomationNotification } from './automation-project-mirror'
import type { CoreAutomationNotificationPort } from './automation-service'

interface CoreFeishuBot {
  id: string
  enabled: boolean
  appId: string
  appSecret: string
}
interface FetchResponse { ok: boolean; status: number; json(): Promise<unknown> }
export type CoreNotificationFetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>

function readBots(configDir: string): CoreFeishuBot[] {
  const path = join(configDir, 'automation-notifications.json')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Core飞书通知配置读取失败，请检查automation-notifications.json')
  }
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('bots' in value) || !Array.isArray(value.bots)) throw new Error('Core飞书通知配置格式无效')
  const ids = new Set<string>()
  return value.bots.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || typeof item.enabled !== 'boolean' || typeof item.appId !== 'string' || !item.appId || typeof item.appSecret !== 'string' || !item.appSecret) throw new Error(`Core飞书通知Bot配置无效: index=${index}`)
    if (ids.has(item.id)) throw new Error('Core飞书通知Bot ID重复')
    ids.add(item.id)
    return { id: item.id, enabled: item.enabled, appId: item.appId, appSecret: item.appSecret }
  })
}

async function responseJson(response: FetchResponse, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`飞书${operation}HTTP错误: ${response.status}`)
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`飞书${operation}响应格式无效`)
  const result = body as Record<string, unknown>
  if (result.code !== 0) throw new Error(`飞书${operation}失败: ${typeof result.msg === 'string' ? result.msg : '未知错误'}`)
  return result
}

async function sendCard(bot: CoreFeishuBot, chatId: string, card: Record<string, unknown>, fetcher: CoreNotificationFetch): Promise<void> {
  const tokenResponse = await responseJson(await fetcher('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: bot.appId, app_secret: bot.appSecret }),
  }), '令牌获取')
  const tokenBody = tokenResponse
  if (typeof tokenBody.tenant_access_token !== 'string' || !tokenBody.tenant_access_token) throw new Error('飞书令牌响应缺少tenant_access_token')
  const sent = await responseJson(await fetcher('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST', headers: { authorization: `Bearer ${tokenBody.tenant_access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
  }), '消息发送')
  const data = sent.data
  if (!data || typeof data !== 'object' || typeof (data as Record<string, unknown>).message_id !== 'string' || !(data as Record<string, unknown>).message_id) throw new Error('飞书发送响应未确认消息接收')
}

export interface CoreAutomationNotificationHostOptions {
  configDir: string
  readMessages(sessionId: string): readonly SDKMessage[]
  fetch?: CoreNotificationFetch
}

/**
 * 配置仅属于当前Core，不读取桌面feishu.json或safeStorage凭据。
 * configDir/automation-notifications.json:
 * { version: 1, bots: [{ id, enabled: true, appId, appSecret }] }
 * appSecret为Core专用明文凭据，部署方必须限制该文件和configDir访问权限。
 * 创建工厂不发请求；仅deliver被调用时发送，失败reject交由持久outbox记录。
 */
export function createCoreAutomationNotificationHost(options: CoreAutomationNotificationHostOptions): CoreAutomationNotificationPort {
  const fetcher: CoreNotificationFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'error' }))
  return {
    async deliver(notification: Readonly<CoreAutomationNotification>): Promise<void> {
      if (!shouldNotifyAutomationTarget(notification.target, notification.run.status)) throw new Error('通知目标已禁用或触发条件不匹配')
      if (notification.target.type !== 'feishu') throw new Error('Core尚未支持该通知渠道')
      const bot = readBots(options.configDir).find(item => item.id === notification.target.botId && item.enabled)
      if (!bot) throw new Error(`Core飞书通知Bot未配置或未启用: ${notification.target.botId}`)
      const summary = notification.run.status === 'success'
        ? extractAssistantText(options.readMessages(notification.run.sessionId))
        : notification.run.error ?? '未知错误'
      if (!notification.target.chatId.trim()) throw new Error('飞书通知缺少chat_id')
      await sendCard(bot, notification.target.chatId, buildAutomationFeishuCard({ automation: notification.automation, run: notification.run, summary }), fetcher)
    },
  }
}
