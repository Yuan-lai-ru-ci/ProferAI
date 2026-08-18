import type { Channel } from '@profer/shared'

/** 服务端模型族虚拟渠道与旧版 newapi-* 渠道均属于官方代管渠道。 */
export function isOfficialManagedChannel(channel: Pick<Channel, 'id' | 'serverManaged'> | { id: string; serverManaged?: boolean }): boolean {
  return channel.serverManaged === true || channel.id.startsWith('newapi-')
}
