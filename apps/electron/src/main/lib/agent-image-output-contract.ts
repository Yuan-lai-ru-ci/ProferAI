/** 图片输出工具的唯一契约：工具名、描述、结果文案与正文禁止项都在这里，避免 runtime 之间漂移。 */

export const SEND_LOCAL_IMAGE_TOOL_NAME = 'send_local_image'
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

/** 所有 runtime、所有图片工具共用的用户可见文案规则。 */
export const AGENT_IMAGE_OUTPUT_TEXT_RULE =
  'Profer 会自动展示图片；不要输出 Markdown 图片、file:// 链接、HTML img 标签或任何内部图片协议标记。'

export const SEND_LOCAL_IMAGE_TOOL_DESCRIPTION =
  'Send an existing local PNG/JPEG/GIF/WebP into the final reply. The image is inserted at the point in your output where you call this tool, so call it between the text blocks to interleave text and images. Use it only when the user explicitly asks to see an image, or when the image is a deliverable of this turn; never send screenshots captured only for your own verification, and never echo an image the user already attached. Relative paths resolve from the session cwd; absolute paths must be inside the session cwd or an authorized attached directory. Profer displays the verified image automatically; do not output Markdown images, file:// links, HTML img tags, or internal image protocol markers. Does not generate or edit images.'

export function formatSendLocalImageToolResultText(relativePath: string): string {
  return `图片已附加到本轮回复。相对路径：${relativePath}。${AGENT_IMAGE_OUTPUT_TEXT_RULE}`
}
