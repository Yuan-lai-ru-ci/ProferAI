import { describe, expect, test } from 'bun:test'
import { normalizeDefaultSkillSlug, normalizeDefaultSkillSlugs } from './default-skill-slugs'

describe('default Skill slug compatibility', () => {
  test('normalizes only registered historical default Skill slugs', () => {
    expect(normalizeDefaultSkillSlug('proma-coach')).toBe('profer-coach')
    expect(normalizeDefaultSkillSlug('user-coach')).toBe('user-coach')
  })

  test('normalizes and deduplicates whitelist entries while preserving undefined and empty semantics', () => {
    expect(normalizeDefaultSkillSlugs(undefined)).toBeUndefined()
    expect(normalizeDefaultSkillSlugs([])).toEqual([])
    expect(normalizeDefaultSkillSlugs(['proma-coach', 'profer-coach', 'custom-skill'])).toEqual([
      'profer-coach',
      'custom-skill',
    ])
  })
})
