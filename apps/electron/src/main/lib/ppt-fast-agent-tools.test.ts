import { afterEach, describe, expect, test } from 'bun:test'
import AdmZip from 'adm-zip'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePptxFast } from './ppt-fast-agent-tools'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('fast pptx generator', () => {
  test('single call writes an editable PPTX without a Deck Project, Spec, sources, or confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-fast-ppt-'))
    roots.push(root)
    const result = await generatePptxFast({ agentCwd: root }, {
      title: '实验结果速览',
      slides: [
        { title: '实验结果速览', bullets: ['组会汇报', '8 分钟'] },
        { title: '核心发现', bullets: ['误差降低 37%', '验证范围仍有限'] },
        { title: '量化比较', bullets: ['阶段二贡献最大'], chart: { labels: ['基线', '阶段一', '阶段二'], values: [100, 78, 63] } },
      ],
      outputName: 'fast-demo',
    })
    expect(result.slideCount).toBe(3)
    expect(existsSync(result.outputPath)).toBe(true)
    expect(result.outputPath).toBe(join(root, '.context', 'ppt-output', 'fast-demo.pptx'))
    const zip = new AdmZip(result.outputPath)
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).toContain('ppt/presentation.xml')
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3)
    expect(names.some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(true)
    expect(names.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))).toBe(true)
  })
})
