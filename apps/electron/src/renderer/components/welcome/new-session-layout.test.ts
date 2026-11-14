import { describe, expect, test } from 'bun:test'

const agentSource = await Bun.file(new URL('../agent/AgentView.tsx', import.meta.url)).text()
const chatSource = await Bun.file(new URL('../chat/ChatView.tsx', import.meta.url)).text()
const topPadding = 'pt-[clamp(0px,calc(30vh-242px),8rem)]'

describe('新会话欢迎区位置', () => {
  test('Agent 与 Chat 用相同的响应式顶部留白下移整组内容', () => {
    for (const source of [agentSource, chatSource]) {
      expect(source.split(topPadding)).toHaveLength(2)
      expect(source).toContain(`px-4 pb-8 ${topPadding}`)
    }
  })

  test('Agent 保留同一个 composer 容器，已有会话仍使用原底部间距', () => {
    expect(agentSource).toContain(": 'shrink-0 px-2.5 pb-2.5 md:px-[18px] md:pb-[18px]'")
    expect(agentSource).toContain('key="agent-composer"')
    expect(agentSource).toContain('{isEmptySession && <WelcomeEmptyState variant="inline" />}')
  })

  test('Chat 的位置调整只应用于空会话分支', () => {
    expect(chatSource).toContain('{isEmptyConversation ? (')
    expect(chatSource).toContain(') : (\n            chatComposer\n          )}')
  })
})
