/**
 * 教程服务
 *
 * 负责读取教程内容和创建欢迎对话。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { createConversation, appendMessage, updateConversationMeta } from './conversation-manager'
import { getConversationAttachmentsDir } from './config-paths'
import type { ConversationMeta, FileAttachment, ChatMessage } from '@profer/shared'

/**
 * 获取打包/开发环境下资源文件路径
 *
 * 开发模式：resources/ 经 build:resources 复制到 dist/resources/
 * 生产模式：从 extraResources 读取
 */
function getResourceFilePath(fileName: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, fileName)
  }
  return join(__dirname, 'resources', fileName)
}

/** 读取 markdown 资源；不存在或读取失败返回 null。 */
function readResource(fileName: string, label: string): string | null {
  const filePath = getResourceFilePath(fileName)

  if (!existsSync(filePath)) {
    console.warn(`[${label}] 教程文件不存在:`, filePath)
    return null
  }

  try {
    return readFileSync(filePath, 'utf-8')
  } catch (error) {
    console.error(`[${label}] 读取教程文件失败:`, error)
    return null
  }
}

/**
 * 读取教程内容
 *
 * @returns 教程 markdown 文本，读取失败返回 null
 */
export function getTutorialContent(): string | null {
  return readResource('tutorial.md', '教程服务')
}

/**
 * 读取“自建 FRP 服务器”教程内容
 *
 * @returns 教程 markdown 文本，读取失败返回 null
 */
export function getFrpGuideContent(): string | null {
  return readResource('frp-server-guide.md', '自建 FRP 教程服务')
}

/**
 * 创建欢迎对话
 *
 * 结构（v2）：
 * 1. 创建对话
 * 2. 将教程保存为附件文件
 * 3. 追加 assistant 欢迎消息，教程附件挂在**这条回复上**
 *
 * 为什么不再造一条 user 消息：欢迎对话是产品给新用户的第一屏，旧实现会写一条
 * 「你好，我是 Profer 的新用户……这是完整的使用教程」并挂上附件，界面渲染出来
 * 就是用户自己发了一条带附件的消息 —— 用户既没发过，也会困惑「为什么我说过这话」，
 * 还会看到重发/编辑/删除这些只对真实输入有意义的按钮。
 *
 * 现在教程作为助手回复的附件呈现：内容仍然是「供 AI 参考的完整教程」，但归属正确。
 * 用户在第一屏里唯一能输入的那条消息，留给用户自己。
 *
 * @returns 对话元数据，失败返回 null
 */
export function createWelcomeConversation(): ConversationMeta | null {
  const tutorialContent = getTutorialContent()
  if (!tutorialContent) {
    console.warn('[教程服务] 无法读取教程内容，跳过创建欢迎对话')
    return null
  }

  try {
    // 1. 创建对话
    const meta = createConversation('了解 Profer')

    // 2. 保存教程文件为附件
    const attachmentId = randomUUID()
    const attachmentFilename = 'Profer 使用教程.md'
    const localPath = `${meta.id}/${attachmentId}.md`
    const dir = getConversationAttachmentsDir(meta.id)
    const fullPath = join(dir, `${attachmentId}.md`)

    // 去掉图片标记，保留纯文本（图片在 Chat 上下文中无意义）
    const cleanedContent = tutorialContent.replace(/!\[.*?\]\(.*?\)\n*/g, '')
    writeFileSync(fullPath, cleanedContent, 'utf-8')

    const attachment: FileAttachment = {
      id: attachmentId,
      filename: attachmentFilename,
      mediaType: 'text/markdown',
      localPath,
      size: Buffer.byteLength(cleanedContent, 'utf-8'),
    }

    // 3. 追加 assistant 欢迎消息（教程附件挂在助手回复上，不伪造用户输入）
    const now = Date.now()
    const assistantMessage: ChatMessage = {
      id: randomUUID(),
      parentId: null,
      role: 'assistant',
      content: `你好，欢迎使用 Profer。

它可以聊天，也能读你的文件、跑命令、按计划把事做完。想先认识一下你：

1. 怎么称呼你？
2. 你主要做什么工作？（独立开发、产品、数据分析、运营、学生……）
3. 最近在忙什么，有哪些事想交给它？

说清这三点，我会给你一份贴合你场景的上手建议：先开哪几个功能、推荐哪些 Skill 与 MCP、常用流程怎么搭。

直接回复就好，一次说完或分几条都可以。`,
      createdAt: now,
      model: 'Profer',
      attachments: [attachment],
    }
    appendMessage(meta.id, assistantMessage)

    // 激活路径只有这一条助手消息；并标记为欢迎对话——它的首条回复是写死的引导文案，
    // 不属于用户工作内容，不应提供「切换到 Agent 模式」把这段文案拖进新会话。
    //
    // 必须回传 update 的返回值：createConversation 给出的 meta 是写标记之前的快照，
    // 直接 return 它会让渲染进程拿不到 isWelcome，迁移按钮照旧显示。
    const updatedMeta = updateConversationMeta(meta.id, {
      activePath: [assistantMessage.id],
      isWelcome: true,
    })

    console.log(`[教程服务] 已创建欢迎对话: ${meta.id}`)
    return updatedMeta
  } catch (error) {
    console.error('[教程服务] 创建欢迎对话失败:', error)
    return null
  }
}
