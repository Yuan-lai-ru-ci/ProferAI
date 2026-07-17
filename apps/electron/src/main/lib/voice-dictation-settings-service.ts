/**
 * 语音输入设置服务
 *
 * 独立处理豆包 ASR 凭证，避免通过通用 settings IPC 暴露加密细节。
 */

import type { VoiceDictationSettings, VoiceDictationSettingsUpdate } from '../../types'
import { getSettings, updateSettings } from './settings-service'
import { encryptToken, decryptToken } from './token-crypto'

const DEFAULT_VOICE_DICTATION_SETTINGS: VoiceDictationSettings = {
  enabled: false,
  provider: 'doubao',
  appId: '',
  accessToken: '',
  resourceId: 'volc.seedasr.sauc.duration',
  language: '',
  endpointMode: 'async',
  outputMode: 'auto',
  customHotwords: '',
}

function encryptSecret(value: string): string {
  if (!value) return ''
  return encryptToken(value)
}

function decryptSecret(value: string): string {
  if (!value) return ''
  return decryptToken(value)
}

/** 获取解密后的语音输入设置 */
export function getVoiceDictationSettings(): VoiceDictationSettings {
  const raw = getSettings().voiceDictation ?? {}
  const encryptedAccessToken = raw.accessToken ?? raw.accessKey ?? ''
  return {
    ...DEFAULT_VOICE_DICTATION_SETTINGS,
    ...raw,
    appId: raw.appId ?? raw.appKey ?? '',
    accessToken: decryptSecret(encryptedAccessToken),
    customHotwords: typeof raw.customHotwords === 'string' ? raw.customHotwords : '',
  }
}

/** 保存语音输入设置，Access Token 加密后落盘 */
export function updateVoiceDictationSettings(
  updates: VoiceDictationSettingsUpdate,
): VoiceDictationSettings {
  const current = getVoiceDictationSettings()
  const next: VoiceDictationSettings = {
    ...current,
    ...updates,
    provider: 'doubao',
  }

  updateSettings({
    voiceDictation: {
      ...next,
      accessToken: encryptSecret(next.accessToken),
    },
  })

  return next
}
