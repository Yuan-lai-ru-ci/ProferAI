import { expect, test } from 'bun:test'
import { windowsOwnerBuildPlan, verifyOwnerBinary, assertOwnerProtocol } from './windows-owner-build'

test('Given Windows x64 When planning Then use absolute Framework64 compiler and explicit x64', () => {
  const plan = windowsOwnerBuildPlan('C:\\Windows', 'x64', 'C:\\build')
  expect(plan.compiler).toBe('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe')
  expect(plan.args).toContain('/platform:x64')
  expect(plan.args).toContain('/reference:System.Web.Extensions.dll')
  expect(() => windowsOwnerBuildPlan('Windows', 'x64', 'C:\\build')).toThrow('绝对')
  expect(() => windowsOwnerBuildPlan('C:\\Windows', 'arm64', 'C:\\build')).toThrow('arm64')
})
test('Given protocol probe failure, empty output or wrong version Then reject', () => {
  for (const result of [{ status: 0, stdout: '' }, { status: 0, stdout: 'profer-core-owner/2' }, { status: 1, stdout: 'profer-core-owner/1' }, { status: null, stdout: '', error: new Error('ENOEXEC') }]) expect(() => assertOwnerProtocol(result)).toThrow('协议')
  expect(() => assertOwnerProtocol({ status: 0, stdout: 'profer-core-owner/1\r\n' })).not.toThrow()
})

test('Given malformed or wrong-architecture helper Then reject before executing', () => {
  expect(() => verifyOwnerBinary(Buffer.alloc(0))).toThrow('PE')
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0xaa64, 68)
  expect(() => verifyOwnerBinary(pe)).toThrow('x64')
  pe.writeUInt16LE(0x8664, 68)
  expect(() => verifyOwnerBinary(pe)).not.toThrow()
})
