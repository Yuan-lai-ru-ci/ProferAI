# Proma Team Server Dockerfile
# 构建: docker build -t proma-team-server .
# 运行: docker compose up -d

# ===== 构建阶段 =====
FROM node:20-slim AS build

# better-sqlite3 需要编译工具（此阶段使用，最终镜像不包含）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖层（利用 Docker 缓存）
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# 代码层
COPY src/ ./src/
COPY index.js ./

# ===== 运行阶段 =====
FROM node:20-slim

# 创建非 root 用户
RUN groupadd -r proma && useradd -r -g proma -d /app proma

WORKDIR /app

# 从构建阶段复制 node_modules（含编译好的 better-sqlite3）和代码
COPY --from=build --chown=proma:proma /app/node_modules ./node_modules
COPY --from=build --chown=proma:proma /app/src ./src
COPY --from=build --chown=proma:proma /app/index.js ./
COPY --from=build --chown=proma:proma /app/package.json ./

# 数据目录（volume 挂载点），确保 proma 用户有写入权限
RUN mkdir -p /app/data/files

ENV DATA_DIR=/app/data
ENV PORT=3456

USER proma

EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3456/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "index.js"]
