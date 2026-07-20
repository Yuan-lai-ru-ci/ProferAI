# 部署清单 - 问题 3 & 5 修复

**版本**: 待定（修复后应为 v0.14.21）  
**部署目标**: 47.109.108.57 生产服务器  
**预计影响**: 低（仅后端中间件改动，不影响现有功能）

---

## 📋 改动文件

```
server/src/middleware/rate-limit.js          [新增] Rate Limiting 中间件
server/src/middleware/credit-gate.js         [修改] 缩短容错窗口 60s → 15s
server/src/routes/public/plans.js            [修改] 限速 + 隐藏内部参数
server/src/middleware.js                     [修改] CORS 多域名白名单
server/.env.example                          [修改] 文档更新
```

---

## 🔧 部署前准备

### 1. 备份数据库

```bash
ssh ecs-user@47.109.108.57
cd ~/proma-team-server
cp proma-team.db proma-team.db.backup-$(date +%Y%m%d-%H%M%S)
```

### 2. 配置环境变量

编辑 `~/proma-team-server/.env`：

```bash
# 添加或修改 CORS 白名单（根据实际官网域名调整）
ALLOWED_ORIGIN=https://profer.cn,https://www.profer.cn

# 如果官网未上线，暂时可以设置为 *（但上线后务必改为具体域名）
# ALLOWED_ORIGIN=*
```

---

## 🚀 部署步骤

### 方式 A: 标准部署（推荐）

```bash
# 1. 连接服务器
ssh ecs-user@47.109.108.57
cd ~/proma-team-server

# 2. 拉取代码（假设已推送到 origin/main）
git pull origin main

# 3. 重启容器（docker-compose v1 语法）
docker-compose down
docker-compose up -d --build

# 4. 查看日志，确认启动成功
docker logs proma-team -f --tail 50
```

### 方式 B: 本地部署脚本（如果使用 deploy-remote.sh）

```bash
# 在本地开发机器上执行
cd D:/profer/Proma-main/server
bash scripts/deploy-remote.sh
```

---

## ✅ 验证步骤

### 1. 健康检查

```bash
curl http://47.109.108.57/proma/health
# 预期: {"status":"ok","time":1721295600}
```

### 2. 验证 Rate Limiting

```bash
# 连续请求 15 次公开 API
for i in {1..15}; do
  echo "Request $i:"
  curl -i http://47.109.108.57/proma/v1/public/plans 2>&1 | grep -E "HTTP|X-RateLimit"
  sleep 0.5
done

# 预期:
# - 前 10 次: HTTP/1.1 200 OK
# - 第 11 次起: HTTP/1.1 429 Too Many Requests
# - 响应头包含: X-RateLimit-Limit: 10, X-RateLimit-Remaining: 0
```

### 3. 验证内部参数隐藏

```bash
curl http://47.109.108.57/proma/v1/public/plans | jq '.plans.standard'

# 预期: 只包含 name, monthlyRmb, yearlyRmb
# 不应包含: welcomeBonus, dailyDrip
```

### 4. 验证 CORS（如果官网已上线）

```bash
curl -H "Origin: https://profer.cn" -i http://47.109.108.57/proma/v1/public/plans | grep Access-Control

# 预期: Access-Control-Allow-Origin: https://profer.cn

# 测试非白名单域名（应该不返回 CORS 头）
curl -H "Origin: https://evil.com" -i http://47.109.108.57/proma/v1/public/plans | grep Access-Control
# 预期: 无输出（CORS 头不存在）
```

### 5. 监控计费日志（24 小时）

```bash
# 持续监控计费门禁日志
docker logs proma-team -f | grep credit-gate

# 关注以下日志:
# - "余额查询失败" 警告（偶尔出现正常，连续出现需排查）
# - "🚨 DB 连续失败" 错误（如果出现，立即排查 DB）
```

---

## 🔄 回滚方案

如果部署后出现问题，立即回滚：

```bash
# 1. 停止容器
docker-compose down

# 2. 回滚代码到上一个版本
git log --oneline -5  # 找到修复前的 commit
git reset --hard <commit-hash>

# 3. 重启容器
docker-compose up -d --build

# 4. 恢复数据库（如果有必要）
cp proma-team.db.backup-<timestamp> proma-team.db
```

---

## ⚠️ 注意事项

1. **CORS 配置**: 如果官网域名未确定，先设置 `ALLOWED_ORIGIN=*`，**上线后务必改为具体域名**
2. **Rate Limiting 影响**: 每 IP 每分钟最多 10 次请求，正常用户不会触发，但需要告知前端开发者
3. **计费容错窗口**: 从 60 秒缩短到 15 秒，如果 DB 频繁故障，可能影响服务可用性（建议优先修复 DB）
4. **内部参数隐藏**: 如果官网需要展示 welcomeBonus 等信息，需要调整前端获取方式

---

## 📊 监控指标

部署后 24-48 小时内重点监控：

| 指标 | 监控命令 | 正常范围 | 告警阈值 |
|------|----------|----------|----------|
| 429 错误率 | `docker logs proma-team \| grep "429" \| wc -l` | < 10 次/小时 | > 100 次/小时 |
| 计费失败次数 | `docker logs proma-team \| grep "余额查询失败" \| wc -l` | 0 | ≥ 5 次（15 秒内） |
| API 响应时间 | 手动测试 | < 500ms | > 2s |

---

## 🆘 紧急联系

如果部署后出现严重问题：

1. **立即回滚**（见回滚方案）
2. **通知开发者**: 原来如此（用户）
3. **保留日志**: `docker logs proma-team > error.log`

---

## ✅ 部署检查表

- [ ] 数据库已备份
- [ ] ALLOWED_ORIGIN 环境变量已配置
- [ ] 代码已推送到 origin/main
- [ ] 容器已重启
- [ ] 健康检查通过
- [ ] Rate Limiting 验证通过
- [ ] 内部参数隐藏验证通过
- [ ] CORS 验证通过（如果官网已上线）
- [ ] 计费日志监控已启动
- [ ] 回滚方案已准备

---

**部署负责人**: _____________  
**部署时间**: _____________  
**验证时间**: _____________  
**备注**: _____________
