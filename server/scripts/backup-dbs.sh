#!/usr/bin/env bash
#
# backup-dbs.sh — 生产双库自动备份（服务器本地轮转）
#
# 备份对象：
#   1) proma-team 容器内 /app/data/proma-team.db  (better-sqlite3, WAL 模式)
#   2) new-api    容器内 /data/one-api.db          (New API 计费账本, WAL 模式)
#
# 关键点：两库都是 WAL 模式，裸 cp 只拷 .db 会丢掉未 checkpoint 的 WAL 数据。
#   - proma-team 容器无 sqlite3 CLI → 用 better-sqlite3 的 `VACUUM INTO` 出一致性快照
#   - new-api    当前镜像不保证 sqlite3/Python CLI → 宿主机 Python 访问其 bind mount，用 Connection.backup() 在线热备
#   两种方式都是 SQLite 官方一致性快照，无需停容器。
#
# 存储：~/proma-team-server/backups/auto/，gzip 压缩，保留最近 $KEEP 份轮转。
# 部署：本脚本随仓库固化（server/scripts/backup-dbs.sh），并 scp 到服务器
#       ~/proma-team-server/scripts/backup-dbs.sh，由 ecs-user crontab 每日调用。
#
# 假设运行环境：服务器 ecs-user，HOME=/home/ecs-user，Asia/Shanghai 时区。
#
set -euo pipefail

BACKUP_ROOT="${HOME}/proma-team-server/backups/auto"
KEEP="${KEEP:-14}"                       # 每个库保留最近 N 份
LOG="${BACKUP_ROOT}/backup.log"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "${BACKUP_ROOT}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG}"; }
fail() { log "ERROR: $*"; exit 1; }

# 磁盘保护：可用空间低于 2G 时拒绝备份并告警（避免把盘写满连累在跑的容器）
avail_kb="$(df -P / | awk 'NR==2{print $4}')"
if [ "${avail_kb}" -lt 2097152 ]; then
  fail "磁盘可用空间不足 2G (可用 ${avail_kb}KB)，跳过备份，请先清理磁盘"
fi

log "=== 备份开始 ${TS} ==="

# ---------- 1. proma-team.db (better-sqlite3 VACUUM INTO) ----------
PT_OUT="${BACKUP_ROOT}/proma-team-${TS}.db"
log "[proma-team] VACUUM INTO 一致性快照..."
docker exec proma-team rm -f /tmp/pt-backup.db 2>/dev/null || true
docker exec -i proma-team node <<'NODEEOF' || fail "[proma-team] VACUUM INTO/integrity 失败"
const D = require('better-sqlite3');
const db = new D('/app/data/proma-team.db');
db.exec("VACUUM INTO '/tmp/pt-backup.db'");
const r = db.pragma('integrity_check');
if (!(r[0] && r[0].integrity_check === 'ok')) {
  console.error('integrity_check FAIL: ' + JSON.stringify(r));
  process.exit(1);
}
console.log('integrity_check ok');
db.close();
NODEEOF
docker cp proma-team:/tmp/pt-backup.db "${PT_OUT}" || fail "[proma-team] docker cp 失败"
docker exec proma-team rm -f /tmp/pt-backup.db 2>/dev/null || true
gzip -f "${PT_OUT}"
log "[proma-team] 完成 → ${PT_OUT}.gz ($(du -h "${PT_OUT}.gz" | cut -f1))"

# ---------- 2. one-api.db (Python sqlite3 backup) ----------
NA_OUT="${BACKUP_ROOT}/one-api-${TS}.db"
log "[new-api] 宿主机 Python sqlite3 在线热备..."
NEWAPI_DB="${NEWAPI_DB:-${HOME}/new-api-data/one-api.db}"
python3 - "${NEWAPI_DB}" "${NA_OUT}" <<'PYEOF' || fail "[new-api] sqlite backup 失败"
import sqlite3
import sys
source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
try:
    source.backup(target)
    result = target.execute('PRAGMA integrity_check').fetchone()
    if result != ('ok',):
        raise RuntimeError(f'integrity_check failed: {result!r}')
    print('integrity_check ok')
finally:
    target.close()
    source.close()
PYEOF
gzip -f "${NA_OUT}"

# ---------- 3. 轮转：每个库保留最近 $KEEP 份 ----------
rotate() {
  local prefix="$1"
  local n
  n="$(ls -1t "${BACKUP_ROOT}/${prefix}-"*.db.gz 2>/dev/null | wc -l)"
  if [ "${n}" -gt "${KEEP}" ]; then
    ls -1t "${BACKUP_ROOT}/${prefix}-"*.db.gz | tail -n +"$((KEEP + 1))" | while read -r f; do
      rm -f "${f}"
      log "轮转删除旧备份: $(basename "${f}")"
    done
  fi
}
rotate "proma-team"
rotate "one-api"

log "=== 备份完成 ${TS} (保留最近 ${KEEP} 份/库) ==="
