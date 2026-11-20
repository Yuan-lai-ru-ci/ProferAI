/**
 * 本地模型服务的连接预设。
 *
 * 这些服务都提供 OpenAI 兼容的 `/v1` 接口，差异主要是默认端口。预设只负责
 * 填入 Base URL，不持久化额外字段：用户改地址后仍按 URL 反查当前预设，
 * 旧配置不需要迁移。
 */

export interface LocalRuntimePreset {
  id: string
  label: string
  /** OpenAI 兼容协议根；空串表示「自定义地址」不覆盖用户输入。 */
  baseUrl: string
}

export const LOCAL_RUNTIME_PRESETS: readonly LocalRuntimePreset[] = [
  { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { id: 'unsloth', label: 'Unsloth Studio', baseUrl: 'http://127.0.0.1:8888/v1' },
  { id: 'llamacpp', label: 'llama.cpp (llama-server)', baseUrl: 'http://127.0.0.1:8080/v1' },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { id: 'jan', label: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1' },
  { id: 'custom', label: '自定义地址', baseUrl: '' },
]

/** 与表单一致的地址归一：忽略首尾空白、末尾斜杠与 /v1，仅用于预设反查。 */
function normalizeForMatch(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '').toLowerCase()
}

/**
 * 根据当前 Base URL 反查预设 id。
 *
 * 空地址返回空串（下拉显示占位符）；非空但不在预置端口内返回 `custom`，
 * 这样用户手动填写的地址不会被误标成某一家服务。
 */
export function resolveLocalRuntimePresetId(baseUrl: string): string {
  const normalized = normalizeForMatch(baseUrl)
  if (!normalized) return ''
  return LOCAL_RUNTIME_PRESETS.find((preset) => preset.baseUrl && normalizeForMatch(preset.baseUrl) === normalized)?.id
    ?? 'custom'
}

/** 用户选择的预设是否应该覆盖 Base URL。 */
export function localRuntimePresetBaseUrl(presetId: string): string | undefined {
  const preset = LOCAL_RUNTIME_PRESETS.find((item) => item.id === presetId)
  return preset?.baseUrl || undefined
}
