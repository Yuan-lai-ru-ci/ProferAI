import type { KnowledgeReference } from '@profer/shared'

/**
 * 资料正文始终经受控 MCP 返回，不把正文或本地路径注入模型 prompt。
 */
export function buildAgentKnowledgePrompt(references: KnowledgeReference[]): string {
  if (!references.length) return ''
  const items = references.map((reference) => `- ${reference.title} (ID: ${reference.itemId})`).join('\n')
  return `<imported_knowledge>\n当前会话已授权以下资料：\n${items}\n\n当用户询问“这篇/该方案/文档/资料”或未明确对象而问题可能指向上述资料时，必须先调用 mcp__knowledge-base__read_imported_knowledge 读取相关资料，再基于工具返回内容回答。不要编造未读取的资料内容；也不要尝试通过文件路径、目录或其他工具访问资料。\n</imported_knowledge>`
}
