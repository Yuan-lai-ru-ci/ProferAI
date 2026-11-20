import type { UpdateStatus } from './updater-types'

/** 预发布包不接入稳定更新源；build metadata 中的连字符不属于 prerelease。 */
export function requiresManualUpdate(version: string): boolean {
  return /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(version.trim())
}

export function manualUpdateStatus(): UpdateStatus {
  return {
    status: 'error',
    error: '当前为 Beta / 预发布版本，仅支持手动安装。自动检查、下载和安装已停用，请使用本批次提供的安装包手动更新。',
  }
}
