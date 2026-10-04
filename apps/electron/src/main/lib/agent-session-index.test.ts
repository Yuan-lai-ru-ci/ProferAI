import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import { createAgentSessionIndexStore } from './agent-session-index'

let root = ''
let path = ''
let store: ReturnType<typeof createAgentSessionIndexStore>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-session-index-'))
  path = join(root, 'agent-sessions.json')
  store = createAgentSessionIndexStore(() => path)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function meta(id: string, patch: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id, title: id, createdAt: 1, updatedAt: 1, agentRuntime: 'claude', ...patch }
}

function disk(sessions: unknown[]): void {
  writeFileSync(path, JSON.stringify({ version: 1, sessions }), 'utf8')
}

test('空索引和原子往返保留元数据及备份', () => {
  expect(store.read()).toEqual({ version: 1, sessions: [] })
  store.write({ version: 1, sessions: [meta('first')] })
  expect(store.get('first')?.title).toBe('first')
  store.write({ version: 1, sessions: [meta('second')] })
  expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).sessions[0].id).toBe('first')
  expect(store.get('first')).toBeUndefined()
  expect(store.get('second')?.id).toBe('second')
})

test('相同磁盘版本复用缓存，外部内容替换后失效', () => {
  disk([meta('first')])
  const cached = store.read()
  expect(store.read()).toBe(cached)
  disk([meta('first', { title: 'external title with different size' })])
  expect(store.read()).not.toBe(cached)
  expect(store.get('first')?.title).toBe('external title with different size')
})

test('相同文件大小也根据 mtime 感知外部替换', () => {
  disk([meta('first', { title: 'aaaa' })])
  store.read()
  disk([meta('first', { title: 'bbbb' })])
  const later = new Date(Date.now() + 10_000)
  utimesSync(path, later, later)
  expect(store.get('first')?.title).toBe('bbbb')
})

test('删除主文件后不复用缓存，无恢复文件时返回空索引', () => {
  disk([meta('first')])
  store.read()
  unlinkSync(path)
  expect(store.get('first')).toBeUndefined()
  expect(store.read()).toEqual({ version: 1, sessions: [] })
})

test('列表保留隐藏草稿、可选归档并按更新时间排序，不改变索引顺序', () => {
  disk([
    meta('old', { updatedAt: 1 }), meta('archived', { archived: true, updatedAt: 4 }),
    meta('draft', { draft: true, updatedAt: 3 }), meta('new', { updatedAt: 2 }),
    meta('archived-draft', { archived: true, draft: true, updatedAt: 5 }),
  ])
  expect(store.list().map((s) => s.id)).toEqual(['draft', 'new', 'old'])
  expect(store.list(true).map((s) => s.id)).toEqual(['archived-draft', 'archived', 'draft', 'new', 'old'])
  expect(store.countArchived()).toBe(1)
  expect(store.read().sessions.map((s) => s.id)).toEqual(['old', 'archived', 'draft', 'new', 'archived-draft'])
})

test('旧 runtime 只在内存归一化为 Claude，合法 Pi 保留且不改写原文件', () => {
  disk([
    { ...meta('legacy'), agentRuntime: undefined },
    { ...meta('invalid'), agentRuntime: 'unknown-runtime' },
    meta('pi', { agentRuntime: 'pi' }),
  ])
  const before = readFileSync(path, 'utf8')
  expect(store.list(true).map((s) => s.agentRuntime)).toEqual(['claude', 'claude', 'pi'])
  expect(readFileSync(path, 'utf8')).toBe(before)
})

test('清理遗留知识库字段时保留其他元数据与索引扩展字段', () => {
  writeFileSync(path, JSON.stringify({ version: 1, extra: 'keep', sessions: [
    { ...meta('legacy', { workspaceId: 'workspace', piEntryBindings: { user: 'entry' } }), knowledgeReferences: ['obsolete'] },
  ] }))
  expect(store.get('legacy')).not.toHaveProperty('knowledgeReferences')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  expect(saved.extra).toBe('keep')
  expect(saved.sessions[0]).toMatchObject({ workspaceId: 'workspace', piEntryBindings: { user: 'entry' } })
  expect(saved.sessions[0]).not.toHaveProperty('knowledgeReferences')
})

test('主文件损坏时沿用 safe-file 的备份恢复', () => {
  writeFileSync(`${path}.bak`, JSON.stringify({ version: 1, sessions: [meta('recovered')] }))
  writeFileSync(path, '{broken')
  expect(store.get('recovered')?.id).toBe('recovered')
  expect(JSON.parse(readFileSync(path, 'utf8')).sessions[0].id).toBe('recovered')
})

test('写失败后缓存失效，不暴露调用方原地修改的未落盘数据', () => {
  disk([meta('first')])
  const cached = store.read()
  cached.sessions[0]!.title = 'unsaved'
  mkdirSync(`${path}.tmp`)
  expect(() => store.write(cached)).toThrow('写入 Agent 会话索引失败')
  expect(store.get('first')?.title).toBe('first')
})

test('遗留字段清理失败不缓存迁移结果，下次读取重试', () => {
  disk([{ ...meta('legacy'), knowledgeReferences: ['obsolete'] }])
  mkdirSync(`${path}.tmp`)
  expect(store.get('legacy')).not.toHaveProperty('knowledgeReferences')
  expect(JSON.parse(readFileSync(path, 'utf8')).sessions[0]).toHaveProperty('knowledgeReferences')
  rmSync(`${path}.tmp`, { recursive: true })
  store.read()
  expect(JSON.parse(readFileSync(path, 'utf8')).sessions[0]).not.toHaveProperty('knowledgeReferences')
})

test('不同 store 的缓存隔离，不依赖 Agent manager 或 Electron', () => {
  const otherPath = join(root, 'other.json')
  const other = createAgentSessionIndexStore(() => otherPath)
  store.write({ version: 1, sessions: [meta('first')] })
  other.write({ version: 1, sessions: [meta('other')] })
  expect(store.get('other')).toBeUndefined()
  expect(other.get('first')).toBeUndefined()
})
