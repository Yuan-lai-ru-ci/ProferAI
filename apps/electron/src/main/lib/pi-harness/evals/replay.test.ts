import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluatePiHarnessFixture } from './replay'
import type { PiHarnessEvalFixture } from './types'

const fixturesDir = join(import.meta.dir, 'fixtures')
const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.json'))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8')) as PiHarnessEvalFixture)

describe('Pi Harness replay eval fixtures', () => {
  test('keeps an explicit, stable fixture corpus', () => {
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      'failed verification without a mutation cannot produce a candidate',
      'manual compact creates no host goal, turn, candidate, or model usage',
      'new conflicting goal proposes a distinct minimal root without resuming old work',
      'native retry and auto compaction remain within one turn',
      'user stop pauses one turn without a follow-up turn',
      'verified readback remains a shadow-only ready-task candidate',
    ])
  })

  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const first = evaluatePiHarnessFixture(fixture)
      const second = evaluatePiHarnessFixture(fixture)
      expect(first).toEqual(second)
      expect(first.failures).toEqual([])
      expect(first.passed).toBe(true)
      expect(first.actual.telemetry.taskTransitions).toBe(0)
    })
  }
})
