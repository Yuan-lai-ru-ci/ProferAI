import { describe, expect, test } from 'bun:test'
import {
  FILE_REFERENCE_DRAG_MIME,
  getFileReferenceDragData,
  isFileReferenceDrag,
  setFileReferenceDragData,
  toFileReferenceMentionPath,
  toFileReferenceMentions,
  type FileReferenceDragItem,
} from './file-reference-drag'

/** 最小 DataTransfer 替身：只保留拖放协议用到的读写能力。 */
class FakeDataTransfer {
  private store = new Map<string, string>()
  effectAllowed = 'uninitialized'

  get types(): string[] {
    return [...this.store.keys()]
  }

  setData(type: string, value: string): void {
    this.store.set(type, value)
  }

  getData(type: string): string {
    return this.store.get(type) ?? ''
  }
}

function createDataTransfer(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer
}

describe('文件引用拖放协议', () => {
  test('写入后能读出条目，并带 text/plain 路径兜底', () => {
    const dataTransfer = createDataTransfer()
    setFileReferenceDragData(dataTransfer, [
      { path: '/ws/src/app.ts', name: 'app.ts' },
      { path: '/ws/docs', name: 'docs', isDirectory: true },
    ])

    expect(isFileReferenceDrag(dataTransfer)).toBe(true)
    expect(dataTransfer.getData('text/plain')).toBe('/ws/src/app.ts\n/ws/docs')
    expect((dataTransfer as unknown as FakeDataTransfer).effectAllowed).toBe('copy')
    expect(getFileReferenceDragData(dataTransfer)).toEqual([
      { path: '/ws/src/app.ts', name: 'app.ts' },
      { path: '/ws/docs', name: 'docs', isDirectory: true },
    ])
  })

  test('重复路径去重，缺失名称时回退到路径末段', () => {
    const dataTransfer = createDataTransfer()
    setFileReferenceDragData(dataTransfer, [
      { path: '/ws/a.ts' } as FileReferenceDragItem,
      { path: '/ws/a.ts', name: 'a.ts' },
      { path: '  ', name: 'blank' },
    ])

    expect(getFileReferenceDragData(dataTransfer)).toEqual([{ path: '/ws/a.ts', name: 'a.ts' }])
  })

  test('非本协议或载荷损坏时返回 null', () => {
    const empty = createDataTransfer()
    expect(isFileReferenceDrag(empty)).toBe(false)
    expect(getFileReferenceDragData(empty)).toBeNull()

    const broken = createDataTransfer()
    broken.setData(FILE_REFERENCE_DRAG_MIME, '{"not":"an array"}')
    expect(getFileReferenceDragData(broken)).toBeNull()

    const invalidJson = createDataTransfer()
    invalidJson.setData(FILE_REFERENCE_DRAG_MIME, '@file:/ws/a.ts')
    expect(getFileReferenceDragData(invalidJson)).toBeNull()
  })
})

describe('文件引用路径换算', () => {
  test('工作区内的绝对路径转相对路径，分隔符统一成 /', () => {
    expect(toFileReferenceMentionPath('/ws/src/app.ts', '/ws')).toBe('src/app.ts')
    expect(toFileReferenceMentionPath('/ws/src/app.ts', '/ws/')).toBe('src/app.ts')
    expect(toFileReferenceMentionPath('C:\\ws\\src\\app.ts', 'C:\\ws')).toBe('src/app.ts')
  })

  test('工作区外与工作区根自身保留绝对路径', () => {
    expect(toFileReferenceMentionPath('/elsewhere/app.ts', '/ws')).toBe('/elsewhere/app.ts')
    expect(toFileReferenceMentionPath('/ws', '/ws')).toBe('/ws')
    expect(toFileReferenceMentionPath('/ws-other/app.ts', '/ws')).toBe('/ws-other/app.ts')
  })

  test('没有工作区路径时原样返回', () => {
    expect(toFileReferenceMentionPath('/ws/src/app.ts', null)).toBe('/ws/src/app.ts')
    expect(toFileReferenceMentionPath('/ws/src/app.ts', '')).toBe('/ws/src/app.ts')
  })

  test('换算后按 mention 路径去重', () => {
    expect(toFileReferenceMentions([
      { path: '/ws/src/app.ts', name: 'app.ts' },
      { path: '/ws/src/app.ts', name: 'app.ts' },
    ], '/ws')).toEqual([{ path: 'src/app.ts', name: 'app.ts' }])
  })
})
