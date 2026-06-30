/**
 * 额度不足（HTTP 402）检测与解析
 *
 * 代管模式下服务端 /v1/proxy 在余额不足时返回 402，body 形如：
 *   { error: '额度不足', message: '当前余额 X credits，本次预估消耗 Y credits', balance, required }
 *
 * 这条 402 经 sse-reader 的 HTTPError 抛出后，状态码与 body JSON 都嵌在 error.message
 * 文本里。客户端聊天/Agent 两条链路都需要从这段文本里还原出「这是额度不足」以及
 * 余额/所需额度，从而把原始报错替换成「额度不足，请充值」的结构化引导。
 *
 * 本模块只做纯文本解析，不依赖任何运行时类型，聊天/Agent/渲染层均可复用。
 */

/** 额度不足的结构化信息 */
export interface InsufficientCreditsInfo {
  /** 当前余额（解析失败为 undefined） */
  balance?: number
  /** 本次预估所需额度（解析失败为 undefined） */
  required?: number
  /** 面向用户的提示文案 */
  message: string
}

/** 从一段错误文本里提取 HTTP 状态码（兼容 sse-reader 的 `API 错误 (402)` 格式）。 */
function extractStatus(text: string): number | null {
  const patterns = [
    /\((\d{3})\)/, // sse-reader: "xxx API 错误 (402)"
    /\b(?:HTTP|status|statusCode)\s*[:=]?\s*(\d{3})\b/i,
    /\bAPI Error:\s*(\d{3})/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    const code = m?.[1] ? parseInt(m[1], 10) : NaN
    if (code >= 400 && code < 600) return code
  }
  return null
}

/** 尝试从错误文本里抠出嵌入的 JSON body 并解析（sse-reader 会把 body 文本拼在状态码后）。 */
function extractEmbeddedJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 判断给定错误是否为「额度不足」，是则返回结构化信息，否则返回 null。
 *
 * @param error 任意错误（Error 实例、字符串或带 status 字段的对象）
 * @param status 可选的显式 HTTP 状态码（若调用方已拿到，可跳过文本解析）
 */
export function detectInsufficientCredits(
  error: unknown,
  status?: number,
): InsufficientCreditsInfo | null {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : ''

  // 显式状态码优先；否则从对象 status 字段或文本里推断
  const objStatus =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : null
  const httpStatus = status ?? objStatus ?? extractStatus(text)

  // 额度不足的文本特征：
  //  - Profer 自有 402：'额度不足' / 'insufficient_credits'
  //  - New API 上游 403：'预扣费额度失败' / 含 '＄'/'$' 金额 / 'insufficient ... quota'
  //  - server 翻译后：'平台额度' + code='insufficient_credits'
  const quotaTextHit =
    /额度不足|预扣费|平台额度|insufficient[\s_]*(credits|quota|balance)?/i.test(text) ||
    /[＄$]\s*[0-9]/.test(text)

  // 判定为额度不足的条件：
  //  - 状态码是 402（Profer 自有），或
  //  - 状态码是 403 且命中额度文本特征（New API 上游预扣失败），或
  //  - 无明确状态码但命中文本特征
  const isInsufficient =
    httpStatus === 402 ||
    (httpStatus === 403 && quotaTextHit) ||
    (httpStatus == null && quotaTextHit)
  if (!isInsufficient) return null

  const body = extractEmbeddedJson(text)
  const balance =
    body && typeof body.balance === 'number' ? body.balance : undefined
  const required =
    body && typeof body.required === 'number' ? body.required : undefined
  const serverMsg =
    body && typeof body.message === 'string' ? body.message : undefined

  return {
    balance,
    required,
    message: serverMsg || '账户额度不足，请联系管理员充值',
  }
}
