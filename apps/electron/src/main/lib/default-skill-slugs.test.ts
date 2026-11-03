import { describe, expect, test } from 'bun:test'
import { normalizeDefaultSkillSlug, normalizeDefaultSkillSlugs } from './default-skill-slugs'

describe('default Skill slug compatibility', () => {
  test('leaves unknown and former default Skill slugs untouched', () => {
    expect(normalizeDefaultSkillSlug('user-coach')).toBe('user-coach')
    expect(normalizeDefaultSkillSlug('custom-skill')).toBe('custom-skill')
  })

  test('normalizes and deduplicates whitelist entries while preserving undefined and empty semantics', () => {
    expect(normalizeDefaultSkillSlugs(undefined)).toBeUndefined()
    expect(normalizeDefaultSkillSlugs([])).toEqual([])
    expect(normalizeDefaultSkillSlugs(['profer-coach', 'profer-coach', 'custom-skill'])).toEqual([
      'profer-coach',
      'custom-skill',
    ])
  })
})
