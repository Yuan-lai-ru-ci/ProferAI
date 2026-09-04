import { describe, expect, test } from 'bun:test'
import {
  extractZhipuCodingTeamApiToken,
  parseZhipuTeamCredentials,
} from './channel'

describe('Zhipu Coding Plan team credentials', () => {
  test('extracts the API key from a semicolon-delimited secret', () => {
    const secret = 'apiKey=team-token; bigmodel_organization=org-1; bigmodel_project=project-1'
    expect(parseZhipuTeamCredentials(secret)).toEqual({
      apiKey: 'team-token',
      organization: 'org-1',
      project: 'project-1',
    })
    expect(extractZhipuCodingTeamApiToken(secret)).toBe('team-token')
  })

  test('extracts the API key from JSON and preserves a plain legacy token', () => {
    expect(extractZhipuCodingTeamApiToken('{"token":"json-token","organization":"org-2"}')).toBe('json-token')
    expect(extractZhipuCodingTeamApiToken('legacy-token')).toBe('legacy-token')
  })
})
