# Profer Team Server 部署教程

Profer 团队协作后端 —— Hono + better-sqlite3 + JWT。

## 目录

- [快速开始（Docker）](#快速开始docker)
- [手动部署](#手动部署)
- [环境变量](#环境变量)
- [Nginx 反代](#nginx-反代)
- [API 参考](#api-参考)
- [客户端配置](#客户端配置)
- [维护与排障](#维护与排障)

---

## 快速开始（Docker）

### 前置条件

- 服务器安装了 Docker 和 docker-compose
- 一个域名（可选，生产环境建议）

### 1. 准备项目

```bash
git clone <your-repo> proma-team-server
cd proma-team-server
```

### 2. 配置环境变量

```bash
# 生成安全密钥
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
ADMIN_PASSWORD="你的强密码"

# 写入 .env（docker-compose 自动读取）
cat > .env << EOF
JWT_SECRET=$JWT_SECRET
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_EMAIL=admin@proma.local
MAX_FILE_SIZE=524288000
EOF

chmod 600 .env
```

### 3. 启动

```bash
docker-compose up -d
```

### 4. 验证

```bash
curl http://localhost:3456/health
# → {"status":"ok","time":...}
```

**常用 Docker 命令：**

| 操作 | 命令 |
|------|------|
| 查看日志 | `docker-compose logs -f` |
| 重启 | `docker-compose restart` |
| 重新构建 | `docker-compose down && docker-compose up -d --build` |
| 进入容器 | `docker-compose exec proma-team sh` |
| 停止 | `docker-compose down` |

**数据持久化：** 数据库和上传文件存储在 Docker volume `promadata` 中，映射为容器内 `/app/data`。销毁容器不会丢失数据。

---

## 手动部署

### 前置条件

- Node.js 20+
- npm

### 1. 安装依赖

```bash
cd server
npm install
```

### 2. 环境变量

```bash
export JWT_SECRET="你的64位随机hex密钥"
export ADMIN_PASSWORD="admin密码"
export PORT=3456
export DATA_DIR="."          # 数据库和文件存储目录
export MAX_FILE_SIZE=524288000
```

不设置 `JWT_SECRET` 会导致启动失败。

### 3. 启动

**开发模式（前台）：**
```bash
node index.js
```

**生产模式（PM2）：**
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 开机自启（需要 sudo）
```

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|:--:|--------|------|
| `JWT_SECRET` | 是 | - | JWT 签名密钥，64 字节 hex，生成：`node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `ADMIN_PASSWORD` | 是 | - | admin 账户密码 |
| `PORT` | 否 | `3000` | 服务端口 |
| `ADMIN_EMAIL` | 否 | `admin@proma.local` | admin 账户邮箱 |
| `DATA_DIR` | 否 | `.` | 数据目录，存放 SQLite 数据库和上传文件 |
| `MAX_FILE_SIZE` | 否 | `524288000`（500MB） | 文件上传上限（字节） |

---

## Nginx 反代

生产环境推荐 nginx 反代，配置示例：

```nginx
# /etc/nginx/conf.d/proma.conf
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 500m;

    location /proma/ {
        proxy_pass http://127.0.0.1:3456/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

**启用 HTTPS（Let's Encrypt）：**

```bash
sudo yum install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## API 参考

Base URL: `http://<host>:3456`

所有需要认证的接口需在 Header 中携带 `Authorization: Bearer <accessToken>`。

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/auth/register` | 注册（需 `invitationToken`） |
| POST | `/v1/auth/login` | 登录，返回 `accessToken`(1h) + `refreshToken` |
| POST | `/v1/auth/refresh` | 用 `refreshToken` 刷新 `accessToken` |
| POST | `/v1/auth/logout` | 登出，吊销 token |

**注册：** `{ email, password, displayName?, invitationToken }`
- 密码要求：8 位以上，包含大小写字母 + 数字
- 需要有效邀请码才能注册

**登录：** `{ email, password }`
- 返回：`{ accessToken, refreshToken, expiresAt, userId, email }`

**刷新：** `{ refreshToken }`
- 返回：`{ accessToken, expiresAt }`

### 工作区

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/workspaces` | 列出我的工作区 |
| POST | `/v1/workspaces` | 创建工作区 `{ name }` |
| DELETE | `/v1/workspaces/:id` | 删除工作区（软删除，仅 owner） |
| GET | `/v1/workspaces/:id/members` | 成员列表 |
| POST | `/v1/workspaces/:id/members` | 邀请成员 `{ email?, role }` |
| PATCH | `/v1/workspaces/:id/members/:uid` | 修改角色 `{ role }` |
| DELETE | `/v1/workspaces/:id/members/:uid` | 移除成员 |
| POST | `/v1/workspaces/:id/leave` | 退出工作区 |
| POST | `/v1/workspaces/:id/transfer-ownership` | 转让所有权 `{ targetUserId }` |
| GET | `/v1/workspaces/:id/invitations` | 邀请记录列表 |
| DELETE | `/v1/workspaces/:id/invitations/:iid` | 撤销邀请 |
| GET | `/v1/workspaces/:id/stats` | 使用统计 |
| GET | `/v1/workspaces/:id/audit-logs?limit=50` | 审计日志 |

### 邀请

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/invitations/:token` | 验证邀请码有效性 |
| POST | `/v1/invitations/:token/accept` | 接受邀请（需认证） |
| POST | `/v1/invitations/:token/decline` | 拒绝邀请（需认证） |

### 文件

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/workspaces/:id/files/manifest` | 文件清单 |
| POST | `/v1/workspaces/:id/files/mkdir` | 创建文件夹 `{ path }` |
| POST | `/v1/workspaces/:id/files/upload` | 上传文件（raw body + `X-Filename` header） |
| GET | `/v1/workspaces/:id/files/download/*` | 下载文件 |
| DELETE | `/v1/workspaces/:id/files/*` | 删除文件/文件夹 |
| POST | `/v1/workspaces/:id/files/move` | 移动 `{ fromPath, toDir }` |

### 同步 & 心跳

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/sync/push` | 推送变更 `{ envelopes[] }` |
| POST | `/v1/sync/pull` | 拉取变更 `{ since }` |
| POST | `/v1/heartbeat` | 心跳上报 `{ workspaceIds[] }` |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |

### 安全特性

- **限流：** `/login` 每 IP 5次/分钟，`/register` 每 IP 10次/5分钟
- **账户锁定：** 5 次登录失败锁定 15 分钟
- **密码策略：** 8 位以上，需含大小写字母 + 数字
- **Token 黑名单：** 登出后 accessToken 立即失效
- **PBKDF2 随机盐：** 每用户独立盐值，防彩虹表
- **防路径遍历：** `safePath()` 拒绝 `..` 段

---

## 客户端配置

在 Profer 客户端中：

1. 打开 **设置 → 团队工作区**
2. 点击 **登录团队服务器**
3. 输入服务器地址（如 `http://47.109.108.57/proma`）
4. 输入邮箱和密码登录

成功后即可使用团队协作功能。

---

## 维护与排障

### 查看日志

```bash
# Docker
docker-compose logs -f --tail=100

# PM2
pm2 logs proma-team

# 手动
tail -f /tmp/proma-server.log
```

### 数据库操作

```bash
# 进入容器
docker-compose exec proma-team sh

# 查询
node -e "
const db = require('better-sqlite3')('/app/data/proma-team.db');
console.log(JSON.stringify(db.prepare('SELECT * FROM users').all(), null, 2));
"
```

### 备份数据库

```bash
# Docker
docker-compose exec proma-team cp /app/data/proma-team.db /app/data/proma-team.db.bak

# 手动
cp proma-team.db proma-team.db.$(date +%Y%m%d).bak
```

### 重置 admin 密码

```bash
node -e "
const crypto = require('crypto');
const { hashPassword } = require('./src/utils.js');
const db = require('better-sqlite3')('./proma-team.db');
const newHash = hashPassword('新密码');
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(newHash, 'admin@proma.local');
console.log('密码已重置');
"
```

### 常见问题

**Q: 启动报 "JWT_SECRET 未设置"**
A: 必须设置 `JWT_SECRET` 环境变量，不设会拒绝启动。

**Q: 注册返回 "需要有效的邀请链接"**
A: 注册必须先由已有成员生成邀请码。先用 admin 账户创建邀请码。

**Q: 文件上传失败**
A: 检查 `MAX_FILE_SIZE` 是否足够，nginx 是否配置了 `client_max_body_size`。

**Q: Docker 容器内数据库怎么备份到宿主机**
A: `docker cp proma-team:/app/data/proma-team.db ./backup.db`

**Q: 已有数据库迁移到 Docker**
A: `docker cp ./proma-team.db proma-team:/app/data/proma-team.db && docker-compose restart`
