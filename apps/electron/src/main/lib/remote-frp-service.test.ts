import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { create as createTar } from 'tar'
import { parse } from 'smol-toml'
const root = mkdtempSync(join(tmpdir(), 'profer-frp-test-'))
const app = new EventEmitter() as EventEmitter & { getPath(name: string): string }
app.getPath = () => root
let encryption = true
let clipboardText = ''
mock.module('electron', () => ({ app, dialog: { showSaveDialog: async () => ({ canceled: true }) }, clipboard: { writeText: (value: string) => { clipboardText = value } }, safeStorage: { isEncryptionAvailable: () => encryption, getSelectedStorageBackend: () => 'test', encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() } }))
const electronMock = await import('electron')
Object.assign(electronMock.app, { getPath: () => root, once: app.once.bind(app) })
Object.assign(electronMock.safeStorage, { isEncryptionAvailable: () => encryption, getSelectedStorageBackend: () => 'test', encryptString: (s: string) => Buffer.from(s).reverse(), decryptString: (b: Buffer) => Buffer.from(b).reverse().toString() })
Object.assign(electronMock.clipboard, { writeText: (value: string) => { clipboardText = value } })
mock.module('./config-paths', () => ({ getConfigDir: () => root }))
class FakeChild extends EventEmitter { pid = 1; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; stdout = new EventEmitter(); stderr = new EventEmitter(); killed = false; kill(): boolean { this.killed = true; setTimeout(() => { this.exitCode = 0; this.emit('exit', 0) }, 20); return true } }
const children: FakeChild[] = []
let version = '0.71.0'; let architectureFailure = false
mock.module('node:child_process', () => ({
  spawn: (binary: string, args: string[], options: { shell: boolean }) => { expect(binary).toContain(root); expect(args[0]).toBe('-c'); expect(options.shell).toBe(false); const c = new FakeChild(); children.push(c); queueMicrotask(() => c.emit('spawn')); return c },
  execFile: (_binary: string, args: string[], options: { shell: boolean }, cb: (error: Error | null, stdout: string) => void) => { expect(args).toEqual(['--version']); expect(options.shell).toBe(false); cb(architectureFailure ? new Error('wrong architecture') : null, version) },
}))
const { loadRemoteToken, protectSecret, revealSecret, pairDevice, authenticateRemote, refreshPairing, getConnectionProfile, revokeBinding, lanEndpoints } = await import('./remote-identity')
const { FrpControlStore } = await import('./remote-frp-control-identity')
const { installFrp, saveFrpConfig, startFrp, stopFrp, getFrpStatus, getFrpConfig, extractFrpc, rollbackFrp, generateFrpMaterial, regenerateFrpMaterial, exportFrpDeployment, copyFrpDeploymentInstructions, getFrpDeploymentInstructions } = await import('./remote-frp-service')
const { selectFrpAsset } = await import('./remote-frp-core')
const config = { serverAddr: 'frp.example.com', serverPort: 7000, remotePort: 17788, authToken: 'FRP_TEST_SECRET', publicUrl: 'wss://remote.example.com/ws', startOnLaunch: false, serverVersion: '0.71.0', trustedCaFile: join(root, 'test-ca.crt') }
writeFileSync(join(root, 'test-ca.crt'), 'synthetic test CA\n')
const originalFetch = globalThis.fetch
let interrupt = false; let corrupt = false
/** 安装走 selectFrpAsset 的宿主平台分支：Windows 取 zip，其它平台取 tar.gz。 */
const hostOs = ({ win32: 'windows', darwin: 'darwin', linux: 'linux' } as Record<string, string>)[process.platform]
const hostCpu = ({ x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' } as Record<string, string>)[process.arch]
function archive(version: string): Buffer {
  const root = `frp_${version}_${hostOs}_${hostCpu}`
  if (hostOs === 'windows') { const zip = new AdmZip(); zip.addFile(`${root}/frpc.exe`, Buffer.from('mock executable')); return zip.toBuffer() }
  const work = mkdtempSync(join(tmpdir(), 'frp-archive-'))
  try {
    mkdirSync(join(work, root)); writeFileSync(join(work, root, 'frpc'), 'mock executable')
    const out = join(work, 'archive.tar.gz'); createTar({ gzip: true, file: out, cwd: work, sync: true }, [root])
    return readFileSync(out)
  } finally { rmSync(work, { recursive: true, force: true }) }
}
let linuxDigest = true
function releaseAssets(v: string, data: Buffer) {
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const asset = (name: string) => ({ name: `frp_${v}_${name}`, browser_download_url: `https://github.com/fatedier/frp/releases/download/v${v}/frp_${v}_${name}`, digest, size: data.length })
  // linux 归档摘要供“一条命令自举”部署指令使用；linuxDigest=false 模拟官方未提供摘要 → 导出必须 fail closed
  const hostAsset = `${hostOs}_${hostCpu}.${hostOs === 'windows' ? 'zip' : 'tar.gz'}`
  const names = [...new Set([hostAsset, ...(linuxDigest ? ['linux_amd64.tar.gz', 'linux_arm64.tar.gz', 'linux_arm.tar.gz'] : [])])]
  return names.map(asset)
}
globalThis.fetch = (async (url: string | URL | Request) => {
  const value = String(url); const v = value.match(/v(0\.\d+\.\d+)/)?.[1] ?? version; const data = archive(v)
  if (value.includes('api.github.com')) return Response.json({ tag_name: `v${v}`, draft: false, prerelease: false, assets: releaseAssets(v, data) })
  if (interrupt) throw new Error('interrupted')
  return new Response(Uint8Array.from(corrupt ? Buffer.from('corrupt') : data))
}) as typeof fetch
afterAll(async () => { await stopFrp(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }) })
describe('desktop protected identity and install failure injection', () => {
  test('input-only draft, Profer-generated token/CA, start gate, idempotent regeneration and retained token', async () => {
    const empty = { ...config, serverAddr: '', publicUrl: '', authToken: '', trustedCaFile: '', publicMode: 'pinned' as const }
    const saved = await saveFrpConfig(empty, 'REMOTE_TEST_SECRET')
    expect(saved.running).toBe(false); expect(saved.tokenConfigured).toBe(false); expect(saved.readiness).toBe('draft')
    expect(saved.missing).toEqual(['服务器公网 IP/地址'])
    await expect(startFrp(7788)).rejects.toThrow('请先填写'); expect(children).toHaveLength(0)
    // 只填 IP 与端口：独立 Token、控制 CA 与 server 证书由 Profer 生成，无需手工输入
    await saveFrpConfig({ ...empty, serverAddr: '192.0.2.1' }, null)
    const generated = await generateFrpMaterial()
    expect(generated.tokenConfigured).toBe(true); expect(generated.generated?.controlCa).toBe(true); expect(generated.readiness).toBe('tunnel_ready')
    const ready = getFrpConfig()!
    expect(ready.authToken).toMatch(/^[a-f0-9]{64}$/)
    expect(ready.trustedCaFile).toBe(join(root, 'remote-frp', 'control', 'ca.crt'))
    expect(existsSync(ready.trustedCaFile)).toBe(true)
    const controlFile = join(root, 'remote-frp', 'control', 'control.json')
    const rawControl = readFileSync(controlFile, 'utf8')
    expect(rawControl).not.toContain('PRIVATE KEY')
    // 重复生成幂等：不静默更换 Token、CA 或 server 私钥
    await generateFrpMaterial()
    expect(getFrpConfig()!.authToken).toBe(ready.authToken)
    expect(readFileSync(controlFile, 'utf8')).toBe(rawControl)
    // 未安装 frpc 时启动仍拒绝（材料已自动就绪，不再报“缺 CA/Token”）
    await expect(startFrp(7788)).rejects.toThrow('安装'); expect(children).toHaveLength(0)
    // 已生成 Token 在输入留空时保留；控制 CA 路径不接受 renderer 覆盖
    await saveFrpConfig({ ...empty, serverAddr: '192.0.2.1', authToken: '', trustedCaFile: '/tmp/attacker-ca.crt' }, null)
    expect(getFrpStatus().tokenConfigured).toBe(true); expect(getFrpConfig()!.authToken).toBe(ready.authToken)
    expect(getFrpConfig()!.trustedCaFile).toBe(join(root, 'remote-frp', 'control', 'ca.crt'))
    await expect(saveFrpConfig({ ...empty, serverAddr: 'bad:host' }, null)).rejects.toThrow('地址')
    expect(children).toHaveLength(0)
  })
  test('damaged control identity fails closed instead of silently replacing; explicit regenerate recovers', async () => {
    const caFile = join(root, 'remote-frp', 'control', 'ca.crt')
    const before = readFileSync(caFile, 'utf8')
    writeFileSync(caFile, 'not-a-cert')
    await expect(startFrp(7788)).rejects.toThrow('重新生成'); expect(children).toHaveLength(0)
    writeFileSync(caFile, before)
    rmSync(join(root, 'remote-frp', 'control', 'control.json'))
    // 幂等“生成配置”不能绕过 fail closed；只有显式“重新生成材料”可恢复。
    await expect(generateFrpMaterial()).rejects.toThrow('缺失')
    await expect(startFrp(7788)).rejects.toThrow('缺失'); expect(children).toHaveLength(0)
    const recovered = await regenerateFrpMaterial()
    expect(recovered.generated?.controlCa).toBe(true)
    expect(readFileSync(caFile, 'utf8')).not.toBe(before)
    expect(caFile).toBe(getFrpConfig()!.trustedCaFile)
  })
  test('deployment instruction and zip are equivalent, TOML-parseable and carry real generated secrets', async () => {
    const electronMock = await import('electron')
    const zipPath = join(root, 'deploy.zip')
    Object.assign(electronMock.dialog, { showSaveDialog: async () => ({ canceled: false, filePath: zipPath }) })
    expect(await exportFrpDeployment()).toBe(zipPath)
    const entries: Record<string, string> = {}
    for (const entry of new AdmZip(zipPath).getEntries()) entries[entry.entryName] = entry.getData().toString('utf8')
    const ready = getFrpConfig()!
    expect(parse(entries['frps.toml']!).auth).toEqual({ method: 'token', token: ready.authToken })
    expect(entries['ca.crt']).toBe(readFileSync(ready.trustedCaFile, 'utf8'))
    expect(Object.values(entries).join('')).toContain(ready.authToken)
    expect(entries['deploy.sh']).toContain(ready.authToken)
    expect(entries['deploy.sh']).toContain('PROFER_FRPS_TOML')
    expect(entries['frps.service']).toContain('User=frp')
    // 一条命令自举：脚本自带官方 linux 归档摘要与架构表，不再要求预装 frps 二进制
    expect(entries['deploy.sh']).not.toContain('请先核验官方 SHA256')
    expect(entries['deploy.sh']).toContain('frp_0.71.0_linux_amd64.tar.gz')
    expect(entries['deploy.sh']).toContain('curl -fL --retry 3')
    expect(entries['README.md']).toContain('不需要你预先准备 frps 二进制')
    const copied = await copyFrpDeploymentInstructions()
    const deployScript = entries['deploy.sh']!
    expect(clipboardText).toBe(deployScript)
    expect(copied).toContain(deployScript.split('\n').length.toString())
    // zip 与剪贴板携带的是 Profer 真实生成的托管材料，而不是占位符；桌面 TLS 应用私钥不经此路径。
    const material = new FrpControlStore(join(root, 'remote-frp', 'control'), protectSecret, revealSecret).load()!
    expect(entries['ca.crt']).toBe(material.caCert)
    expect(entries['server.crt']).toBe(material.serverCert)
    expect(entries['ca.key']).toBe(material.caKey)
    expect(entries['server.key']).toBe(material.serverKey)
    expect(entries['server.crt']).not.toContain('Profer Remote')
  })
  test('deployment export fails closed when the official release exposes no linux digest', async () => {
    linuxDigest = false
    try {
      await expect(getFrpDeploymentInstructions()).rejects.toThrow('未提供可校验')
      await expect(exportFrpDeployment()).rejects.toThrow('未提供可校验')
    } finally { linuxDigest = true }
    expect(await getFrpDeploymentInstructions()).toContain('expected=')
  })
  test('safeStorage unavailable fails closed; legacy migration encrypted, stable device/revocation', () => {
    writeFileSync(join(root, 'remote-token.json'), JSON.stringify({ token: 'LEGACY_TEST_SECRET' }))
    encryption = false; expect(() => loadRemoteToken()).toThrow('不可用'); expect(readFileSync(join(root, 'remote-token.json'), 'utf8')).toContain('LEGACY_TEST_SECRET')
    encryption = true; expect(loadRemoteToken()).toBe('LEGACY_TEST_SECRET'); expect(readFileSync(join(root, 'remote-token.json'), 'utf8')).not.toContain('LEGACY_TEST_SECRET'); expect(protectSecret('SECRET')).not.toContain('SECRET')
    const p = getConnectionProfile(7788); expect(getConnectionProfile(7789).deviceId).toBe(p.deviceId)
    const qr = refreshPairing(p); const result = pairDevice(qr.pairingCode, 'peer', 'Pocket'); expect(authenticateRemote(result.credential, null)).toBe(result.bindingId); revokeBinding(result.bindingId); expect(authenticateRemote(result.credential, null)).toBeNull()
    expect(readFileSync(join(root, 'remote-identity.json'), 'utf8')).not.toContain(result.credential)
  })
  test('multi NIC filters internal/linklocal/public, deduplicates and stable ordering', () => {
    const net = (address: string, internal = false) => ({ address, internal, family: 'IPv4' as const, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null })
    expect(lanEndpoints({ b: [net('192.168.1.2'), net('10.0.0.2')], a: [net('192.168.1.2'), net('127.0.0.1', true), net('169.254.1.2'), net('8.8.8.8')] }, 7788).map((e) => e.url)).toEqual(['ws://10.0.0.2:7788/ws', 'ws://192.168.1.2:7788/ws'])
  })
  test('safe install, interruption/hash/architecture/version failure leaves old pointer', async () => {
    await saveFrpConfig(config, 'REMOTE_TEST_SECRET'); await installFrp(version); const path = join(root, 'remote-frp', 'current.json'); const original = readFileSync(path, 'utf8'); expect(getFrpStatus().installedVersion).toBe(version)
    expect(readFileSync(join(root, 'remote-frp', 'config.json'), 'utf8')).not.toContain(config.authToken)
    interrupt = true; await expect(installFrp(version)).rejects.toThrow(); interrupt = false; expect(readFileSync(path, 'utf8')).toBe(original)
    corrupt = true; await expect(installFrp(version)).rejects.toThrow(); corrupt = false; expect(readFileSync(path, 'utf8')).toBe(original)
    architectureFailure = true; await expect(installFrp(version)).rejects.toThrow('架构'); architectureFailure = false
    version = '0.70.0'; await expect(installFrp('0.71.0')).rejects.toThrow('版本'); version = '0.71.0'; expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readdirSync(join(root, 'remote-frp')).some((p) => p.startsWith('download-'))).toBe(false)
    await expect(saveFrpConfig({ ...config, authToken: 'REMOTE_TEST_SECRET' }, 'REMOTE_TEST_SECRET')).rejects.toThrow('复用')
  })
  test('malicious/missing archive is rejected before installation', async () => {
    const asset = selectFrpAsset({ tag_name: 'v0.71.0', draft: false, prerelease: false, assets: [{ name: 'frp_0.71.0_windows_amd64.zip', browser_download_url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_windows_amd64.zip', digest: `sha256:${'0'.repeat(64)}`, size: 1 }] }, 'win32', 'x64')
    const zip = new AdmZip(); zip.addFile('../escape', Buffer.from('bad')); await expect(extractFrpc(zip.toBuffer(), asset, join(root, 'unused'))).rejects.toThrow()
    const empty = new AdmZip(); empty.addFile('readme', Buffer.from('no executable')); await expect(extractFrpc(empty.toBuffer(), asset, join(root, 'unused'))).rejects.toThrow('缺少')
    expect(existsSync(join(root, 'escape'))).toBe(false)
  })
  test('rapid owned start/stop and port replacement wait for delayed exit', async () => {
    await startFrp(7788); const old = children.at(-1)!; const count = children.length
    const stopped = stopFrp(); const restarted = startFrp(7790)
    await Bun.sleep(5); expect(children.length).toBe(count); expect(old.exitCode).toBeNull()
    await stopped; await restarted; expect(old.exitCode).toBe(0); expect(children.length).toBe(count + 1)
    expect(readFileSync(join(root, 'remote-frp', 'frpc.toml'), 'utf8')).toContain('localPort = 7790')
    const launched = startFrp(7791); const finalStop = stopFrp(); await launched; await finalStop; expect(getFrpStatus().running).toBe(false)
  })
  test('rollback swaps retained versions; owned process args, redaction and exit cleanup', async () => {
    const dir = join(root, 'remote-frp'); const oldBinary = join(dir, 'old-frpc.exe'); writeFileSync(oldBinary, 'old')
    const current = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')) as { version: string; binary: string }; writeFileSync(join(dir, 'current.json'), JSON.stringify({ ...current, previous: { version: '0.70.0', binary: oldBinary } }))
    expect((await rollbackFrp()).installedVersion).toBe('0.70.0'); expect((await rollbackFrp()).installedVersion).toBe('0.71.0')
    await startFrp(7788); await Promise.resolve(); const c = children.at(-1)!; expect(getFrpStatus().running).toBe(true); c.stdout.emit('data', config.authToken); expect(JSON.stringify(getFrpStatus())).not.toContain(config.authToken)
    await stopFrp(); expect(c.killed).toBe(true); expect(getFrpStatus().running).toBe(false)
    await startFrp(7789); await Promise.resolve(); expect(readFileSync(join(dir, 'frpc.toml'), 'utf8')).toContain('localPort = 7789'); app.emit('before-quit'); await stopFrp(); expect(children.at(-1)?.killed).toBe(true)
  })
})
