import { expect, test } from 'bun:test'
import { isIndependentLocalCore, isLocalCoreEnabled } from './core-local-mode'

const previous = process.env.PROFER_LOCAL_CORE_MODE
function mode(value: string | undefined, check: () => void): void {
  if (value === undefined) delete process.env.PROFER_LOCAL_CORE_MODE
  else process.env.PROFER_LOCAL_CORE_MODE = value
  try { check() } finally {
    if (previous === undefined) delete process.env.PROFER_LOCAL_CORE_MODE
    else process.env.PROFER_LOCAL_CORE_MODE = previous
  }
}

test('本机默认新核，旧启用记录和历史环境开关不改变默认路径', () => {
  mode(undefined, () => {
    expect(isLocalCoreEnabled()).toBe(true)
    expect(isIndependentLocalCore()).toBe(false)
  })
})

test('仅显式 legacy 启动模式保留旧核兜底，独立模式仍按原契约选择', () => {
  mode('legacy', () => {
    expect(isLocalCoreEnabled()).toBe(false)
    expect(isIndependentLocalCore()).toBe(false)
  })
  mode('independent', () => {
    expect(isLocalCoreEnabled()).toBe(true)
    expect(isIndependentLocalCore()).toBe(true)
  })
  mode('unknown', () => expect(isLocalCoreEnabled()).toBe(true))
})
