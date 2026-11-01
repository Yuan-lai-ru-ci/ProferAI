import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * 用户消息必须进入事件流（Pocket 可见性守卫）。
 *
 * 桌面渲染层有自己的乐观气泡，所以持久化用户消息时曾经只写 transcript、不广播；
 * 但 Pocket（手机/平板）没有本地状态，只靠 `sdk_message` 事件渲染对话——
 * 结果手机端整轮只能看到回复，看不到电脑上发起的指令，必须重新打开会话才补出来。
 *
 * 这里用源码结构断言钉住两个落点（旧编排链 + 运行中追加），
 * 与 agent-service-unread-callsites.test.ts 的调用点守卫同一套路。
 */
async function readOrchestrator(): Promise<string> {
  return (await Bun.file(join(import.meta.dir, 'agent-orchestrator.ts')).text()).replace(/\r\n/g, '\n')
}

function slice(source: string, start: string, end?: string): string {
  const from = source.indexOf(start)
  if (from === -1) throw new Error(`源码锚点未找到: start=${start}`)
  if (!end) return source.slice(from)
  const to = source.indexOf(end, from + start.length)
  if (to === -1) throw new Error(`源码锚点未找到: end=${end}`)
  return source.slice(from, to)
}

describe('用户消息广播', () => {
  test('Given 一轮新运行 When 持久化用户消息 Then 同一条消息同时进入事件流', async () => {
    const source = await readOrchestrator()
    const body = slice(source, 'export class AgentOrchestrator')
    const persistAt = body.indexOf('this.sessionPort.appendMessages(sessionId, [inputMessage])')
    const emitAt = body.indexOf("this.eventPort.emit(sessionId, { kind: 'sdk_message', message: inputMessage })")
    expect(persistAt).toBeGreaterThan(-1)
    expect(emitAt).toBeGreaterThan(persistAt)
  })

  test('Given 运行中追加的用户消息 When 持久化成功 Then 同样广播给远程客户端', async () => {
    const source = await readOrchestrator()
    const body = slice(source, 'const persistMsg: SDKMessage = {', 'this.persistSkillRoutingNotice(sessionId, routedSkills)')
    expect(body).toContain("this.eventPort.emit(sessionId, { kind: 'sdk_message', message: sourcedMessage })")
  })
})
