import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const calls: string[] = []
const fixture = {
  importing: false, importPreview: null, pathMappings: {}, workspaceMappings: [],
  conflictResolution: 'overwrite', hasConflicts: false, importConfirming: false,
  importResult: null, isV2: false, requiresPassphrase: true,
  passphrase: ' secret ', passphraseError: '口令错误',
  setPassphrase: (value: string) => calls.push(value),
  submitPassphrase: () => calls.push('submit'), cancelPassphrase() {},
  handleSelectImportFile() {}, handleConfirmImport() {}, handlePathMapping() {},
  handleWorkspaceMapping() {}, setConflictResolution() {}, reset() {},
}
mock.module('@/hooks/useMigrationImport', () => ({ useMigrationImport: () => fixture }))
mock.module('jotai', () => ({ atom: (value: unknown) => value, useAtom: () => [true, () => {}], useAtomValue: () => [], useSetAtom: () => () => {} }))
mock.module('@/atoms/migration-atoms', () => ({ migrationImportDialogOpenAtom: {}, migrationImportInitialFilePathAtom: {} }))
mock.module('@/atoms/agent-atoms', () => ({ agentWorkspacesAtom: {} }))
// 仅替换 portal 外壳，真实表单、Input/Label/Button 和 React useId 参与渲染。
const Slot = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
mock.module('@profer/ui/primitives/dialog', () => ({ Dialog: Slot, DialogContent: Slot, DialogHeader: Slot, DialogTitle: Slot, DialogDescription: Slot }))
const { MigrationImportDialog } = await import('./MigrationImportDialog')

describe('导入口令表单', () => {
  test('Given 口令错误 When 渲染 Then 标签和错误关联真实输入且不修改口令', () => {
    const html = renderToStaticMarkup(<MigrationImportDialog />)
    const input = html.match(/<input[^>]*>/)?.[0] ?? ''
    const id = input.match(/ id="([^"]+)"/)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`for="${id}"`)
    expect(input).toContain('aria-invalid="true"')
    expect(input).toContain(`aria-describedby="${id}-error"`)
    expect(html).toContain(`id="${id}-error" role="alert"`)
    expect(input).toContain('value=" secret "')
    expect(html).toContain('解密并解析')
  })
  test('Given 正在解密 When 渲染 Then 输入和解密/返回按钮禁用', () => {
    fixture.importing = true
    const html = renderToStaticMarkup(<MigrationImportDialog />)
    expect(html.match(/<input[^>]*>/)?.[0]).toContain('disabled=""')
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2)
    expect(html).toContain('解密中...')
    fixture.importing = false
  })
})
