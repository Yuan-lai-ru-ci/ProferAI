import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import {
  copyAttachmentImage,
  copyChatImage,
  copyPreviewUrlImage,
} from './copy-image-to-clipboard'

/** 保存并替换全局 stub，afterEach 统一还原 */
const originals = new Map<string, PropertyDescriptor | undefined>()

function stubGlobal(key: string, value: unknown): void {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, value })
}

function restoreGlobals(): void {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  originals.clear()
}

/** 桩 ClipboardItem：记录构造入参，供断言剪贴板内容 */
class FakeClipboardItem {
  static instances: FakeClipboardItem[] = []
  items: Record<string, unknown>
  constructor(items: Record<string, unknown>) {
    this.items = items
    FakeClipboardItem.instances.push(this)
  }
}

let copyImageMock: ReturnType<typeof mock>
let clipboardWriteMock: ReturnType<typeof mock>
let fetchMock: ReturnType<typeof mock>

beforeEach(() => {
  FakeClipboardItem.instances = []
  copyImageMock = mock(() => Promise.resolve(true))
  clipboardWriteMock = mock(() => Promise.resolve())
  fetchMock = mock(() => Promise.reject(new Error('fetch 不应被调用')))
  stubGlobal('window', { electronAPI: { copyImage: copyImageMock } })
  stubGlobal('navigator', { clipboard: { write: clipboardWriteMock } })
  stubGlobal('ClipboardItem', FakeClipboardItem)
  stubGlobal('fetch', fetchMock)
})

afterEach(restoreGlobals)

describe('copyAttachmentImage', () => {
  test('Given 主进程返回成功 When 复制附件图片 Then 完成且不抛错', async () => {
    await copyAttachmentImage('conv-1/uuid.png')
    expect(copyImageMock).toHaveBeenCalledWith('conv-1/uuid.png')
  })

  test('Given 主进程返回 false When 复制附件图片 Then 抛出图片数据为空', async () => {
    copyImageMock = mock(() => Promise.resolve(false))
    stubGlobal('window', { electronAPI: { copyImage: copyImageMock } })
    await expect(copyAttachmentImage('conv-1/empty.png')).rejects.toThrow('图片数据为空或格式不受支持')
  })

  test('Given 主进程拒绝（如路径不安全）When 复制附件图片 Then 原样向上抛', async () => {
    copyImageMock = mock(() => Promise.reject(new Error('附件路径不在安全目录内')))
    stubGlobal('window', { electronAPI: { copyImage: copyImageMock } })
    await expect(copyAttachmentImage('../evil.png')).rejects.toThrow('附件路径不在安全目录内')
  })
})

describe('copyPreviewUrlImage', () => {
  test('Given fetch 返回图片 blob When 复制预览图 Then 经 ClipboardItem 写入剪贴板', async () => {
    const blob = { type: 'image/png' }
    fetchMock = mock(() => Promise.resolve({ ok: true, blob: async () => blob }))
    stubGlobal('fetch', fetchMock)

    await copyPreviewUrlImage('blob:http://localhost/abc')

    expect(fetchMock).toHaveBeenCalledWith('blob:http://localhost/abc')
    expect(clipboardWriteMock).toHaveBeenCalledTimes(1)
    expect(FakeClipboardItem.instances).toHaveLength(1)
    expect(FakeClipboardItem.instances[0]!.items).toEqual({ 'image/png': blob })
  })

  test('Given fetch 返回非图片类型 When 复制预览图 Then 抛出类型错误且不写剪贴板', async () => {
    fetchMock = mock(() => Promise.resolve({ ok: true, blob: async () => ({ type: 'text/html' }) }))
    stubGlobal('fetch', fetchMock)

    await expect(copyPreviewUrlImage('profer-file://token')).rejects.toThrow('不是图片类型')
    expect(clipboardWriteMock).not.toHaveBeenCalled()
  })

  test('Given fetch 响应非 2xx When 复制预览图 Then 抛出 HTTP 状态错误', async () => {
    fetchMock = mock(() => Promise.resolve({ ok: false, status: 404, blob: async () => ({}) }))
    stubGlobal('fetch', fetchMock)

    await expect(copyPreviewUrlImage('profer-file://token')).rejects.toThrow('HTTP 404')
  })
})

describe('copyChatImage', () => {
  test('Given 同时有 localPath 与 src When 复制 Then 只走主进程 IPC 不 fetch', async () => {
    await copyChatImage({ localPath: 'conv-1/uuid.png', src: 'blob:http://localhost/abc' })
    expect(copyImageMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('Given 只有 src（未落盘）When 复制 Then 走 fetch + ClipboardItem', async () => {
    const blob = { type: 'image/jpeg' }
    fetchMock = mock(() => Promise.resolve({ ok: true, blob: async () => blob }))
    stubGlobal('fetch', fetchMock)

    await copyChatImage({ src: 'data:image/jpeg;base64,AAA' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(FakeClipboardItem.instances[0]!.items).toEqual({ 'image/jpeg': blob })
  })

  test('Given 两者皆无 When 复制 Then 抛出没有可复制的图片数据', async () => {
    await expect(copyChatImage({})).rejects.toThrow('没有可复制的图片数据')
  })
})
