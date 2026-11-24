import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStreamBindingLog } from './stream-binding-log'

test('满额旧日志在首次写入时轮转；同进程可继续覆盖唯一备份，不再停止记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-bindings-'))
  try {
    const file = join(dir, 'stream-binding.log')
    writeFileSync(file, 'x'.repeat(4_000))
    const write = createStreamBindingLog(() => file, 3_000)
    write({ sessionId: 'first' })
    expect(readFileSync(`${file}.1`, 'utf8')).toHaveLength(4_000)
    for (let i = 0; i < 50; i++) write({ sessionId: `会话-${i}` })
    expect(readFileSync(file, 'utf8')).toContain('会话-49')
    expect(readdirSync(dir).sort()).toEqual(['stream-binding.log', 'stream-binding.log.1'])
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(3_000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
