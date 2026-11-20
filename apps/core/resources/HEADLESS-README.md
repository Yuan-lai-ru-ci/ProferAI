# Profer Core Headless（Beta）

整个运行目录必须一起保留，不能只复制 `profer-core`。本包无需安装 Bun、Node、Electron 或图形桌面。

## 本机启动

先准备专用数据目录和工作区目录，再通过受控环境注入以下配置：

- `PROFER_CONFIG_DIR`：Core 数据目录，勿指向日常桌面配置。
- `PROFER_CORE_WORKSPACE_ROOT`：本 Core 的工作区根目录。
- `PROFER_CORE_LISTEN`：建议保持 `127.0.0.1:7788`。
- `PROFER_CORE_API_KEY`：自行生成的高强度连接密钥；它不是模型 API Key。

执行 `./profer-core`；前台收到 SIGINT/SIGTERM 后关闭。不要把连接密钥写进命令参数或公开日志。

模型配置与连接鉴权相互独立。自带 API Key 可按 Core 支持的 `PROFER_CORE_CHANNELS_JSON` 或 Provider 环境配置注入，不把正式凭据写入此发行包。商业账号和官方托管渠道不因包名为 Commercial 就自动获得完整 Core 支持，以本批支持矩阵为准。

## 连接与运行

- `/health` 用于存活检查；`/identity` 及业务 HTTP/WS 接口要求连接鉴权。
- 通过现有桌面版的远程内核设置连接。默认回环监听不会直接开放到公网；远程访问使用 SSH 隧道或明确配置的 HTTPS 网关。
- 本包不含 Web 管理界面，不注册服务、不设置开机自启、不调整防火墙。
- `profer-core.service.example` 只是 systemd 用户服务模板，必须改成实际路径并自行配置受限权限的环境文件后使用，不能原样直接启用。
- 配置文件包含凭据时应设为仅所属用户可读写；不要把其他机器的加密桌面凭据直接复制过来。

## 升级与回退

停止本 Core，完整备份数据目录，再替换运行目录；数据与二进制分开保存。回退时同时恢复对应版本的数据备份，不假定旧版能读取新版写入的数据。不要覆盖已有试用或正式服务。

`core-runtime.json` 记录本包 Core 版本、平台和架构。SDK/native/WASM 随包携带；声明支持范围以成品验证清单为准。
