#!/usr/bin/env node
/**
 * macOS 代码签名契约：ad-hoc 签名 + 钉死 designated requirement（DR）。
 *
 * ## 为什么需要它
 *
 * electron-builder 在找不到可用签名身份时会**完全跳过** macOS 签名，产出的
 * `Profer.app` 缺少 `Contents/_CodeSignature/CodeResources`，于是连
 * `codesign --verify` 都过不去：
 *
 *   code has no resources but signature indicates they must be present
 *
 * 而 Squirrel.Mac 在安装更新前会执行（见 Squirrel/SQRLCodeSignature.m）：
 *
 *   SecStaticCodeCheckValidity(新包, kSecCSDefaultFlags, 运行中旧包的 DR)
 *
 * 所以这种包永远无法通过自更新校验：更新能下载完成，但安装会静默失败。
 *
 * ## 做法
 *
 * 打包后补一次**完整**的 ad-hoc 签名，并把顶层 App 的 DR 钉死为
 * `identifier "<bundleId>"`。原因是 ad-hoc 签名缺省派生的 DR 是 `cdhash H"…"`，
 * 每次构建都不同，新包永远无法满足旧包的 DR；钉死成 bundle id 之后 DR 跨版本稳定，
 * Squirrel 的校验才能通过（真实验证方式见 assertMacSignatureContract）。
 *
 * ## 改动前必读的约束
 *
 * 1. **不能改用 `codesign --deep`。** `--deep` 会把 `--identifier`/`-r` 一并施加到
 *    Helper、Electron Framework 等嵌套包上，使 helper 的 DR 变成顶层 bundle id
 *    而无法自我满足（实测 `--deep --strict` 失败、helper 标识被覆盖）。
 *    必须交给 `@electron/osx-sign` 按目录深度倒序逐个签名。
 * 2. **一旦某个版本以本契约发布，后续版本必须保持同一 DR。** DR 变更会让
 *    Squirrel 判定"新包不满足运行中旧包的 DR"，等于强制所有用户手动重装一次。
 * 3. **存在真实 Developer ID 签名时必须直接跳过**，绝不能覆盖真实签名。
 *    真实签名的 DR 由证书锚定（跨版本天生稳定），比钉死 bundle id 更强。
 * 4. ad-hoc 签名**不提供** Gatekeeper 公证。用户从浏览器下载 DMG 首次安装仍会被
 *    拦（"无法验证开发者"），只有 Developer ID + notarization 能解决。
 */
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PRODUCT_APP_NAME = 'Profer.app'
const ADHOC_TEAM_IDENTIFIER = 'not set'
const REQUIREMENTS_FILE_PREFIX = 'profer-mac-designated-requirement'

/**
 * 顶层 App 期望的 designated requirement 表达式。
 *
 * 只锚定 bundle identifier：ad-hoc 签名没有证书链可锚，这是唯一能跨版本稳定的形式。
 * 更新包的真实性仍由 electron-updater 校验 HTTPS 元数据（latest-mac.yml）里的 sha512 保证。
 */
function expectedDesignatedRequirement(bundleId) {
  if (!bundleId || typeof bundleId !== 'string') {
    throw new Error(`无法为空的 bundle identifier 构造 designated requirement: ${bundleId}`)
  }
  return `identifier "${bundleId}"`
}

function runCodesign(args) {
  // codesign 的 --display 系列把内容写到 stderr，因此必须合并两路输出。
  // 注意：成功路径（exit 0）也会走 stderr，不能只用 execFileSync 的返回值，
  // 否则 readSignatureInfo 会永远读到 null，真实 Developer ID 签名会被误判成 ad-hoc。
  const result = spawnSync('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const output = `${stdout}${stderr}`
  if (result.error) return { ok: false, output, error: result.error }
  return { ok: result.status === 0, output, status: result.status }
}

/** 读取 App bundle 的 CFBundleIdentifier（即 appId），它是 DR 的唯一来源。 */
function readBundleIdentifier(appPath) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist')
  if (!fs.existsSync(infoPlist)) throw new Error(`macOS App 缺少 Info.plist: ${infoPlist}`)
  const bundleId = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleIdentifier', infoPlist],
    { encoding: 'utf8' },
  ).trim()
  if (!bundleId) throw new Error(`无法读取 CFBundleIdentifier: ${infoPlist}`)
  return bundleId
}

/**
 * 从 `codesign -d -r-` 的输出中解析 designated requirement 表达式（去掉 `designated =>` 前缀）。
 * codesign 对显式 `-r` 写入的需求输出不带 `#`，对缺省派生的需求输出带 `#`，两者都要处理。
 */
