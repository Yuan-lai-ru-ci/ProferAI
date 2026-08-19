/**
 * Agent 图片附件的默认行为。
 *
 * 纯图片消息没有文字任务时，主动要求 Agent 读图并给出描述；
 * 只要用户给出了文字，文字任务始终优先，不注入默认指令。
 */
export type AgentAttachmentKind = 'image' | 'file'

export const DEFAULT_IMAGE_ATTACHMENT_PROMPT = `用户仅发送了图片，未附文字任务。请立即使用 Read 工具读取所有图片，并直接给出简洁、客观的内容描述，包含可辨识的文字、界面或主体及关键信息；不要先反问用户想让我做什么。若图片无法读取，请说明原因。`

/**
 * 生成附件消息的有效用户任务。
 *
 * - 有文字：严格保留用户任务；
 * - 仅图片：自动请求读图；
 * - 非图片附件：维持原有“查看附件”语义。
 */
export function resolveAgentAttachmentPrompt(
  text: string,
  attachmentKinds: readonly AgentAttachmentKind[],
): string {
  const userText = text.trim()
  if (userText) return userText
  if (attachmentKinds.length === 0) return ''
  if (attachmentKinds.every((kind) => kind === 'image')) return DEFAULT_IMAGE_ATTACHMENT_PROMPT
  return '请查看上面附加的文件。'
}

/** 根据浏览器 File / AgentPendingFile 的 MIME 类型判断图片附件。 */
export function isImageAttachmentMediaType(mediaType: string | undefined): boolean {
  return !!mediaType && mediaType.toLowerCase().startsWith('image/')
}
