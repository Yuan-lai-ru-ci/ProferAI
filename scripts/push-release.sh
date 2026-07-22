#!/bin/bash
# 🔴 已废弃：Profer 一键发布脚本
#
# ⚠ 本脚本曾含硬编码生产凭据（已从 Git 历史清除，凭据已轮换）。
# ⚠ 请使用 server/scripts/deploy-remote.sh 作为唯一安全发布路径。
# ⚠ 本文件保留仅作历史参照，不要在生产中使用。
#
# 安全发布路径:
#   cd server && bash scripts/deploy-remote.sh
# 详见: docs/operations/release.md

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  ⚠ push-release.sh 已废弃                  ║"
echo "║                                            ║"
echo "║  安全发布路径:                              ║"
echo "║    server/scripts/deploy-remote.sh          ║"
echo "║                                            ║"
echo "║  需要紧急发布？联系管理员。                  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
exit 1
