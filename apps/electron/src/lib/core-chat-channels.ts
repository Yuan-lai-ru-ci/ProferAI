import { CHAT_IPC_CHANNELS } from '@profer/shared'

/** Chat 业务与宿主附件操作都带所属目标；主进程按通道决定转发或宿主交互。 */
export const CORE_CHAT_CHANNELS: ReadonlySet<string> = new Set(Object.values(CHAT_IPC_CHANNELS).filter(channel => !channel.startsWith('chat:stream:')))
