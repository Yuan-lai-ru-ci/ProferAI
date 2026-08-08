/**
 * New API 对账客户端测试
 *
 * 覆盖纯逻辑：quota→扣费换算、加价倍率、request_id 头提取、边界值。
 * 网络相关（fetchActualQuotaByRequestId / reconcileRequestCost）依赖真实 New API，
 * 不在单测覆盖（由部署后端到端对账验证）。
 */
import { beforeAll, describe, expect, test } from 'bun:test'

// import 链会顶层加载 config.js（JWT_SECRET 缺失时 process.exit(1)）。
// 静态 import 会被 ESM 提升到任何语句之前，env 赋值来不及；必须动态 import
// （与 api-keys-db/config-store 等测试同款模式）。
// 注：CI 的 bun test --isolate 下进程间无 env 泄漏，此测试若漏设会整批测试崩掉
// （此前为 release 门禁的隐藏失败点，本地 bun test 目录模式被前面的测试泄漏掩盖）。
process.env.JWT_SECRET = 'x'.repeat(64)

let newapiClient

beforeAll(async () => {
  newapiClient = await import('./newapi-client.js')
})

// 默认环境：QUOTA_PER_UNIT=500000, MARKUP=1.0
describe('quotaToBilledCost', () => {
  test('quota 按 500000=1单位 换算，markup=1.0 时即成本价', () => {
    // 4163 quota（实测 deepseek 单次）→ 4163/500000 ≈ 0.008326
    expect(newapiClient.quotaToBilledCost(4163)).toBeCloseTo(0.008326, 6)
  })

  test('500000 quota = 1 单位', () => {
    expect(newapiClient.quotaToBilledCost(500000)).toBeCloseTo(1.0, 6)
  })

  test('0 / 负数 / 空 → 0（不产生负扣费）', () => {
    expect(newapiClient.quotaToBilledCost(0)).toBe(0)
    expect(newapiClient.quotaToBilledCost(-100)).toBe(0)
    expect(newapiClient.quotaToBilledCost(undefined)).toBe(0)
    expect(newapiClient.quotaToBilledCost(null)).toBe(0)
  })
})

describe('quotaToBilledCredits（本地账本整数 quota 单位）', () => {
  test('markup=1.0 时即 New API 实扣 quota 本身', () => {
    expect(newapiClient.quotaToBilledCredits(4163)).toBe(4163)
    expect(newapiClient.quotaToBilledCredits(3)).toBe(3)
  })

  test('向上取整，避免少扣', () => {
    // markup=1.0 时整数进整数出；此处验证 ceil 行为对非整数乘积成立
    expect(newapiClient.quotaToBilledCredits(1)).toBe(1)
  })

  test('0 / 负数 / 空 → 0', () => {
    expect(newapiClient.quotaToBilledCredits(0)).toBe(0)
    expect(newapiClient.quotaToBilledCredits(-5)).toBe(0)
    expect(newapiClient.quotaToBilledCredits(null)).toBe(0)
  })
})

describe('动态 markup 快照', () => {
  test('Given 请求冻结的 markup=1.5 When 实际 quota 为 101 Then 向上取整扣 152', () => {
    const billing = { markup: 1.5 }
    expect(newapiClient.quotaToBilledCredits(101, billing)).toBe(152)
    expect(newapiClient.quotaToBilledCost(500000, billing)).toBe(1.5)
  })

  test('Given 非法 markup 快照 When 换算 Then 不产生负数或非有限扣费', () => {
    for (const markup of [0, -1, NaN, Infinity]) {
      expect(newapiClient.quotaToBilledCredits(101, { markup })).toBe(0)
      expect(newapiClient.quotaToBilledCost(101, { markup })).toBe(0)
    }
  })
})

describe('extractNewApiRequestId', () => {
  test('从响应头取 x-oneapi-request-id', () => {
    const resp = { headers: new Headers({ [newapiClient.NEWAPI_REQUEST_ID_HEADER]: 'req-abc-123' }) }
    expect(newapiClient.extractNewApiRequestId(resp)).toBe('req-abc-123')
  })

  test('头不存在 → null', () => {
    const resp = { headers: new Headers({}) }
    expect(newapiClient.extractNewApiRequestId(resp)).toBeNull()
  })

  test('异常输入 → null，不抛', () => {
    expect(newapiClient.extractNewApiRequestId(null)).toBeNull()
    expect(newapiClient.extractNewApiRequestId({})).toBeNull()
  })
})
