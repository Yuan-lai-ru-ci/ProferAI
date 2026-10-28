import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteTlsStore, validateTlsIdentity } from './remote-tls-identity'
import { validateFrpDraft, validateFrpConfig, frpMissing, frpMaterialMissing, pinnedPublicUrl, deploymentFiles, renderDeploymentInstructions, renderDeploymentScript, selectFrpServerAssets, type FrpConfig, type FrpDeploymentMaterial, type FrpRelease, type FrpServerAsset } from './remote-frp-core'
import { parseRemoteProfile, assertProfileTrustUnchanged, type RemoteProfile } from '@profer/shared'
import { spawnSync } from 'node:child_process'
import { parse } from 'smol-toml'
const protect = (value: string): string => Buffer.from(value).reverse().toString('base64')
const reveal = (value: string): string => Buffer.from(value, 'base64').reverse().toString()
const deploymentMaterial: FrpDeploymentMaterial = { caCert: '-----BEGIN CERTIFICATE-----\nCA_BODY\n-----END CERTIFICATE-----\n', caKey: '-----BEGIN PRIVATE KEY-----\nCA_KEY_BODY\n-----END PRIVATE KEY-----\n', serverCert: 'SRV_CERT', serverKey: 'SRV_KEY' }
const pinnedConfig = (serverAddr: string): FrpConfig => ({ serverAddr, serverPort: 7000, remotePort: 17788, authToken: 'REAL_GENERATED_TOKEN_0123456789', publicUrl: '', trustedCaFile: '/user-data/remote-frp/control/ca.crt', publicMode: 'pinned', startOnLaunch: false, serverVersion: '0.71.0' })
const serverAssets: FrpServerAsset[] = [
  { arch: 'amd64', name: 'frp_0.71.0_linux_amd64.tar.gz', url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_amd64.tar.gz', sha256: 'a'.repeat(64) },
  { arch: 'arm64', name: 'frp_0.71.0_linux_arm64.tar.gz', url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_arm64.tar.gz', sha256: 'b'.repeat(64) },
  { arch: 'arm', name: 'frp_0.71.0_linux_arm.tar.gz', url: 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_arm.tar.gz', sha256: 'c'.repeat(64) },
]
const emptyRelease = (assets: FrpRelease['assets']): FrpRelease => ({ tag_name: 'v0.71.0', draft: false, prerelease: false, assets })
const officialAsset = (arch: string, digestChar: string, digest = `sha256:${digestChar.repeat(64)}`) => ({ name: `frp_0.71.0_linux_${arch}.tar.gz`, browser_download_url: `https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_linux_${arch}.tar.gz`, digest, size: 1024 })
/** 测试环境可用的 POSIX shell；不存在的环境直接跳过 shell 行为验证，不用硬编码路径宣称通过。 */
function availableShell(): string | null {
  for (const candidate of [process.env.PROFER_TEST_SHELL, 'C:/Users/Administrator/PortableGit/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe']) {
    if (candidate && existsSync(candidate)) return candidate
  }
  for (const name of ['bash', 'sh']) {
    // 返回绝对路径：空 PATH 的用例仍要能启动同一个 shell，而不是被 PATH 查找挡住。
    const resolved = Bun.which(name)
    if (resolved && !spawnSync(resolved, ['-c', 'exit 0'], { shell: false }).error) return resolved
  }
  return null
}
test('TLS identity persists encrypted key and stable pin, IP SAN changes retain key; damage/missing/rotation fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-tls-identity-'))
  try {
    const store = new RemoteTlsStore(dir, protect, reveal); const first = await store.ensure('192.0.2.1')
    expect(new RemoteTlsStore(dir, protect, reveal).load()?.pin).toEqual(first.pin)
    expect(readFileSync(join(dir, 'identity.json'), 'utf8')).not.toContain('PRIVATE KEY')
    const moved = await store.ensure('2001:db8::1'); expect(moved.pin).toEqual(first.pin); expect(moved.publicIp).toBe('2001:db8::1')
    const file = join(dir, 'identity.json'); const saved = readFileSync(file, 'utf8'); writeFileSync(file, '{bad')
    await expect(store.ensure('2001:db8::1')).rejects.toThrow('损坏')
    writeFileSync(file, saved); rmSync(file); await expect(store.ensure('2001:db8::1')).rejects.toThrow('缺失')
    const rotated = await store.ensure('2001:db8::1', true); expect(rotated.pin.value).not.toBe(first.pin.value)
    const bad = new RemoteTlsStore(dir, protect, () => first.key); expect(() => bad.load()).toThrow('损坏')
    if (process.platform !== 'win32') { chmodSync(file, 0o644); expect(() => store.load()).toThrow('权限') }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('expired and mismatched certificate never accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profer-tls-expired-'))
  try {
    const identity = await new RemoteTlsStore(dir, protect, reveal).ensure('192.0.2.1')
    expect(() => validateTlsIdentity(identity.cert, identity.key, '192.0.2.2')).toThrow()
    expect(() => validateTlsIdentity(identity.cert, identity.key, '192.0.2.1', Date.now() + 366 * 86400_000)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('draft saves inputs only: token and control CA are Profer-generated managed material, not user fields', () => {
  const base = { serverAddr: '', serverPort: 7000, remotePort: 17788, publicUrl: '', authToken: '', trustedCaFile: '', startOnLaunch: false, serverVersion: '0.71.0', publicMode: 'pinned' as const }
  expect(validateFrpDraft(base)).toEqual(base)
  // 用户唯一仍需填写的输入；Token 与 CA 属于 Profer 托管材料，不再是“用户未填”缺项。
  expect(frpMissing(base)).toEqual(['服务器公网 IP/地址'])
  expect(frpMaterialMissing(base)).toEqual(['独立 FRP Token（由 Profer 生成）', 'FRP 控制链路 CA（由 Profer 生成）'])
  expect(frpMissing({ ...base, serverAddr: '192.0.2.1' })).toEqual([])
  expect(() => validateFrpConfig(base)).toThrow('缺少')
  expect(() => validateFrpConfig({ ...base, serverAddr: '192.0.2.1' })).toThrow('由 Profer 生成')
  for (const [key, value] of Object.entries({ serverAddr: 'bad:host', serverPort: 1, remotePort: 70000, authToken: '\n', publicUrl: 'ws://example/ws', trustedCaFile: '\0' })) expect(() => validateFrpDraft({ ...base, [key]: value })).toThrow()
  expect(pinnedPublicUrl({ ...base, serverAddr: '192.0.2.1' })).toBe('wss://192.0.2.1:17788/ws')
  expect(pinnedPublicUrl({ ...base, serverAddr: '2001:db8::1' })).toBe('wss://[2001:db8::1]:17788/ws')
  expect(frpMissing({ ...base, publicMode: 'system', publicUrl: '' })).toContain('系统可信 WSS 地址')
})
test('deployment instruction and zip share one renderer: byte-equal, TOML-parseable and secret-bearing for IPv4/IPv6', () => {
  const material = deploymentMaterial
  const heredoc = (script: string, marker: string): string => {
    const open = `<<'${marker}'\n`
    const start = script.indexOf(open) + open.length
    return script.slice(start, script.indexOf(`\n${marker}\n`, start))
  }
  const shell = availableShell()
  for (const ip of ['192.0.2.1', '2001:db8::1']) {
    const config = pinnedConfig(ip)
    const files = deploymentFiles(config, material, serverAssets)
    // “复制部署指令”与 zip 内 deploy.sh 必须字节等价
    expect(renderDeploymentInstructions(config, material, serverAssets)).toBe(files['deploy.sh']!)
    const script = files['deploy.sh']!
    // 没有可用 POSIX shell 的环境跳过语法校验，不硬编码某个平台的路径
    if (shell) expect(spawnSync(shell, ['-n'], { input: script, encoding: 'utf8', shell: false }).status).toBe(0)
    // 指令包含真实生成秘密
    expect(heredoc(script, 'PROFER_FRPS_TOML')).toBe(files['frps.toml']!.trim())
    expect(heredoc(script, 'PROFER_CA_CRT')).toBe(material.caCert.trim())
    expect(heredoc(script, 'PROFER_SERVER_KEY')).toBe(material.serverKey.trim())
    expect(script).toContain('REAL_GENERATED_TOKEN_0123456789')
    expect(files['ca.key']).toBe(material.caKey)
    expect(files['server.key']).toBe(material.serverKey)
    expect(parse(heredoc(script, 'PROFER_FRPS_TOML')).auth).toEqual({ method: 'token', token: 'REAL_GENERATED_TOKEN_0123456789' })
    expect(files.Caddyfile).toBeUndefined()
    expect(files['README.md']).toContain('不要上传或贴进对话')
    expect(files['control-ca.sh']).toContain('可选')
    expect(script).toContain(`映射端口 ${config.remotePort}/TCP`)
  }
  expect(() => deploymentFiles({ serverAddr: "192.0.2.1'; echo bad", serverPort: 7000, remotePort: 17788, authToken: 'x', publicUrl: '', trustedCaFile: '/ca.crt', publicMode: 'pinned', startOnLaunch: false, serverVersion: '0.71.0' }, material, serverAssets)).toThrow('地址格式')
})
test('frps server digests come from official release assets only; missing or non-official fails closed', () => {
  const release = emptyRelease([officialAsset('amd64', 'a'), officialAsset('arm64', 'b'), officialAsset('arm', 'c')])
  expect(selectFrpServerAssets(release)).toEqual(serverAssets)
  // 官方未给 digest、digest 不是 sha256、或下载地址不是官方发布：该架构都不进入摘要表
  expect(() => selectFrpServerAssets(emptyRelease([{ ...officialAsset('amd64', 'a'), digest: undefined }, { ...officialAsset('arm64', 'b'), digest: 'sha512:zz' }]))).toThrow('未提供可校验')
  expect(() => selectFrpServerAssets(emptyRelease([{ ...officialAsset('amd64', 'a'), browser_download_url: 'https://evil.example/frp_0.71.0_linux_amd64.tar.gz' }]))).toThrow('未提供可校验')
  expect(() => selectFrpServerAssets({ ...release, prerelease: true })).toThrow('稳定版本')
  expect(selectFrpServerAssets(emptyRelease([officialAsset('amd64', 'a')]))).toHaveLength(1)
  // 摘要表缺少目标架构时，脚本在目标机上按架构拒绝安装，而不是退化为无校验安装
  const partial = renderDeploymentScript(pinnedConfig('192.0.2.1'), deploymentMaterial, [serverAssets[0]!])
  expect(partial).toContain('官方 Release 未提供 linux/$arch 的 SHA256 摘要，已拒绝安装')
  expect(partial).not.toContain('arm64) archive_name=')
  expect(() => renderDeploymentScript(pinnedConfig('192.0.2.1'), deploymentMaterial, [])).toThrow('摘要')
  expect(() => renderDeploymentScript(pinnedConfig('192.0.2.1'), deploymentMaterial, [{ ...serverAssets[0]!, sha256: 'not-hex' }])).toThrow('无效')
})
test('deploy.sh self-bootstraps: arch mapping, official digest check, idempotent rerun, firewall branches and failure hints', () => {
  const script = renderDeploymentScript(pinnedConfig('192.0.2.1'), deploymentMaterial, serverAssets)
  // 架构判定：uname -m → 官方归档（下错架构是最常见的失败）
  expect(script).toContain('machine=$(uname -m)')
  expect(script).toContain("x86_64|amd64) arch='amd64'")
  expect(script).toContain("aarch64|arm64) arch='arm64'")
  expect(script).toContain("armv7l|armv7|armhf) arch='arm'")
  for (const asset of serverAssets) expect(script).toContain(`${asset.arch}) archive_name='${asset.name}'; archive_url='${asset.url}'; expected='${asset.sha256}' ;;`)
  // 自举：不再要求预装 frps 二进制
  expect(script).not.toContain('把 frps 二进制安装到 /opt/frp/frps')
  expect(script).toContain('curl -fL --retry 3 --connect-timeout 20')
  expect(script).toContain('wget -O "$archive" "$archive_url"')
  expect(script).toContain('[ "$actual" != "$expected" ]')
  expect(script).toContain('已中止安装（不做无校验安装）')
  // 幂等
  expect(script).toContain('[ "$installed_version" = "$version" ]')
  expect(script).toContain('已安装 frps $version，跳过下载与校验（重复执行结果一致）。')
  expect(script).toContain('if ! id frp >/dev/null 2>&1; then')
  expect(script).toContain('systemctl enable frps >/dev/null 2>&1')
  expect(script).toContain('systemctl restart frps')
  // frp 用户必须真能执行 frps（关闭 QF-04）
  expect(script).toContain('chmod 755 "$install_dir/frps"')
  expect(script).toContain('su -s /bin/sh -c "test -x $install_dir/frps" frp')
  // 防火墙分支 + 手动放行 + 云安全组（只放行确实需要对外暴露的端口）
  expect(script).toContain("firewall_ports='7000 17788'")
  expect(script).toContain("ufw status 2>/dev/null | grep -q 'Status: active'")
  expect(script).toContain('for port in $firewall_ports; do ufw allow "$port/tcp"')
  expect(script).toContain('for port in $firewall_ports; do firewall-cmd --permanent --add-port="$port/tcp"')
  expect(script).toContain('firewall-cmd --reload')
  expect(script).toContain('未检测到可用的 ufw 或 firewalld；请手动放行端口：控制端口 7000/TCP 与映射端口 17788/TCP。')
  expect(script).toContain('云厂商安全组不会自动放行：请在云控制台的安全组里放行上述端口（尤其是映射端口）。')
  expect(script).toContain('映射端口 17788/TCP')
  // system 模式：映射端口只回环绑定，防火墙只放行控制端口与 443
  const systemScript = renderDeploymentScript({ ...pinnedConfig('frp.example.com'), publicUrl: 'wss://frp.example.com/ws', publicMode: 'system' }, deploymentMaterial, serverAssets)
  expect(systemScript).toContain("firewall_ports='7000 443'")
  expect(systemScript).not.toContain("firewall_ports='7000 17788'")
  expect(systemScript).toContain('请在云控制台的安全组里放行上述端口（控制端口与 443/TCP）。')
  // 失败提示与结尾诊断
  expect(script).toContain('缺少下载工具 curl 或 wget')
  expect(script).toContain('缺少 tar 解压工具')
  expect(script).toContain('缺少 SHA256 校验工具')
  expect(script).toContain('请确认服务器能访问 github.com')
  expect(script).toContain('控制端口 $server_port 已被其它进程监听')
  expect(script).toContain('frps 服务启动失败')
  expect(script).toContain('journalctl -u frps -n 10 --no-pager')
  expect(script).toContain('本指令不会关闭你的终端会话')
})
test('deploy.sh keeps every exit inside a subshell so guards cannot end the caller shell', () => {
  const script = renderDeploymentScript(pinnedConfig('192.0.2.1'), deploymentMaterial, serverAssets)
  const lines = script.trimEnd().split('\n')
  // 整个脚本是一个顶层子 shell，主体是子 shell 函数：任何 exit 都不会结束调用方（交互式）shell
  expect(script).toContain('profer_deploy_frps() (')
  expect(lines.at(-1)).toBe(')')
  const open = lines.indexOf('(')
  expect(open).toBeGreaterThan(0)
  const exits = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*exit\b/.test(line))
  expect(exits.length).toBeGreaterThan(0)
  for (const { index } of exits) expect(index).toBeGreaterThan(open)
  expect(lines.some((line) => /^\s*return\b/.test(line))).toBe(false)
})
test('deploy.sh under a real shell: syntax ok, sourcing or executing never kills the caller shell', () => {
  const shell = availableShell()
  if (!shell) return
  const script = renderDeploymentScript(pinnedConfig('192.0.2.1'), deploymentMaterial, serverAssets)
  const dir = mkdtempSync(join(tmpdir(), 'profer-deploy-guard-'))
  try {
    const file = join(dir, 'deploy.sh')
    writeFileSync(file, script)
    expect(spawnSync(shell, ['-n'], { input: script, encoding: 'utf8', shell: false }).status).toBe(0)
    // 空 PATH：连 `id` 都取不到 → 守卫失败；source 后父 shell 必须仍然存活
    const sourced = spawnSync(shell, ['-c', 'PATH=""; . "$1"; echo ALIVE', 'profer-test', file], { encoding: 'utf8', shell: false })
    expect(sourced.stdout).toContain('部署未完成')
    expect(sourced.stdout).toContain('ALIVE')
    // 直接执行：失败必须结束脚本自身并以非零退出码返回
    const executed = spawnSync(shell, ['-c', 'PATH=""; "$1" "$2"; echo "rc=$?"', 'profer-test', shell, file], { encoding: 'utf8', shell: false })
    expect(executed.stdout).toContain('部署未完成')
    expect(executed.stdout).toContain('rc=1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('strict v2 pin trust binding, v1 migration cannot import network pin', () => {
  const pin = { algorithm: 'spki-sha256' as const, value: `sha256/${Buffer.alloc(32, 1).toString('base64')}` }
  const p: RemoteProfile = { schemaVersion: 2, deviceId: 'desktop-123', deviceName: 'Desktop', updatedAt: 1, endpoints: [{ url: 'wss://192.0.2.1:17788/ws', scope: 'public', trustMode: 'pinned', pin }] }
  expect(parseRemoteProfile(p)).toEqual(p)
  for (const endpoint of [{ ...p.endpoints[0], pin: undefined }, { ...p.endpoints[0], pin: { ...pin, algorithm: 'cert' } }, { ...p.endpoints[0], pin: { ...pin, value: pin.value.replace(/=$/, 'A=') } }, { ...p.endpoints[0], trustMode: 'system' }]) expect(() => parseRemoteProfile({ ...p, endpoints: [endpoint] })).toThrow()
  expect(() => parseRemoteProfile({ ...p, schemaVersion: 1 })).toThrow()
  const next = { ...p, endpoints: [{ ...p.endpoints[0]!, url: 'wss://[2001:db8::1]:17788/ws' }] }; expect(() => assertProfileTrustUnchanged(p, next)).not.toThrow()
  const v1: RemoteProfile = { ...p, schemaVersion: 1, endpoints: [{ url: 'wss://example.com/ws', scope: 'public' }] }
  expect(() => assertProfileTrustUnchanged(v1, p)).toThrow('重新扫码'); expect(() => assertProfileTrustUnchanged(p, v1)).toThrow()
})
