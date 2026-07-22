/**
 * 🔴 已废弃：Profer 一键发布
 *
 * ⚠ 本脚本曾含硬编码生产凭据（已从 Git 历史清除，凭据已轮换）。
 * ⚠ 请使用 server/scripts/deploy-remote.sh 作为唯一安全发布路径。
 * ⚠ 本文件保留仅作历史参照，不要在生产中使用。
 *
 * 原用法: node scripts/push-release.js 0.12.70
 *
 * 安全发布路径:
 *   cd server && bash scripts/deploy-remote.sh
 * 详见: docs/operations/release.md
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2];
if (!VERSION) { console.error('用法: node scripts/push-release.js <版本号>'); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');

console.error('');
console.error('╔══════════════════════════════════════════════╗');
console.error('║  ⚠ push-release.cjs 已废弃                 ║');
console.error('║                                            ║');
console.error('║  安全发布路径:                              ║');
console.error('║    server/scripts/deploy-remote.sh          ║');
console.error('║                                            ║');
console.error('║  需要紧急发布？联系管理员。                  ║');
console.error('╚══════════════════════════════════════════════╝');
console.error('');
process.exit(1);

// 以下代码已不再可执行，仅作历史参照保留。
// 如有疑问，请查阅 docs/operations/release.md。

/*
const ELECTRON = path.join(ROOT, 'apps/electron');
const SERVER = path.join(ROOT, 'server');
const HOST = process.env.PROFER_DEPLOY_HOST;
const USER = process.env.PROFER_DEPLOY_USER;
const SSH_KEY = process.env.PROFER_SSH_KEY;

if (!HOST || !USER) {
  console.error('请在环境变量中设置 PROFER_DEPLOY_HOST 和 PROFER_DEPLOY_USER');
  console.error('发布前先配置 SSH key: ssh-copy-id -i ~/.ssh/profer_deploy ${USER}@${HOST}');
  process.exit(1);
}

function ssh(cmd, timeout = 15000) {
  const sshCmd = SSH_KEY ? `ssh -i "${SSH_KEY}"` : 'ssh';
  return new Promise((resolve) => {
    const p = spawn('ssh', ['-o', 'StrictHostKeyChecking=yes', `${USER}@${HOST}`, cmd]);
    ...
  });
}
*/
