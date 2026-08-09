/**
 * memory-archive FTS5 检索服务 —— Node 运行验证脚本。
 *
 * 背景：memory-archive-search.ts 依赖 Node 内置 `node:sqlite`（Electron 43 / Node 24.18 可用，
 * 但 bun test 运行器不支持 require node:sqlite）。因此该服务无法进 bun test gate，
 * 改用一个独立的 Node 脚本在真实 Node（= 与 Electron 相同的 sqlite 能力）下做端到端验证。
 *
 * 用法：
 *   node scripts/memory-search-verify.mjs
 * 退出码：0 = 全部通过，1 = 有失败。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// 1. 用 esbuild 把 TS 服务打包成临时 cjs（保留 node:sqlite external），再 require
const outfile = join(tmpdir(), `profer-memsearch-verify-${process.pid}.cjs`)
await build({
  entryPoints: [join(root, 'src/main/lib/memory-archive-search.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
})
const svc = await import(`file://${outfile}`)

// 2. 构造真实 memory-archive 目录与主题文件
const wsRoot = mkdtempSync(join(tmpdir(), 'profer-memverify-'))
const memoryDir = join(wsRoot, 'memory-archive')
mkdirSync(memoryDir, { recursive: true })

function seed() {
  writeFileSync(join(memoryDir, 'skin-engine.md'), `# 皮肤引擎
08-08 主题重构为外部皮肤包（resources/skins/{id}/manifest+skin.css+preview），THEME_STYLES 白名单退役；assets 改 profer-skin:// 稳定协议。`)
  writeFileSync(join(memoryDir, 'profer-performance-issues.md'), `# 性能排查
08-08 正式版 GPU 进程 693MB 私有内存高：高分屏+Intel Arc+Electron 43 常态非泄漏。`)
  writeFileSync(join(memoryDir, 'pr-wflow.md'), `# 干净 PR 工作流
每个独立功能使用从最新 origin/main 建立的隔离 worktree + 精确暂存 + cherry-pick。合并后删除临时分支。`)
  writeFileSync(join(memoryDir, 'prod-server-ops.md'), `# 生产运维
服务器拓扑 47.109.108.57，docker 手动构建，部署规则：换用户/uid 必须 chown 数据卷。`)
}

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) }
}

seed()
const searcher = svc.createMemoryArchiveSearcher(memoryDir)

const cases = [
  ['中文短语', '皮肤引擎', 1, 'skin-engine.md'],
  ['中文长短语', '白名单退役', 1, 'skin-engine.md'],
  ['中文单字', '引', 1, 'skin-engine.md'],
  ['英文整词', 'worktree', 1, 'pr-wflow.md'],
  ['路径片段', 'profer-skin', 1, 'skin-engine.md'],
  ['版本号', '47.109.108.57', 1, 'prod-server-ops.md'],
  ['英文+版本混合', 'Electron 43', 1, 'profer-performance-issues.md'],
  ['英文大小写', 'WORKTREE', 1, 'pr-wflow.md'],
  ['无关查询', '量子计算', 0, null],
]
console.log('=== 检索命中 ===')
for (const [name, q, expectN, expectPath] of cases) {
  const hits = searcher.search(q, 5)
  const okN = hits.length === expectN
  const okP = expectPath ? hits.length > 0 && hits[0].relativePath === expectPath : true
  check(`query="${q}" → ${hits.length} 条${hits[0] ? ' @ '+hits[0].relativePath : ''}`, okN && okP)
}

console.log('=== 增删改一致性 ===')
// 新增文件即时可达
writeFileSync(join(memoryDir, 'new-topic.md'), '新的主题：任务图任务依赖与撤销。')
const afterAdd = searcher.search('撤销')
check('新增文件即时检索', afterAdd.length === 1 && afterAdd[0].relativePath === 'new-topic.md')

// 修改文件内容后（字节数变化触发签名失效）取最新内容 —— 同一文件旧词条必须移除
writeFileSync(join(memoryDir, 'skin-engine.md'), '# 皮肤引擎\n已被整体重写，主题改为外部皮肤包机制，条目删除了。')
const afterRewrite = searcher.search('白名单')
check('重写文件不再命中旧词', afterRewrite.length === 0)

// 删除文件后不再返回
rmSync(join(memoryDir, 'pr-wflow.md'))
const afterDelete = searcher.search('worktree')
check('删除文件不再命中', afterDelete.length === 0)

console.log(`\n结果：${pass} 通过, ${fail} 失败`)
searcher.close()
rmSync(wsRoot, { recursive: true, force: true })
rmSync(outfile, { force: true })
process.exit(fail ? 1 : 0)
