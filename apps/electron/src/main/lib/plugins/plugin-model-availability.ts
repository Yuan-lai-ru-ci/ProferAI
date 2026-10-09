import { isChannelEnabledForChat, isChannelEnabledForRuntime, resolveXaiCredentialMode, type Channel } from '@profer/shared'
import { decryptApiKey } from '../channel-manager'
/** 模型目录、路由和生成请求共享同一兼容性判断。 */
export function supportsPluginModel(channel: Channel, mode: 'chat' | 'agent', runtime: 'claude' | 'pi' = 'claude'): boolean {
  if (mode === 'agent') {
    // 改用共享的 isChannelEnabledForRuntime:它按用户勾选的 agentRuntimes 判定
    // (缺失时回退 provider 推导),并已处理 xai/codex 不支持 Claude 的拒绝。
    // 原先这里只看 provider 白名单和 xai 实验开关,完全不看 agentRuntimes 勾选,
    // 用户取消勾选后插件侧仍报 supportsAgent: true。
    return isChannelEnabledForRuntime(channel, runtime)
  }
  if (channel.provider === 'openai-codex') return false
  if (channel.provider === 'xai') {
    try { return resolveXaiCredentialMode(channel.credentialMode, decryptApiKey(channel.id)) !== 'oauth' } catch { return false }
  }
  return isChannelEnabledForChat(channel)
}
