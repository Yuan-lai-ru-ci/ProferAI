/**
 * 补齐历史版本的分块映射（blockmap）。
 *
 * 为什么需要单独跑一次：更新源上会保留若干历史版本，但被清理掉的版本（实测 0.15.83）
 * 会让对应用户只能全量下载——electron-updater 取不到旧 blockmap 时不会报错，只会静默
 * 退化成全量下载（macOS 256MB / Windows 224MB）。发布脚本只能上传当前版本的 blockmap，
 * 补历史只能从本地留存的产物里捞。blockmap 每个只有 ~270KB。
 *
 * 用法：
 *   node scripts/backfill-update-blockmaps.cjs                     # 只打印计划（默认 dry-run）
 *   node scripts/backfill-update-blockmaps.cjs --apply             # 真正上传
 *   node scripts/backfill-update-blockmaps.cjs --from ../releases --apply
 *   node scripts/backfill-update-blockmaps.cjs --versions 0.15.83,0.16.13 --apply
 *
 * 主机/用户/端口沿用发布脚本的环境变量（PROFER_UPDATE_SSH_* / PROFER_UPDATE_LEGACY_SSH_*），
 * 仓库内不保存任何默认值。blockmap 只有 ~270KB，补传成本可以忽略。
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const UPDATE_FEED_URL = 'https://updates.profer.cn/'
const LEGACY_UPDATE_FEED_URL = 'https://profer.cn/profer-updates/'

function parseArgs(argv) {
  const args = { apply: false, from: path.join(ROOT, '..', 'releases'), versions: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') args.apply = true
    else if (arg === '--from') args.from = path.resolve(argv[++index])
    else if (arg === '--versions') args.versions = String(argv[++index]).split(',').map((v) => v.trim()).filter(Boolean)
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/backfill-update-blockmaps.cjs [--from <dir>] [--versions a,b] [--apply]')
      process.exit(0)
    } else throw new Error(`未知参数: ${arg}`)
  }
  return args
}

function requireEnv(name, label) {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}（${label}）`)
  return value
}

function getTargets() {
  const targets = [{
    label: '新机',
    host: requireEnv('PROFER_UPDATE_SSH_HOST', '国内更新源主机'),
    user: requireEnv('PROFER_UPDATE_SSH_USER', '国内更新源 SSH 用户'),
    port: process.env.PROFER_UPDATE_SSH_PORT || '22',
    dir: process.env.PROFER_UPDATE_DIR || '/var/www/updates.profer.cn',
  }]
  if (process.env.PROFER_UPDATE_SKIP_LEGACY !== '1') {
    targets.push({
      label: '旧机',
      host: requireEnv('PROFER_UPDATE_LEGACY_SSH_HOST', '旧更新源主机'),
      user: requireEnv('PROFER_UPDATE_LEGACY_SSH_USER', '旧更新源 SSH 用户'),
      port: process.env.PROFER_UPDATE_LEGACY_SSH_PORT || '22',
      dir: process.env.PROFER_UPDATE_LEGACY_DIR || '/usr/share/nginx/html/profer-updates',
    })
  }
  return targets
}

/** 递归收集 blockmap，按文件名去重（同一版本可能在 out/ 与归档目录各留一份）。 */
function collectBlockmaps(fromDir) {
  const found = new Map()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.blockmap')) found.set(entry.name, full)
    }
  }
  walk(fromDir)
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b))
}

function scp(local, remote, target) {
  execFileSync('scp', ['-o', 'StrictHostKeyChecking=yes', '-P', String(target.port), local, `${target.user}@${target.host}:${remote}`], { stdio: 'inherit' })
}

function ssh(command, target) {
  execFileSync('ssh', ['-o', 'StrictHostKeyChecking=yes', '-p', String(target.port), `${target.user}@${target.host}`, command], { stdio: 'inherit' })
}

/** Windows 上没有 /dev/null，curl 需要 NUL 才能丢弃响应体。 */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

function publicStatus(url) {
  const output = execFileSync('curl', ['-sS', '-o', NULL_DEVICE, '--max-time', '20', '-w', '%{http_code}', url], { encoding: 'utf8' })
  return Number(output.trim())
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.from)) throw new Error(`归档目录不存在: ${args.from}`)

  const all = collectBlockmaps(args.from)
  const selected = args.versions
    ? all.filter(([name]) => args.versions.some((version) => name.includes(version)))
    : all
  if (selected.length === 0) {
    console.log('没有找到需要补传的 blockmap。')
    return
  }

  console.log(`从 ${args.from} 找到 ${selected.length} 个 blockmap：`)
  for (const [name] of selected) console.log(`  - ${name}`)

  if (!args.apply) {
    console.log('\n当前为 dry-run，未上传。加 --apply 真正执行。')
    return
  }

  for (const target of getTargets()) {
    const sudo = target.user === 'root' ? '' : 'sudo '
    for (const [name, local] of selected) {
      scp(local, `/tmp/${name}`, target)
    }
    const copy = selected.map(([name]) => `${sudo}cp /tmp/${name} ${target.dir}/`).join(' && ')
    ssh(`${sudo}mkdir -p ${target.dir} && ${copy} && ${sudo}chmod 644 ${target.dir}/*.blockmap`, target)
    console.log(`已补传到 ${target.label} ${target.user}@${target.host}:${target.dir}`)
  }

  const feeds = [UPDATE_FEED_URL]
  if (process.env.PROFER_UPDATE_SKIP_LEGACY !== '1') feeds.push(LEGACY_UPDATE_FEED_URL)
  let failed = 0
  for (const feed of feeds) {
    for (const [name] of selected) {
      const status = publicStatus(`${feed}${name}`)
      if (status !== 200) {
        failed += 1
        console.error(`  校验失败 ${feed}${name} → HTTP ${status}`)
      }
    }
    console.log(`公开校验完成：${feed}`)
  }
  if (failed > 0) {
    console.error(`有 ${failed} 个文件未生效，请检查 nginx 目录与权限。`)
    process.exit(1)
  }
  console.log('全部 blockmap 已公开可访问，下次更新即可走差分下载。')
}

main()