function parseDesignatedRequirement(codesignOutput) {
  const match = String(codesignOutput ?? '').match(/^\s*#?\s*designated\s*=>\s*(.+?)\s*$/m)
  return match ? match[1] : null
}

/** 读取目标的 designated requirement 表达式。 */
function readDesignatedRequirement(target) {
  const { output } = runCodesign(['-d', '-r-', target])
  return parseDesignatedRequirement(output)
}

/** 读取签名摘要信息（identifier / teamIdentifier / cdhash / 是否 ad-hoc）。 */
function readSignatureInfo(target) {
  const { ok, output } = runCodesign(['-dvvv', target])
  if (!ok) throw new Error(`读取签名信息失败: ${target}\n${output}`)
  const pick = (key) => {
    const match = output.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return match ? match[1].trim() : null
  }
  const teamIdentifier = pick('TeamIdentifier')
  return {
    identifier: pick('Identifier'),
    teamIdentifier,
    cdhash: pick('CDHash'),
    signature: pick('Signature'),
    isAdhoc: teamIdentifier === ADHOC_TEAM_IDENTIFIER || pick('Signature') === 'adhoc',
  }
}

/**
 * 从 Bun 虚拟依赖仓库解析 `@electron/osx-sign`。
 *
 * 沿用 scripts/run-electron-builder.cjs 的既有约定：优先 `node_modules/.bun`，
 * 其次兼容 hoisted 安装；只接受仓库内已锁定的版本，不触发网络下载。
 */
function resolveOsxSign() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const bunStore = path.join(repoRoot, 'node_modules', '.bun')
  const isolated = fs.existsSync(bunStore)
    ? fs.readdirSync(bunStore)
      .filter((name) => name.startsWith('@electron+osx-sign@'))
      .map((name) => path.join(bunStore, name, 'node_modules', '@electron', 'osx-sign'))
      .filter((candidate) => fs.existsSync(candidate))
    : []
  const candidates = isolated.length > 0
    ? isolated
    : [
      path.join(repoRoot, 'node_modules', '@electron', 'osx-sign'),
      path.join(repoRoot, 'apps', 'electron', 'node_modules', '@electron', 'osx-sign'),
    ].filter((candidate) => fs.existsSync(candidate))

  if (candidates.length !== 1) {
    throw new Error(
      `期望在 Bun 虚拟依赖仓库中找到唯一 @electron/osx-sign，实际找到 ${candidates.length} 个。` +
      '请先运行 bun install --frozen-lockfile。',
    )
  }
  return require(candidates[0])
}

/**
 * 对 App bundle 做完整的 ad-hoc 签名，并把顶层 DR 钉死为 bundle id。
 *
 * 交给 @electron/osx-sign 逐个目标签名（按深度倒序），避免 `codesign --deep`
 * 覆盖嵌套包的 identifier / DR。hardened runtime 与 entitlements 保持关闭，
 * 与当前无签名产物的运行行为一致；真实签名接入时应由 electron-builder 统一开启。
 */
async function signMacAppWithPinnedRequirement(appPath) {
  const resolvedApp = path.resolve(appPath)
  if (!fs.existsSync(resolvedApp)) throw new Error(`macOS App 不存在: ${resolvedApp}`)

  const bundleId = readBundleIdentifier(resolvedApp)
  const requirementExpression = expectedDesignatedRequirement(bundleId)
  const requirementPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `${REQUIREMENTS_FILE_PREFIX}-`)),
    'requirement.txt',
  )
  // @electron/osx-sign 的 requirements 选项：以 `=` 开头按字面量传递，否则按文件路径传递。
  // 内部需求文件需要完整的 `designated => …` 形式，因此走文件路径这一支。
  fs.writeFileSync(requirementPath, `designated => ${requirementExpression}\n`)

  const { signAsync } = resolveOsxSign()
  try {
    await signAsync({
      app: resolvedApp,
      // `-` 是 codesign 的 ad-hoc 身份；identityValidation=false 跳过钥匙串查找。
      identity: '-',
      identityValidation: false,
      platform: 'darwin',
      // 关闭 Info.plist 自动改写的两个预处理步骤：ad-hoc 没有 team / provisioning profile，
      // 且不应在本契约里修改已定稿的 Info.plist。
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: (filePath) => ({
        hardenedRuntime: false,
        timestamp: 'none',
        // DR 只施加在顶层 App：施加到 helper 会让 helper 无法满足自身 DR。
        ...(path.resolve(filePath) === resolvedApp ? { requirements: requirementPath } : {}),
      }),
    })
  } finally {
    fs.rmSync(path.dirname(requirementPath), { recursive: true, force: true })
  }

  return { bundleId, requirement: requirementExpression }
}

