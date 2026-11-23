import { isIndependentLocalCore } from './core-local-mode'
import { localAccount } from './local-account-routing'
import { ipcMain } from 'electron'
import { AUTH_IPC_CHANNELS } from '@profer/shared'
import { getOrCreateDeviceIdentity, getUserIdentity } from './identity-service'
import {
  login,
  register,
  logout,
  getAuthStatus,
  getServerInfoList,
  getTeamAuthWithRefresh,
  listRemoteDevices,
  revokeRemoteDevice,
  getRegistrationOptions,
  sendRegistrationOtp,
  verifyRegistrationOtp,
} from './auth-service'

/** 注册普通账号认证、设备和服务端信息 IPC；不包含团队工作区能力。 */
export function registerAccountIpc(): void {
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_DEVICE_IDENTITY, async () => getOrCreateDeviceIdentity())
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_USER_IDENTITY, async () => getUserIdentity())
  ipcMain.handle(AUTH_IPC_CHANNELS.UPDATE_PROFILE, async (_, _updates: Record<string, unknown>) => getUserIdentity())
  ipcMain.handle(AUTH_IPC_CHANNELS.LOGIN, async (_, credentials: { email: string; password: string; revokeSlotId?: string }) =>
    login(credentials.email, credentials.password, credentials.revokeSlotId))
  ipcMain.handle(AUTH_IPC_CHANNELS.LOGOUT, async () => logout())
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_SERVER_INFO, async () => isIndependentLocalCore() ? localAccount.operation('serverInfo') : getServerInfoList())
  ipcMain.handle(AUTH_IPC_CHANNELS.REGISTER, async (_, credentials: { email: string; password: string; displayName: string; inviteCode?: string; otpToken?: string; emailOtp?: string }) =>
    register(credentials.email, credentials.password, credentials.displayName, credentials.inviteCode, undefined, undefined, credentials.otpToken, credentials.emailOtp))
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_REGISTRATION_OPTIONS, async () => getRegistrationOptions())
  ipcMain.handle(AUTH_IPC_CHANNELS.SEND_REGISTRATION_OTP, async (_, email: string) => sendRegistrationOtp(email))
  ipcMain.handle(AUTH_IPC_CHANNELS.VERIFY_REGISTRATION_OTP, async (_, email: string, otpToken: string, code: string) => verifyRegistrationOtp(email, otpToken, code))
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_AUTH_STATUS, async () => isIndependentLocalCore() ? localAccount.operation('status') : getAuthStatus())
  // 额度、反馈和 OpenAPI 设置仍通过该共享认证读取接口获取服务端凭据。
  ipcMain.handle(AUTH_IPC_CHANNELS.GET_TEAM_AUTH, async () => getTeamAuthWithRefresh())
  ipcMain.handle(AUTH_IPC_CHANNELS.LIST_DEVICES, async () => listRemoteDevices())
  ipcMain.handle(AUTH_IPC_CHANNELS.REVOKE_DEVICE, async (_, slotId: string) => revokeRemoteDevice(slotId))
}
