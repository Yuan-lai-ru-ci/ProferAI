import type { ChannelModel } from '@profer/shared'

/**
 * 手动添加模型的纯函数封装。
 *
 * 手动输入是异常模型名的主要来源：
 * - 中文输入法组词中按 Enter 会把组词文本当成模型 ID 提交（组件侧用 isComposing 守卫兜底）；
 * - 从别处粘贴的文本可能夹带空格 / 换行，trim 只能去掉首尾，内部空白会形成非法 ID；
 * - 双击 / 连按 Enter 会把同一个 ID 追加成重复条目。
 *
 * 统一在这里校验和去重，避免垃圾条目随编辑模式的 auto-save 落盘——
 * 落盘后远端模型发现会刻意保留本地配置，垃圾就再也洗不掉了。
 */
export type AddManualModelResult =
  | { kind: 'added'; models: ChannelModel[]; id: string }
  | { kind: 'duplicate'; models: ChannelModel[]; id: string }
  | { kind: 'empty' }
  | { kind: 'invalid' }

/** 模型 ID 不允许包含任何空白字符（空格、Tab、换行），真实供应商 ID 均不包含。 */
const WHITESPACE_RE = /\s/

export function addManualModel(
  current: ChannelModel[],
  idInput: string,
  nameInput: string,
): AddManualModelResult {
  const id = idInput.trim()
  if (!id) return { kind: 'empty' }
  if (WHITESPACE_RE.test(id)) return { kind: 'invalid' }

  if (current.some((model) => model.id === id)) {
    return { kind: 'duplicate', models: current, id }
  }

  const name = nameInput.trim() || id
  return {
    kind: 'added',
    id,
    models: [...current, { id, name, enabled: true, source: 'manual' as const }],
  }
}
