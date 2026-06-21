/**
 * 身份 Atoms — 设备身份与用户认证状态
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { DeviceIdentity, UserIdentity } from '../../types/identity'

/** 设备身份 */
export const deviceIdentityAtom = atom<DeviceIdentity | null>(null)

/** 用户身份 */
export const userIdentityAtom = atom<UserIdentity | null>(null)

interface AuthStatusState {
  isLoggedIn: boolean
  teamAccountId?: string
  teamEmail?: string
}

/** 认证状态（持久化到 localStorage，避免刷新丢失） */
export const authStatusAtom = atomWithStorage<AuthStatusState>('proma-auth-status', {
  isLoggedIn: false,
})
