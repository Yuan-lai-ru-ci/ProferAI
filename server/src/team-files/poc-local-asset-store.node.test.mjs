/** 团队资料库生命周期 PoC：Node 20+ 内置测试，完全使用临时目录。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveToTrash, purgeTrashEntry, restoreFromTrash } from './poc-local-asset-store.mjs'

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'profer-team-files-poc-'))
  const activeRoot = join(root, 'assets')
  const trashRoot = join(root, 'trash')
  await mkdir(activeRoot, { recursive: true })
  await mkdir(trashRoot, { recursive: true })
  return { root, activeRoot, trashRoot }
}

async function withFixture(callback) {
  const fixture = await createFixture()
  try {
    await callback(fixture)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
}

test('Given 删除文件 When 移入回收站 Then 原位置消失且回收站保留字节', async () => {
  await withFixture(async ({ activeRoot, trashRoot }) => {
    await mkdir(join(activeRoot, '产品'), { recursive: true })
    await writeFile(join(activeRoot, '产品', '方案.md'), '版本一')

    const result = await moveToTrash({
      activeRoot,
      trashRoot,
      sourcePath: '产品/方案.md',
      trashEntryId: 'trash-1',
    })

    assert.equal(result.state, 'trashed')
    assert.equal(await readFile(result.trashPath, 'utf8'), '版本一')
    await assert.rejects(readFile(join(activeRoot, '产品', '方案.md'), 'utf8'))
  })
})

test('Given 原路径已被新文件占用 When 恢复 Then 自动恢复为已恢复副本且不覆盖新文件', async () => {
  await withFixture(async ({ activeRoot, trashRoot }) => {
    await mkdir(join(activeRoot, '产品'), { recursive: true })
    await writeFile(join(activeRoot, '产品', '方案.md'), '旧版本')
    await moveToTrash({ activeRoot, trashRoot, sourcePath: '产品/方案.md', trashEntryId: 'trash-2' })
    await writeFile(join(activeRoot, '产品', '方案.md'), '新版本')

    const result = await restoreFromTrash({
      activeRoot,
      trashRoot,
      originalPath: '产品/方案.md',
      trashEntryId: 'trash-2',
    })

    assert.equal(result.state, 'restored_as_copy')
    assert.equal(result.restoredPath, '产品/方案（已恢复）.md')
    assert.equal(await readFile(join(activeRoot, '产品', '方案.md'), 'utf8'), '新版本')
    assert.equal(await readFile(join(activeRoot, result.restoredPath), 'utf8'), '旧版本')
  })
})

test('Given 已进入回收站的条目 When 重复移入与重复清理 Then 操作幂等且不会抛出', async () => {
  await withFixture(async ({ activeRoot, trashRoot }) => {
    await writeFile(join(activeRoot, '计划.txt'), '内容')
    await moveToTrash({ activeRoot, trashRoot, sourcePath: '计划.txt', trashEntryId: 'trash-3' })

    const repeatedMove = await moveToTrash({ activeRoot, trashRoot, sourcePath: '计划.txt', trashEntryId: 'trash-3' })
    assert.equal(repeatedMove.state, 'already_trashed')

    assert.deepEqual(await purgeTrashEntry({ trashRoot, trashEntryId: 'trash-3' }), { state: 'purged' })
    assert.deepEqual(await purgeTrashEntry({ trashRoot, trashEntryId: 'trash-3' }), { state: 'purged' })
  })
})
