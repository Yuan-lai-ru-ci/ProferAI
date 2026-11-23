import { hostname } from 'node:os'
import { parseCoreConnectionInvitation, type CoreConnectionInvitation, type CorePairingResult } from '@profer/shared'
import { createPinnedCoreTransport } from './core-pinned-transport'

const PREFIX = 'profer://core-pair#'

export function encodeCoreInvitation(invitation: CoreConnectionInvitation): string {
  return PREFIX + Buffer.from(JSON.stringify(invitation)).toString('base64url')
}

export function decodeCoreInvitation(input: string): CoreConnectionInvitation {
  const text = input.trim()
  if (text.length > 32_768) throw new Error('Core 邀请过长')
  try {
    return parseCoreConnectionInvitation(text.startsWith(PREFIX) ? Buffer.from(text.slice(PREFIX.length), 'base64url').toString('utf8') : text)
  } catch { throw new Error('Core 邀请无效或已过期，请重新生成') }
}

export function withCoreInvitationTunnel(invitation: CoreConnectionInvitation, tunnelUrl?: string): CoreConnectionInvitation {
  if (tunnelUrl === undefined || tunnelUrl.trim() === '') return invitation
  let url: URL
  try { url = new URL(tunnelUrl.trim()) } catch { throw new Error('请输入有效的 HTTPS 隧道地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('隧道地址必须为 HTTPS，且不能包含路径、凭据或参数')
  }
  // 仅替换寻址；Core ID、SPKI、一次性令牌和期限仍以原邀请为准。
  return { ...invitation, endpoints: [url.origin] }
}

export async function consumeCoreInvitation(invitation: CoreConnectionInvitation): Promise<CorePairingResult> {
  let failure: unknown
  for (const endpoint of invitation.endpoints) {
    const transport = createPinnedCoreTransport(endpoint, invitation.pin.value)
    try {
      const response = await transport.fetchImpl(`${endpoint}/connection/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ invitationToken: invitation.invitationToken, clientName: hostname().slice(0, 128) || 'Profer Desktop' }),
      })
      const result: unknown = await response.json()
      if (!response.ok) throw new Error('Core 邀请已失效或被使用，请重新生成')
      const value = result as Partial<CorePairingResult>
      if (value.coreId !== invitation.coreId || !value.bindingId || !value.credential || !value.name) throw new Error('Core 配对结果与邀请不一致')
      if (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now())) throw new Error('Core 配对期限无效')
      return value as CorePairingResult
    } catch (error) { failure = error }
    finally { transport.close() }
  }
  throw failure ?? new Error('无法连接邀请中的 Core')
}
