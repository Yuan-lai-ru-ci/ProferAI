import type { EditionProviders } from '@profer/edition-contract'
import { AUTH_IPC_CHANNELS } from '@profer/shared'
import { ipcMain } from 'electron'

/**
 * 开源版能力装配。
 *
 * 本文件**不得**导入 `auth-service` / `account-ipc` / `commercial-routing-policy`
 * 等商业模块——它就是 OSS 构建里替换掉商业实现的那一份。边界由
 * `edition/edition-boundaries.test.ts` 机械校验。
 *
 * 账号能力恒为空：没有登录、没有会员、没有代管路由、没有远程中继。
 */

/** 账号相关操作在开源版的统一提示，避免各处文案漂移。 */
const NOT_AVAILABLE = '当前为开源版，不包含账号与官方模型服务'

export const editionProviders: EditionProviders = {
  id: 'oss',
  account: {
    getSession: async () => null,
    recoverSession: async () => null,
    getSessionSnapshot: () => null,
    getSessionGeneration: () => null,
    refreshSession: async () => false,
    restoreSession: async () => false,
    // 没有会话可续期，自动刷新是空操作而不是报错。
    scheduleAutoRefresh: () => {},
    getMembership: () => ({
      commercialMode: false,
      membershipTier: '',
      // 开源版没有服务端下发渠道，用户本来就该自配。
      canSelfConfig: true,
    }),
  },
  credentials: {
    shouldUseManagedRoute: () => false,
    shouldUseBearerAuth: () => false,
    // 开源版没有代管通道：走到这里说明上层漏了判定，直接抛错比拼一个空地址更容易定位。
    managedPath: () => {
      throw new Error('当前发行版不含代管通道')
    },
    managedImageOperationPath: () => {
      throw new Error('当前发行版不含代管通道')
    },
  },
  channels: {
    // 开源版没有服务端下发渠道：所有渠道都是用户自配，一律可编辑可删除。
    isManagedChannel: () => false,
    //
    // 但商业版残留的渠道就藏在同一份 channels.json 里：它们的 baseUrl 为空，
    // 在开源版里选中只会请求空地址。只隐藏、不删除，切回商业版时原样恢复。
    // `newapi-` 前缀是旧版官方渠道的历史 id，早期写入时没有 serverManaged 字段。
    isChannelVisible: (channel) => channel.serverManaged !== true && !channel.id.startsWith('newapi-'),
  },
  errors: {
    // 开源版没有额度体系：上游 402 按普通错误处理，不给用户看「去充值」。
    detectInsufficientCredits: () => null,
  },
  remote: {
    getRelayTicket: async () => null,
  },
  registerIpc: () => {
    // preload 契约对渲染进程是固定的，通道缺失只会把“没有这个功能”变成
    // 满屏 unhandled rejection。这里注册同名的空实现，返回“未登录/空列表”。
    //
    // identity-service 在 handler 内部延迟引入：它依赖 config-paths，顶层引入会让
    // 每个只部分 mock 这两个模块的测试在加载期就因缺导出而失败（与业务无关）。
    const identity = () => require('../identity-service') as typeof import('../identity-service')
    ipcMain.handle(AUTH_IPC_CHANNELS.GET_DEVICE_IDENTITY, async () => identity().getOrCreateDeviceIdentity())
    ipcMain.handle(AUTH_IPC_CHANNELS.GET_USER_IDENTITY, async () => identity().getUserIdentity())
    ipcMain.handle(AUTH_IPC_CHANNELS.UPDATE_PROFILE, async () => identity().getUserIdentity())
    ipcMain.handle(AUTH_IPC_CHANNELS.GET_AUTH_STATUS, async () => ({ isLoggedIn: false }))
    ipcMain.handle(AUTH_IPC_CHANNELS.GET_TEAM_AUTH, async () => null)
    ipcMain.handle(AUTH_IPC_CHANNELS.GET_SERVER_INFO, async () => [])
    ipcMain.handle(AUTH_IPC_CHANNELS.LIST_DEVICES, async () => [])
    ipcMain.handle(AUTH_IPC_CHANNELS.REVOKE_DEVICE, async () => ({ ok: false, error: NOT_AVAILABLE }))
    ipcMain.handle(AUTH_IPC_CHANNELS.LOGIN, async () => ({ success: false, error: NOT_AVAILABLE }))
    ipcMain.handle(AUTH_IPC_CHANNELS.REGISTER, async () => ({ success: false, error: NOT_AVAILABLE }))
    // 登出在开源版是幂等的空操作：本地本来就没有会话。
    ipcMain.handle(AUTH_IPC_CHANNELS.LOGOUT, async () => ({ channelsCleared: false, channelsBackedUp: false }))
    ipcMain.handle(AUTH_IPC_CHANNELS.GET_REGISTRATION_OPTIONS, async () => ({ openRegistration: false }))
    ipcMain.handle(AUTH_IPC_CHANNELS.SEND_REGISTRATION_OTP, async () => ({ success: false, error: NOT_AVAILABLE }))
    ipcMain.handle(AUTH_IPC_CHANNELS.VERIFY_REGISTRATION_OTP, async () => ({ success: false, error: NOT_AVAILABLE }))
  },
}
