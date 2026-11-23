import { describe, expect, test } from 'bun:test'
import { readCoreOsId } from './os-identity'

describe('Core OS identity', () => {
  test.each(['ubuntu', 'debian', 'unknown-distro'])('returns only the exact ID: %s', id => {
    expect(readCoreOsId('linux', () => `NAME="Other name"\nID="${id}"\nID_LIKE=ubuntu\n`)).toBe(id)
  })

  test('supports unquoted and single quoted IDs', () => {
    expect(readCoreOsId('linux', () => 'ID=debian\n')).toBe('debian')
    expect(readCoreOsId('linux', () => "ID='ubuntu'\n")).toBe('ubuntu')
  })

  test.each(['darwin', 'win32', 'freebsd'])('does not read files on %s', platform => {
    let reads = 0
    expect(readCoreOsId(platform, () => { reads += 1; return 'ID=ubuntu' })).toBeUndefined()
    expect(reads).toBe(0)
  })

  test('falls back to vendor os-release when /etc/os-release is missing', () => {
    const paths: string[] = []
    expect(readCoreOsId('linux', path => {
      paths.push(path)
      if (path === '/etc/os-release') throw new Error('ENOENT')
      return 'ID=debian\n'
    })).toBe('debian')
    expect(paths).toEqual(['/etc/os-release', '/usr/lib/os-release'])
  })

  test('does not guess Ubuntu for missing or malformed IDs', () => {
    expect(readCoreOsId('linux', () => { throw new Error('ENOENT') })).toBeUndefined()
    for (const text of ['ID_LIKE=ubuntu\n', 'ID="$(uname)"\n', 'NAME=Ubuntu\n', 'ID=\n']) {
      expect(readCoreOsId('linux', () => text)).toBeUndefined()
    }
  })
})
