/**
 * conversation-manager 分支树契约单测
 *
 * 覆盖 PR #121 review 提出的三类主进程契约：
 * - 分叉隔离：forkBranchAt 创建兄弟节点，旧链不被动
 * - 严格 root→leaf：setActivePath 入口校验 root 起点 + 连续父链 + id 存在
 * - 子树删除：deleteMessageFromTree 删 desc subtree 后 activePath 按契约修复
 *
 * 用 PROFER_CONFIG_DIR 隔离 config 目录到 mkdtemp 子目录，跑完 afterAll 清理，
 * 不污染主进程运行时配置；同时避开 getConfigDirName() 顶层 require('electron') 的副作用。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'profer-conv-test-'))
  // PROFER_CONFIG_DIR 必须先于 conversation-manager 顶层 getConversationsDir() 等副作用读 env
  process.env.PROFER_CONFIG_DIR = tmpDir
})

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.PROFER_CONFIG_DIR
  }
})

import {
  appendMessage,
  createConversation,
  deleteMessageFromTree,
  forkBranchAt,
  getBranchTree,
  getConversationBranch,
  setActivePath,
  listConversations,
  updateConversationMeta,
} from './conversation-manager'
import type { ChatMessage } from '@profer/shared'

function freshConv(): string {
  return createConversation('分支树测试').id
}

function user(content: string, parentId: string | null): ChatMessage {
  return {
    id: crypto.randomUUID(),
    parentId,
    role: 'user',
    content,
    createdAt: Date.now(),
  }
}

function assistant(content: string, parentId: string | null): ChatMessage {
  return {
    id: crypto.randomUUID(),
    parentId,
    role: 'assistant',
    content,
    createdAt: Date.now(),
  }
}

describe('PR #121 review：forkBranchAt 兄弟分叉隔离', () => {
  test('Given 根 + user/assistant 链 When 在 user 节点处 fork 新 user Then 旧 assistant 不被动、新旧 user 互为兄弟、activePath 切到新分支（包含父链）', () => {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('q-1', r.id)
    const a1 = assistant('reply-1', u1.id)
    for (const m of [r, u1, a1]) appendMessage(convId, m)
    setActivePath(convId, [r.id, u1.id, a1.id])

    // 在 u1 上分叉：forked 应挂在 u1.parent (= r) 之下，与 u1 互为兄弟
    const forked = forkBranchAt(convId, u1.id, { role: 'user', content: 'q-2 (新分支)' })

    // 新分支挂在根下，旧分支全部节点必须仍在 JSONL 内
    const tree = getBranchTree(convId)
    expect(tree.nodes[r.id]).toBeDefined()
    expect(tree.nodes[u1.id]).toBeDefined()
    expect(tree.nodes[a1.id]).toBeDefined()
    expect(tree.nodes[forked.id]).toBeDefined()
    // forked.parentId = anchor (u1) 的 parentId = r.id（兄弟关系而非嵌套）
    expect(forked.parentId).toBe(r.id)

    // 根的 childIds 必须同时包含旧兄弟 u1 与新兄弟 forked
    expect(tree.nodes[r.id]!.childIds).toContain(u1.id)
    expect(tree.nodes[r.id]!.childIds).toContain(forked.id)

    // activePath 应切到 [r, forked]：truncIdx=1（u1 在 path 中），slice(0,1)=[r] + [forked]
    expect(tree.activePath).toEqual([r.id, forked.id])
    expect(getConversationBranch(convId).map((m) => m.content)).toEqual(['root', 'q-2 (新分支)'])
  })

  test('Given 根作为 activePath 唯一起点 When 在根处 fork 新 user Then forked 自身成为新 activePath 的起点（root 之前已无可截内容）', () => {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('q-1', r.id)
    appendMessage(convId, r)
    appendMessage(convId, u1)
    setActivePath(convId, [r.id, u1.id])

    // 在 r 上分叉：forked 挂在 r.parent (null)，与 r 互为兄弟（但 r 也是根）
    // 实际语义：r 是 activePath[0]，truncIdx=0，slice(0,0)=[] + [forked] = [forked]
    const forked = forkBranchAt(convId, r.id, { role: 'user', content: 'r 的兄弟' })

    expect(forked.parentId).toBeNull()

    const tree = getBranchTree(convId)
    // 旧分支都还在
    expect(tree.nodes[r.id]).toBeDefined()
    expect(tree.nodes[u1.id]).toBeDefined()
    // root 已不再是 activePath 的第一节点（trunc 把它清掉了）
    expect(tree.activePath).toEqual([forked.id])
  })
})

describe('PR #121 review：setActivePath 严格 root→leaf 契约', () => {
  function setupChain(): { convId: string; r: ChatMessage; u1: ChatMessage; u2: ChatMessage } {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('q-1', r.id)
    const u2 = user('q-2', u1.id)
    for (const m of [r, u1, u2]) appendMessage(convId, m)
    return { convId, r, u1, u2 }
  }

  test('Given 合法链 When 设置完整 root→leaf activePath Then 接受', () => {
    const { convId, r, u1, u2 } = setupChain()
    setActivePath(convId, [r.id, u1.id, u2.id])
    expect(getConversationBranch(convId).map((m) => m.content)).toEqual(['root', 'q-1', 'q-2'])
  })

  test('Given 合法链 When 设置仅含根的 activePath Then 接受', () => {
    const { convId, r } = setupChain()
    setActivePath(convId, [r.id])
    expect(getConversationBranch(convId).map((m) => m.content)).toEqual(['root'])
  })

  test('Given 任意 activePath 当 path 为空时 Then 抛错（与原约定一致）', () => {
    const convId = freshConv()
    expect(() => setActivePath(convId, [])).toThrow(/空/)
  })

  test('Given 合法链 When 设置非 root 起点 activePath Then 抛错（必须是 parentId=null 的首节点）', () => {
    const { convId, u1 } = setupChain()
    expect(() => setActivePath(convId, [u1.id])).toThrow(/root|parentId|null/)
  })

  test('Given 合法链 When 设置链不连续的 activePath（跳过中间节点） Then 抛错', () => {
    const { convId, r, u2 } = setupChain()
    // 跳过 u1 直接 r → u2，链断开
    expect(() => setActivePath(convId, [r.id, u2.id])).toThrow(/连续|parentId/)
  })

  test('Given 合法链 When 设置包含不存在 id 的 activePath Then 抛错', () => {
    const { convId, r } = setupChain()
    expect(() => setActivePath(convId, [r.id, 'bogus-id-not-in-conversation'])).toThrow(/不存在/)
  })
})

describe('PR #121 review：deleteMessageFromTree 子树删除 + activePath 修复', () => {
  test('Given 根 + 两条兄弟 user 分支 When 删除其中一支叶节点 Then 该分支整棵 desc subtree 被删、兄弟支不动、activePath 退回到最近仍存在的祖先节点', () => {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('q-1', r.id)
    const a1 = assistant('reply-1', u1.id)
    const u2 = user('q-2', r.id)
    const a2 = assistant('reply-2', u2.id)
    for (const m of [r, u1, a1, u2, a2]) appendMessage(convId, m)
    // 注意：activePath = [r, u2, a2]——u1 不在 active 上，删 u2/a2 后 activePath 仅剩 [r]
    setActivePath(convId, [r.id, u2.id, a2.id])

    deleteMessageFromTree(convId, u2.id)

    const tree = getBranchTree(convId)
    expect(tree.nodes[u2.id]).toBeUndefined()
    expect(tree.nodes[a2.id]).toBeUndefined()
    // 兄弟支 u1/a1 不动
    expect(tree.nodes[u1.id]).toBeDefined()
    expect(tree.nodes[a1.id]).toBeDefined()
    // activePath：[r, u2, a2] 过滤 → [r]，r 是合法 root→leaf 链（r.parentId=null）
    expect(tree.activePath).toEqual([r.id])
  })

  test('Given 非分叉 user/assistant 链 When 删除 assistant 中间节点（连同后续 desc subtree） Then activePath 截断到删除点之前', () => {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('q-1', r.id)
    const a1 = assistant('reply-1', u1.id)
    const u2 = user('q-2', a1.id) // u2 挂在 a1 之下
    for (const m of [r, u1, a1, u2]) appendMessage(convId, m)
    setActivePath(convId, [r.id, u1.id, a1.id])

    // 删 a1：toDelete = {a1, u2}（u2 是 a1 的 desc），但 u1 不动
    deleteMessageFromTree(convId, a1.id)

    const tree = getBranchTree(convId)
    expect(tree.nodes[a1.id]).toBeUndefined()
    expect(tree.nodes[u2.id]).toBeUndefined()
    // activePath：[r, u1, a1] 过滤 → [r, u1]，链连续
    expect(tree.activePath).toEqual([r.id, u1.id])
    expect(getConversationBranch(convId).map((m) => m.content)).toEqual(['root', 'q-1'])
  })

  test('Given 整棵对话树全在 activePath 上 When 删根 Then getConversationBranch 退回空', () => {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('q-1', r.id)
    const a1 = assistant('reply-1', u1.id)
    for (const m of [r, u1, a1]) appendMessage(convId, m)
    setActivePath(convId, [r.id, u1.id, a1.id])

    deleteMessageFromTree(convId, r.id)

    // 全部节点被删，remaining 中没有 parentId=null 的根，getConversationBranch fallback 也找不到任何东西
    expect(getConversationBranch(convId)).toEqual([])
    expect(Object.keys(getBranchTree(convId).nodes)).toHaveLength(0)
  })

  test('Given 根挂多个互不相关 user 分支 When 删非 active 分支上的祖先节点 Then activePath 不受影响', () => {
    const convId = freshConv()
    const r = user('root', null)
    const u1 = user('active-q', r.id)
    const a1 = assistant('active-reply', u1.id)
    const u2 = user('inactive-q', r.id)
    const a2 = assistant('inactive-reply', u2.id)
    for (const m of [r, u1, a1, u2, a2]) appendMessage(convId, m)
    setActivePath(convId, [r.id, u1.id, a1.id])

    // 删非 active 支上的 user 节点
    deleteMessageFromTree(convId, u2.id)

    const tree = getBranchTree(convId)
    expect(tree.nodes[u2.id]).toBeUndefined()
    expect(tree.nodes[a2.id]).toBeUndefined()
    // activePath 完全不变
    expect(tree.activePath).toEqual([r.id, u1.id, a1.id])
  })
})

describe('欢迎对话标记（isWelcome）', () => {
  test('Given 普通对话 When 创建 Then 不带 isWelcome，迁移入口照常可用', () => {
    const convId = createConversation('普通问答').id
    const meta = listConversations(true).find((item) => item.id === convId)
    expect(meta).toBeDefined()
    expect(meta?.isWelcome).toBeUndefined()
  })

  test('Given 欢迎对话 When 标记 isWelcome Then 后续改标题不会丢标记', () => {
    const convId = createConversation('了解 Profer').id
    updateConversationMeta(convId, { isWelcome: true })
    updateConversationMeta(convId, { title: '了解 Profer 2' })

    const meta = listConversations(true).find((item) => item.id === convId)
    expect(meta?.title).toBe('了解 Profer 2')
    expect(meta?.isWelcome).toBe(true)
  })
})
