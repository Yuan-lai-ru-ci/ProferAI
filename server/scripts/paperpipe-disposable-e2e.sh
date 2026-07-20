#!/usr/bin/env bash
# 仅供已授权的生产同构环境执行。创建一次性账号，运行 arXiv E2E，最后回收账号和 Bridge 数据。
set -euo pipefail

: "${PAPERPIPE_E2E_CREATE_TEST_ACCOUNT:?必须显式设为 1 才允许创建测试账号}"
: "${PROFER_API_URL:?必须提供 Profer API 根地址}"
: "${PAPERPIPE_TEST_ARXIV_ID:?必须提供测试 arXiv ID}"
if [ "$PAPERPIPE_E2E_CREATE_TEST_ACCOUNT" != 1 ]; then
  echo 'PAPERPIPE_E2E_CREATE_TEST_ACCOUNT 必须为 1' >&2
  exit 2
fi

container=${PROMA_TEAM_CONTAINER:-proma-team}
data_root=${PAPERPIPE_DATA_ROOT:-/data/paperpipe}
stamp=$(date +%Y%m%d%H%M%S)
email="paperpipe-e2e-${stamp}@invalid.profer.test"
password="Paperpipe-E2E-${stamp}-$(openssl rand -hex 8)!"
activation="PAPERPIPE-E2E-${stamp}-$(openssl rand -hex 6)"
user_id=''

cleanup() {
  status=$?
  if [ -n "$user_id" ]; then
    sudo rm -rf "$data_root/$user_id"
    docker exec -e E2E_USER_ID="$user_id" -e E2E_EMAIL="$email" "$container" node --input-type=module -e '
      import { db } from "./src/db.js"
      const id = process.env.E2E_USER_ID
      db.transaction(() => {
        for (const table of ["audit_logs", "credit_transactions", "refresh_tokens", "credits", "invite_codes"]) {
          db.prepare(`DELETE FROM "${table}" WHERE user_id = ?`).run(id)
        }
        db.prepare("DELETE FROM users WHERE id = ? AND email = ?").run(id, process.env.E2E_EMAIL)
      })()
      if (db.prepare("SELECT COUNT(*) AS c FROM users WHERE id = ?").get(id).c) process.exit(1)
    ' || { echo "测试账号清理失败：$user_id / $email" >&2; status=1; }
  fi
  exit "$status"
}
trap cleanup EXIT

docker exec -e E2E_CODE="$activation" "$container" node --input-type=module -e '
  import { createActivationCode } from "./src/db.js"
  createActivationCode({ code: process.env.E2E_CODE, createdBy: "paperpipe-e2e", expiresAt: Date.now() + 600000, membershipTier: "free" })
'

payload=$(printf '{"email":"%s","password":"%s","displayName":"Paperpipe E2E","activationCode":"%s","deviceId":"paperpipe-e2e-%s","platform":"test"}' "$email" "$password" "$activation" "$stamp")
registration=$(curl -fsS -H 'Content-Type: application/json' -d "$payload" "${PROFER_API_URL%/}/v1/auth/register")
identity=$(printf '%s' "$registration" | node -e '
  let raw=""; process.stdin.on("data", d => raw += d).on("end", () => {
    const value = JSON.parse(raw)
    if (!value.userId || !value.accessToken) process.exit(2)
    console.log(`${value.userId}\n${value.accessToken}`)
  })
')
user_id=$(printf '%s\n' "$identity" | sed -n '1p')
token=$(printf '%s\n' "$identity" | sed -n '2p')

PROFER_TEST_TOKEN="$token" node "$(dirname "$0")/paperpipe-e2e.mjs"
