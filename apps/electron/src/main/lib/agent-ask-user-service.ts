/** Electron 保留原单例；Core 创建自己的实例，共用问答解析和生命周期实现。 */
import { AgentAskUserService } from '@profer/agent-runtime/ask-user-service'
export { AgentAskUserService } from '@profer/agent-runtime/ask-user-service'
export const askUserService = new AgentAskUserService()
