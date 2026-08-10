/**
 * 将 New API 的上游错误归类为面向 Profer 用户的安全提示。
 *
 * 这必须保持为纯函数：代理路由、单测和未来渠道熔断器共用，且不连接数据库。
 */
export function translateUpstreamError(parsed, status) {
  const rawMsg = (parsed?.error?.message || parsed?.message || (typeof parsed?.error === 'string' ? parsed.error : '') || '').toString()
  const lower = rawMsg.toLowerCase()

  // 供应商渠道账户余额耗尽，与 Profer 用户积分、New API 共享账户余额均无关。
  // 绝不能伪装成用户额度不足，否则客户端会错误引导用户充值。
  if (lower.includes('insufficient account balance')) {
    return {
      payload: {
        error: '当前模型供应通道额度不足，已通知维护方处理；请稍后重试或切换模型',
        code: 'upstream_channel_insufficient',
      },
      isQuota: false,
      isUpstreamChannelBalance: true,
    }
  }

  // Profer / New API 本身的额度或预扣失败（美元文案）才归入平台额度。
  const isQuota =
    rawMsg.includes('预扣费') || rawMsg.includes('额度') || rawMsg.includes('余额') ||
    lower.includes('insufficient') || lower.includes('quota') || lower.includes('balance') ||
    rawMsg.includes('＄') || rawMsg.includes('$') || status === 402
  if (isQuota) {
    return {
      payload: { error: '平台额度暂时不足，请联系管理员充值', code: 'insufficient_credits' },
      isQuota: true,
      isUpstreamChannelBalance: false,
    }
  }

  // 定价/模型未配置 → 不暴露运维细节
  if (lower.includes('price not configured') || rawMsg.includes('价格未配置') || lower.includes('model not found') || rawMsg.includes('模型不存在')) {
    return { payload: { error: '所选模型暂不可用，请联系管理员' }, isQuota: false, isUpstreamChannelBalance: false }
  }

  // 其他上游错误：透传精简消息
  if (parsed?.error?.message || parsed?.error || parsed?.message) {
    return { payload: { error: rawMsg || JSON.stringify(parsed).slice(0, 200) }, isQuota: false, isUpstreamChannelBalance: false }
  }
  return { payload: parsed, isQuota: false, isUpstreamChannelBalance: false }
}
