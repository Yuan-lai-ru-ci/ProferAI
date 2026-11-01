import { describe, expect, test } from 'bun:test'
import { appendAgentTaskPrompt, prependPiCompactionTaskGuidance } from '@profer/shared'

describe('任务指导 prompt helper', () => {
  const guidance = '## Profer 受管浏览器\n必须按授权根目录操作。'

  test('普通任务仅追加 guidance，compact command 保持原样', () => {
    const prompt = appendAgentTaskPrompt('动态上下文\n\n打开网页。', guidance, false)
    expect(prompt.match(/<turn_guidance>/g)).toHaveLength(1)
    expect(prompt).toContain('动态上下文')
    expect(prompt).toContain(guidance)
    expect(appendAgentTaskPrompt('/compact', guidance, true)).toBe('/compact')
  })

  test('自动压缩续跑在通用指令前保留任务指导', () => {
    const prompt = prependPiCompactionTaskGuidance('<profer_compaction_continuation>继续任务</profer_compaction_continuation>', guidance)
    expect(prompt.indexOf(guidance)).toBeLessThan(prompt.indexOf('<profer_compaction_continuation>'))
  })

  test('无任务指导时续跑 prompt 完全保持不变', () => {
    const prompt = '<profer_compaction_continuation>继续任务</profer_compaction_continuation>'
    expect(prependPiCompactionTaskGuidance(prompt, undefined)).toBe(prompt)
    expect(prependPiCompactionTaskGuidance(prompt, '')).toBe(prompt)
  })
})