/**
 * 断言 macOS 签名契约成立。dist / 发布脚本共用这一处判定，避免门禁漂移。
 *
 * 校验项：
 * 1. 包完整有效（codesign --verify --deep --strict）
 * 2. 顶层 DR 可跨版本稳定：ad-hoc 必须等于 identifier "<bundleId>"；真实签名必须由
 *    Apple 锚定且带同一 bundle id（DR 由证书派生，天然跨版本稳定）
 * 3. Squirrel.Mac 实际使用的校验路径（无 --deep / --strict + 指定 DR）通过
 * 4. 嵌套 helper 保留各自 bundle id（防止有人改回 `codesign --deep`）
 */
function assertMacSignatureContract(appPath) {
  const resolvedApp = path.resolve(appPath)
  if (!fs.existsSync(resolvedApp)) throw new Error(`macOS App 不存在: ${resolvedApp}`)

  const bundleId = readBundleIdentifier(resolvedApp)
  const expectedRequirement = expectedDesignatedRequirement(bundleId)

  const strict = runCodesign(['--verify', '--deep', '--strict', '--verbose=2', resolvedApp])
  if (!strict.ok) throw new Error(`macOS 签名不完整（codesign --verify --deep --strict 失败）:\n${strict.output}`)

  const plain = runCodesign(['--verify', '--verbose=2', resolvedApp])
  if (!plain.ok) throw new Error(`macOS 签名无效（codesign --verify 失败）:\n${plain.output}`)

  const signature = readSignatureInfo(resolvedApp)
  const requirement = readDesignatedRequirement(resolvedApp)

  if (signature.isAdhoc) {
    if (requirement !== expectedRequirement) {
      throw new Error(
        `macOS designated requirement 不符合契约：期望 ${expectedRequirement}，实际 ${requirement ?? '(缺失)'}。` +
        'cdhash 派生或缺失的 DR 会导致 Squirrel.Mac 拒绝安装更新。',
      )
    }
  } else {
    // 真实签名（Developer ID）：DR 由证书锚定，不再是字面上的 identifier 单条，
    // 但仍必须（a）锚定到 Apple、（b）限定同一 bundle id。否则 Squirrel.Mac 跨版本校验会失败，
    // 或允许任意证书冒充本应用。
    if (!requirement) {
      throw new Error('macOS 真实签名缺少 designated requirement')
    }
    if (!requirement.includes(`identifier "${bundleId}"`)) {
      throw new Error(`macOS 真实签名的 DR 未限定 bundle id ${bundleId}：${requirement}`)
    }
    if (!/anchor apple generic/.test(requirement)) {
      throw new Error(
        `macOS 真实签名未锚定到 Apple（缺少 anchor apple generic）：${requirement}。` +
        '自签名证书不能用于发布包。',
      )
    }
  }

  // 复现 Squirrel.Mac 的校验：SecStaticCodeCheckValidity(新包, kSecCSDefaultFlags, 旧包 DR)。
  // 真实签名的 DR 是一整条 requirement 表达式，也必须用它自己的 DR 来验证自满足。
  const satisfies = runCodesign(['--verify', `-R=${requirement}`, resolvedApp])
  if (!satisfies.ok) {
    throw new Error(`macOS App 不满足自身 designated requirement，自更新会失败:\n${satisfies.output}`)
  }

  const frameworksDir = path.join(resolvedApp, 'Contents', 'Frameworks')
  const nestedBundles = fs.existsSync(frameworksDir)
    ? fs.readdirSync(frameworksDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => path.join(frameworksDir, entry.name))
    : []
  for (const nested of nestedBundles) {
    const info = readSignatureInfo(nested)
    if (info.identifier === bundleId) {
      throw new Error(
        `嵌套 App 被错误地签成了顶层 bundle id（${bundleId}）: ${nested}。` +
        '这通常是误用了 `codesign --deep --identifier`；请改回 @electron/osx-sign 逐个签名。',
      )
    }
  }

  return {
    ok: true,
    appBundle: resolvedApp,
    bundleId,
    signatureMode: signature.isAdhoc ? 'adhoc' : 'developer-id',
    teamIdentifier: signature.teamIdentifier,
    designatedRequirement: requirement,
    nestedAppCount: nestedBundles.length,
  }
}

module.exports = {
  PRODUCT_APP_NAME,
  expectedDesignatedRequirement,
  parseDesignatedRequirement,
  readBundleIdentifier,
  readDesignatedRequirement,
  readSignatureInfo,
  resolveOsxSign,
  signMacAppWithPinnedRequirement,
  assertMacSignatureContract,
}
