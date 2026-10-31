/**
 * OpenAI 官方上游过载时的统一用户文案与识别规则。
 *
 * 单一事实源：主进程的重试展示、Claude provider 的错误映射、渲染层的提示都从这里取。
 * 历史上这三处各写了一份字面量，改一处不生效，还让旧产品名混进了用户可见文案。
 */
export const OPENAI_UPSTREAM_BUSY_MESSAGE =
  'OpenAI 官方上游服务当前请求量较大，暂时无法及时响应，本次情况与你的账户无关，请稍候片刻后再重试。'

/**
 * 用于展示/映射的识别规则：只认明确的官方上游过载语义。
 *
 * 自动重试判定另有一套更宽的规则（额外认 `temporarily unavailable` 等瞬时文案），
 * 见 `agent-retry-utils.ts` 的 `isOpenAIUpstreamBusyError`。
 */
const OPENAI_UPSTREAM_BUSY_PATTERN = /OpenAI 官方上游服务当前请求量较大|OpenAI.*(?:overloaded|too many requests|rate.?limit)/i

export function isOpenAIUpstreamBusyText(text: string | null | undefined): boolean {
  return typeof text === 'string' && OPENAI_UPSTREAM_BUSY_PATTERN.test(text)
}
