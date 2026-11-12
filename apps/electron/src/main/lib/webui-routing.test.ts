import { describe, expect, test } from 'bun:test'
import {
  buildPublishedUrls,
  classifyInterfaceKind,
  isSafeAssetPath,
  listAccessibleHosts,
  normalizeBindHost,
  normalizePublishedIds,
  pickAccessibleHost,
  resolveWebuiRoute,
} from './webui-routing'

describe('WebUI 会话白名单', () => {
  test('Given 空注册表 When 访问任意会话页 Then 一律拒绝（默认 0 个网页）', () => {
    expect(resolveWebuiRoute('/s/abc', [])).toEqual({ kind: 'invalid' })
    expect(resolveWebuiRoute('/s/abc/', [])).toEqual({ kind: 'invalid' })
  })

  test('Given 已发布会话 A When 访问 A 与未发布的 B Then 只放行 A', () => {
    expect(resolveWebuiRoute('/s/A', ['A'])).toEqual({ kind: 'session', sessionId: 'A' })
    expect(resolveWebuiRoute('/s/B', ['A'])).toEqual({ kind: 'invalid' })
  })

  test('Given 会话 id 含 URL 编码 When 解析 Then 解码后仍按白名单精确匹配', () => {
    expect(resolveWebuiRoute('/s/a%20b', ['a b'])).toEqual({ kind: 'session', sessionId: 'a b' })
    expect(resolveWebuiRoute('/s/%ZZ', ['a'])).toEqual({ kind: 'invalid' })
  })

  test('Given 注入式路径 When 解析 Then 不会逃逸成别的会话或资源', () => {
    expect(resolveWebuiRoute('/s/A/../B', ['B'])).toEqual({ kind: 'invalid' })
    expect(resolveWebuiRoute('/s/', [''])).toEqual({ kind: 'invalid' })
  })
})

describe('WebUI 静态资源路径', () => {
  test('Given 正常资源路径 When 解析 Then 放行', () => {
    expect(resolveWebuiRoute('/webui/assets/main.js', [])).toEqual({ kind: 'asset', relativePath: 'assets/main.js' })
  })

  test('Given 目录穿越或绝对路径 When 判定 Then 拒绝', () => {
    expect(isSafeAssetPath('../secret.json')).toBe(false)
    expect(isSafeAssetPath('assets/../../secret.json')).toBe(false)
    expect(isSafeAssetPath('/etc/passwd')).toBe(false)
    expect(isSafeAssetPath('C:/Windows/win.ini')).toBe(false)
    expect(isSafeAssetPath('assets\\main.js')).toBe(false)
    expect(isSafeAssetPath('assets//main.js')).toBe(false)
    expect(isSafeAssetPath('assets/main.js')).toBe(true)
  })

  test('Given 非 WebUI 路径 When 解析 Then 交回原服务处理', () => {
    expect(resolveWebuiRoute('/health', [])).toEqual({ kind: 'foreign' })
    expect(resolveWebuiRoute('/ws', [])).toEqual({ kind: 'foreign' })
  })
})

describe('WebUI 配置归一化', () => {
  test('Given 脏设置值 When 归一化 Then trim、去重、丢弃非字符串并限长', () => {
    expect(normalizePublishedIds(null)).toEqual([])
    expect(normalizePublishedIds(['a', ' a ', 'a', 3, '', 'b'])).toEqual(['a', 'b'])
    expect(normalizePublishedIds(Array.from({ length: 50 }, (_, i) => `id-${i}`)).length).toBe(32)
  })

  test('Given 任意字符串作为绑定地址 When 归一化 Then 只保留 IPv4 字面量', () => {
    expect(normalizeBindHost(undefined)).toBe('127.0.0.1')
    expect(normalizeBindHost('192.168.1.7')).toBe('192.168.1.7')
    expect(normalizeBindHost('0.0.0.0')).toBe('0.0.0.0')
    expect(normalizeBindHost('localhost; rm -rf /')).toBe('127.0.0.1')
  })

  test('Given 监听 0.0.0.0 且无局域网网卡 When 生成展示 URL Then 回退为 127.0.0.1', () => {
    expect(buildPublishedUrls(['s1'], 7789, '0.0.0.0', 'tk')[0]?.url).toBe('http://127.0.0.1:7789/s/s1?token=tk')
  })

  test('Given 监听 0.0.0.0 且有局域网网卡 When 生成展示 URL Then 用局域网地址而不是 127.0.0.1', () => {
    // 127.0.0.1 在手机上必然是拒绝连接，展示它就是把人引到死路。
    expect(buildPublishedUrls(['s1'], 7789, '0.0.0.0', 'tk', '192.168.31.186')[0]?.url)
      .toBe('http://192.168.31.186:7789/s/s1?token=tk')
  })
})

describe('网卡分类（避免选中手机不可达的网卡）', () => {
  test('Given 隧道/VPN 网卡 When 分类 Then 标为 tunnel 而不是局域网', () => {
    expect(classifyInterfaceKind('Tailscale', '100.119.215.3', false)).toBe('tunnel')
    expect(classifyInterfaceKind('tun0', '10.8.0.2', false)).toBe('tunnel')
    expect(classifyInterfaceKind('WireGuard Tunnel', '10.7.0.1', false)).toBe('tunnel')
  })

  test('Given 物理局域网网卡 When 分类 Then 标为 lan', () => {
    expect(classifyInterfaceKind('WLAN 2', '192.168.31.186', false)).toBe('lan')
    expect(classifyInterfaceKind('以太网', '10.10.10.1', false)).toBe('lan')
  })

  test('Given 虚拟网卡 / 无 IP / 回环 When 分类 Then 各自归类', () => {
    expect(classifyInterfaceKind('VMware Network Adapter VMnet8', '192.168.238.1', false)).toBe('virtual')
    expect(classifyInterfaceKind('本地连接* 12', '169.254.22.165', false)).toBe('link-local')
    expect(classifyInterfaceKind('Loopback', '127.0.0.1', true)).toBe('loopback')
  })

  test('Given 别名无法识别的隧道网卡 When 选可达地址 Then 家用 Wi-Fi 网段优先于 10.x', () => {
    // et_6_jkb2 这类别名不含任何隧道关键词，classify 只能判成 lan；
    // 此时靠网段优先级兜底，192.168 必须排在所有 10.x 之前。
    const raw: Array<[string, string, boolean]> = [
      ['Loopback', '127.0.0.1', true],
      ['et_6_jkb2', '10.126.126.4', false],
      ['以太网', '10.10.10.1', false],
      ['WLAN 2', '192.168.31.186', false],
    ]
    const interfaces = raw.map(([name, address, internal]) => ({
      name,
      address,
      internal,
      kind: classifyInterfaceKind(name, address, internal),
    }))
    expect(pickAccessibleHost(interfaces)).toBe('192.168.31.186')
    expect(listAccessibleHosts(interfaces)[0]).toBe('192.168.31.186')
    // 隧道网卡不能被当成「可信候选」排到最前
    expect(listAccessibleHosts(interfaces)).not.toContain('127.0.0.1')
  })

  test('Given 只有隧道与回环 When 选可达地址 Then 返回 null 而不是误导性地址', () => {
    const interfaces = [
      { name: 'Tailscale', address: '100.119.215.3', internal: false, kind: 'tunnel' as const },
      { name: 'Loopback', address: '127.0.0.1', internal: true, kind: 'loopback' as const },
    ]
    expect(pickAccessibleHost(interfaces)).toBeNull()
    expect(listAccessibleHosts(interfaces)).toEqual([])
  })
})
