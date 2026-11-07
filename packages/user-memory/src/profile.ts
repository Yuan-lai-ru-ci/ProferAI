/**
 * 画像字段的读写门面。
 *
 * 把「字段 → 文件 → Markdown 小节」的映射收在一处：
 * Electron 的「我的画像」界面直接操作 Markdown，CLI 的 `profile get/set`
 * 走这里，两边共享同一套行级替换规则。
 */

import { QUICK_FIELDS, readField, writeField, type QuickField, type QuickFieldKey } from './profile-fields'
import { readGlobalMemoryFile, writeGlobalMemoryFile } from './global-memory'

export type { QuickField, QuickFieldKey }

export interface ProfileFieldValue {
  key: QuickFieldKey
  title: string
  file: string
  value: string
}

/** 按 key 或中文标题查找字段定义；找不到返回 undefined。 */
export function resolveQuickField(keyOrTitle: string): QuickField | undefined {
  const needle = keyOrTitle.trim()
  return QUICK_FIELDS.find((field) => field.key === needle || field.title === needle)
}

/** 读取一个画像字段的当前值。 */
export function readProfileField(configDir: string, keyOrTitle: string): ProfileFieldValue {
  const field = resolveQuickField(keyOrTitle)
  if (!field) throw new Error(`未知画像字段: ${keyOrTitle}（可用: ${QUICK_FIELDS.map((f) => f.key).join(' / ')}）`)

  const doc = readGlobalMemoryFile(configDir, field.file).content ?? ''
  return { key: field.key, title: field.title, file: field.file, value: readField(doc, field.title) }
}

/** 写入一个画像字段，返回写入后的值。 */
export function writeProfileField(configDir: string, keyOrTitle: string, value: string): ProfileFieldValue {
  const field = resolveQuickField(keyOrTitle)
  if (!field) throw new Error(`未知画像字段: ${keyOrTitle}（可用: ${QUICK_FIELDS.map((f) => f.key).join(' / ')}）`)

  const doc = readGlobalMemoryFile(configDir, field.file).content ?? ''
  const next = writeField(doc, field.title, value)
  writeGlobalMemoryFile(configDir, field.file, next)

  return { key: field.key, title: field.title, file: field.file, value: readField(next, field.title) }
}

/** 一次性读取全部首屏字段。 */
export function readProfileFields(configDir: string): ProfileFieldValue[] {
  return QUICK_FIELDS.map((field) => readProfileField(configDir, field.key))
}
