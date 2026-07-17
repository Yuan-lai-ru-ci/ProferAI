/**
 * 请求日志 SQL 工具测试
 *
 * 确保 request_logs 插入语句的列数、占位符和值顺序保持一致。
 */
import { describe, expect, test } from 'bun:test'
import { REQUEST_LOG_COLUMNS, buildRequestLogInsertSql, buildRequestLogValues } from './request-log-utils.js'

describe('request log SQL', () => {
  test('插入 SQL 的占位符数量和列数量一致', () => {
    const sql = buildRequestLogInsertSql()
    const placeholderCount = (sql.match(/\?/g) || []).length

    expect(REQUEST_LOG_COLUMNS).toHaveLength(16)
    expect(placeholderCount).toBe(REQUEST_LOG_COLUMNS.length)
  })

  test('构造的值数量和列数量一致，并规范化布尔/数字字段', () => {
    const values = buildRequestLogValues({
      id: 'req-1',
      userId: 'user-1',
      model: 'gpt-5-mini',
      provider: 'openai',
      promptTokens: '12',
      completionTokens: undefined,
      totalTokens: 'bad-number',
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
      costCredits: 9,
      durationMs: 123,
      success: true,
      stream: false,
      errorMessage: '',
      newApiRequestId: 'napi-123',
    }, 1000)

    expect(values).toHaveLength(REQUEST_LOG_COLUMNS.length)
    expect(values[4]).toBe(12)
    expect(values[5]).toBe(0)
    expect(values[6]).toBe(0)
    expect(values[11]).toBe(1)
    expect(values[12]).toBe(0)
    expect(values[14]).toBe(1000)
    expect(values[15]).toBe('napi-123')
  })
})
