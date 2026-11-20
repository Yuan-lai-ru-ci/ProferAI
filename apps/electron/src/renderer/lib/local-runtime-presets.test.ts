import { describe, expect, test } from 'bun:test'
import { LOCAL_RUNTIME_PRESETS, localRuntimePresetBaseUrl, resolveLocalRuntimePresetId } from './local-runtime-presets'

describe('本地模型服务预设', () => {
  test('Given 常见本地服务 When 按地址反查 Then 识别对应预设', () => {
    expect(resolveLocalRuntimePresetId('http://127.0.0.1:11434/v1')).toBe('ollama')
    expect(resolveLocalRuntimePresetId('http://127.0.0.1:1234/v1/')).toBe('lmstudio')
    expect(resolveLocalRuntimePresetId('http://127.0.0.1:1234')).toBe('lmstudio')
    expect(resolveLocalRuntimePresetId('http://127.0.0.1:8888/v1')).toBe('unsloth')
    expect(resolveLocalRuntimePresetId('http://127.0.0.1:8080/v1')).toBe('llamacpp')
    expect(resolveLocalRuntimePresetId('http://127.0.0.1:8000/v1')).toBe('vllm')
  })

  test('Given 空地址或自定义地址 When 反查 Then 返回占位或 custom', () => {
    expect(resolveLocalRuntimePresetId('')).toBe('')
    expect(resolveLocalRuntimePresetId('http://10.0.0.5:9000/v1')).toBe('custom')
  })

  test('Given 预设选择 When 取地址 Then 自定义不覆盖输入框', () => {
    expect(localRuntimePresetBaseUrl('lmstudio')).toBe('http://127.0.0.1:1234/v1')
    expect(localRuntimePresetBaseUrl('custom')).toBeUndefined()
    expect(LOCAL_RUNTIME_PRESETS.some((preset) => preset.label === 'Unsloth Studio')).toBe(true)
  })
})
