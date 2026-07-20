# 论文知识库 paperpipe 集成诊断

## 当前状态（2026-07-18 10:17）

### 已完成
1. ✅ 服务端 paperpipe-bridge.service 正常运行（systemd，端口 9876）
2. ✅ 服务端路由 `server/src/routes/services/paperpipe.js` 已创建并挂载到 `/v1/services/paperpipe/*`
3. ✅ 客户端 `kb-paperpipe.ts` 已创建（~420 行），替代 kb-service.ts
4. ✅ IPC handlers 已切换到 kb-paperpipe（7 个 handler）
5. ✅ MCP 工具已适配（kb-agent-tools.ts）
6. ✅ 旧代码已清理（kb-embedder.ts 删除，kb-chunker.ts 删除，kb-service.ts 精简 433→66 行）
7. ✅ UI 重命名："知识库" → "论文知识库"
8. ✅ 设置开关已添加（paperKnowledgeBaseEnabled，默认 true）

### 工作树状态
- 25 commits ahead of origin/main
- 45 个文件已修改
- 5 个新文件（kb-paperpipe.ts, paperpipe.js, 4 个脚本）
- 2 个文件删除（kb-chunker.ts, kb-embedder.ts）

### TypeScript 错误（15 个）
大部分是既存问题（TeamActivityFeed 图标类型 8 个，其他 7 个），与 paperpipe 集成无关。

## 问题点

### 1. 未实际测试客户端端到端功能
- 代码已写完，但未启动 dev 验证
- 可能存在运行时错误（类型定义、API 对接等）

### 2. 服务端 Docker 容器内连通性未验证
- paperpipe-bridge 运行在宿主机 9876 端口
- server 代码通过 `host.docker.internal:9876` 访问
- 未验证 Docker 容器能否访问宿主机该端口

### 3. 数据迁移未做
- 本地 index.json 中已有论文未同步到 paperpipe 服务端
- 用户升级后旧数据不可见

### 4. 缺少错误处理和用户反馈
- kb-paperpipe.ts 中很多地方直接 throw，UI 可能看到原始错误
- 缺少友好的错误提示

## 下一步行动

### Phase 1: 验证基础连通性
1. 测试 Docker 容器 → host.docker.internal:9876 连通性
2. 检查 server/src/routes/services/paperpipe.js 的代理逻辑
3. 修复任何网络/权限问题

### Phase 2: 修复 TypeScript 错误
1. 补充缺失的类型定义（SkillFileContent 等）
2. 修复既存的类型错误（如果影响编译）

### Phase 3: 端到端测试
1. 启动 dev 环境
2. 测试导入 arXiv 论文
3. 测试上传本地 PDF
4. 测试搜索功能
5. 测试删除功能

### Phase 4: 数据迁移
1. 编写迁移脚本：本地 index.json → paperpipe 服务端
2. 在客户端首次启动时自动执行

### Phase 5: 提交代码
1. 修复所有运行时错误
2. 提交到 git
3. 部署服务端更新（如需要）
