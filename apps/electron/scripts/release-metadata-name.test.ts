import { expect, test } from 'bun:test'
import { releaseMetadataName } from './release-metadata-name.cjs'
test('stable与prerelease按平台使用各自元数据，不能借用旧latest', () => {
  expect(releaseMetadataName('0.16.28', 'darwin')).toBe('latest-mac.yml')
  expect(releaseMetadataName('0.17.1-beta.1', 'darwin')).toBe('beta-mac.yml')
  expect(releaseMetadataName('0.17.1-beta.1', 'win32')).toBe('beta.yml')
  expect(releaseMetadataName('0.17.1-beta.1', 'linux')).toBe('beta-linux.yml')
  expect(releaseMetadataName('0.17.1+build-beta.1', 'linux')).toBe('latest-linux.yml')
})
