# Proma Team Server Dockerfile
# 构建: docker build -t proma-team-server .
# 运行: docker compose up -d

FROM node:20-slim

# better-sqlite3 需要编译工具
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

# 数据目录（volume 挂载点）
RUN mkdir -p /app/data/files

# better-sqlite3 原生模块需要运行时库
RUN apt-get remove -y python3 make gcc g++ && apt-get autoremove -y

ENV DATA_DIR=/app/data
ENV PORT=3456

EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3456/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "index.js"]
