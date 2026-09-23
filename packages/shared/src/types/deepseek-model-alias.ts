/**
 * DeepSeek 官方模型 ID 归一 — 单一 source of truth。
 *
 * 0.86 起 Pi catalog（`pi-ai/dist/providers/data/deepseek.json`）把主力 Flash 模型的
 * 正式 ID 从不带版本号的旧写法换成了 `deepseek-flash`（DeepSeek V4.1 Flash，原生支持
 * 图片输入），旧的 `deepseek-v4-flash` 已从 catalog 移除：
 *
 *   - 0.84.3 catalog：`deepseek-v4-flash` / `deepseek-v4-pro`
 *   - 0.86.1 catalog：`deepseek-flash` / `deepseek-v4-pro`
 *
 * 但渠道配置、历史会话、外部网关里仍大量存在旧写法与官方短名，所以这里同时兜住两类：
 *   - 旧代 ID：`deepseek-v4-flash` → 归一为 catalog ID `deepseek-flash`
 *   - 官方短名：`deepseek-pro` → 等价正式 ID `deepseek-v4-pro`
 *
 * 只要有一处没归一，同一个模型就会因写法不同拿到不同的窗口 / 价格 / 图片能力 / 思考档位——
 * 因此凡是「按 V4 代 SKU 判定」或「取其元数据」的地方，都必须先过这里。
 *
 * 注意：本模块只做 ID 归一，不代表任何 provider 链路已验证过 1M 协商；
 * provider 侧能力仍由 context-window 的 supportsVerified1MContext 判定。
 */

/** 需要归一为 catalog 正式 ID 的 DeepSeek 写法；键为历史写法 / 官方短名，值为 catalog ID。 */
export const DEEPSEEK_V4_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // 0.86 起 Flash 的 catalog ID 已去掉版本号；旧代写法统一归一到新 ID，
  // 否则 catalog 查不到条目，模型会丢掉窗口 / 成本 / 图片能力，只剩 fallback 默认值。
  'deepseek-v4-flash': 'deepseek-flash',
  // deepseek-pro 是官方无版本号短名，正式 ID 仍带版本号。
  'deepseek-pro': 'deepseek-v4-pro',
})

/**
 * DeepSeek 官方无版本号短名。
 *
 * 刻意与别名表分开维护：`deepseek-flash` 自 0.86 起本身就是 catalog 正式 ID，
 * 不该出现在「需要归一的别名」表里；但它仍属于「不带版本段、按代际继承 1M」的官方短名，
 * 供 context-window 的代际规则识别（`deepseek-flash-latest` 这类同代变体也要继承）。
 */
export const DEEPSEEK_V4_SHORT_MODEL_NAMES: readonly string[] = Object.freeze([
  'deepseek-flash',
  'deepseek-pro',
])

/**
 * 去掉 Claude SDK 私有的 `[1m]` 后缀与网关路径前缀，只保留最后一段小写模型名。
 * 语义必须与 context-window 的 normalizeContextModelId 保持一致（后者复用本函数）。
 */
export function normalizeModelIdTail(modelId?: string): string | undefined {
  const trimmed = modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
  if (!trimmed) return undefined
  const segments = trimmed.split('/').filter(Boolean)
  return segments.at(-1) ?? trimmed
}

/**
 * 归一模型 ID，并把 DeepSeek 历史写法 / 官方短名解析为等价 catalog ID。
 * 无需归一时返回归一化后的原 ID；无法解析时返回 undefined。
 */
export function resolveDeepSeekV4ModelId(modelId?: string): string | undefined {
  const model = normalizeModelIdTail(modelId)
  if (!model) return undefined
  return DEEPSEEK_V4_MODEL_ALIASES[model] ?? model
}

/** 该 ID 是否为需要归一的 DeepSeek 历史写法或官方短名（含网关前缀与 `[1m]` 后缀写法）。 */
export function isDeepSeekV4Alias(modelId?: string): boolean {
  const model = normalizeModelIdTail(modelId)
  return model != null && Object.hasOwn(DEEPSEEK_V4_MODEL_ALIASES, model)
}
