import { describe, expect, test } from 'bun:test'
import { describeFeishuTokenFailure } from './feishu-token-error'

describe('describeFeishuTokenFailure', () => {
  test('Given 21001 平台策略拒绝 When 诊断 Then 给出可操作提示', () => {
    const message = 'Failed to get tenant_access_token, code: 21001, msg: Access denied due to platform policy.'

    const hint = describeFeishuTokenFailure(new Error(message))

    expect(hint).toContain('21001')
    expect(hint).toContain('豆包账号')
    expect(hint).toContain('IP 白名单')
  })

  test('Given 凭证错误（10014）When 诊断 Then 不误报成平台策略拦截', () => {
    expect(describeFeishuTokenFailure(new Error('code: 10014, msg: app unauthorized'))).toBeUndefined()
  })

  test('Given 普通网络错误 When 诊断 Then 返回 undefined', () => {
    expect(describeFeishuTokenFailure(new Error('ECONNRESET'))).toBeUndefined()
  })
})
