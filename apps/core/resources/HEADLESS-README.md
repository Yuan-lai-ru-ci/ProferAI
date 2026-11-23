# Profer Core Headless（Beta）

整个运行目录必须一起保留，不能只复制 `profer-core`。本包无需安装 Bun、Node、Electron 或图形桌面。

## 本机启动

先准备专用数据目录和工作区目录，再通过受控环境注入以下配置：

- `PROFER_CONFIG_DIR`：Core 数据目录，勿指向日常桌面配置。
- `PROFER_CORE_WORKSPACE_ROOT`：本 Core 的工作区根目录。
- `PROFER_CORE_LISTEN`：建议保持 `127.0.0.1:7788`。
- `PROFER_CORE_API_KEY`：自行生成的高强度连接密钥；它不是模型 API Key。

执行 `./profer-core`；前台收到 SIGINT/SIGTERM 后关闭。不要把连接密钥写进命令参数或公开日志。

模型配置与连接鉴权相互独立。自带 API Key 可按 Core 支持的 `PROFER_CORE_CHANNELS_JSON` 或 Provider 环境配置注入，不把正式凭据写入此发行包。独立本机模式支持由 Core 持有商业账号和官方渠道，具体入口见下文；普通前台模式仍按自配渠道运行。

## 连接与运行

- `/health` 用于存活检查；`/identity` 及业务 HTTP/WS 接口要求连接鉴权。
- 通过现有桌面版的远程内核设置连接。默认回环监听不会直接开放到公网；远程访问使用 SSH 隧道或明确配置的 HTTPS 网关。
- 本包不含 Web 管理界面，不注册服务、不设置开机自启、不调整防火墙。
- `profer-core.service.example` 只是 systemd 用户服务模板，必须改成实际路径并自行配置受限权限的环境文件后使用，不能原样直接启用。
- 配置文件包含凭据时应设为仅所属用户可读写；不要把其他机器的加密桌面凭据直接复制过来。

## 桌面新核优先与旧核兜底

桌面默认使用新 Core；`PROFER_LOCAL_CORE_MODE=independent` 仍为显式独立模式。保留旧桌面执行链，不在运行失败后自动切核或重放任务。

需要旧核排障时，先完全退出桌面并确认同根 Core 已停止，再以 `PROFER_LOCAL_CORE_MODE=legacy` 启动同一版本桌面。旧核在加载业务模块前取得同根执行锁；锁被 Core 占用时拒绝启动，不抢占、不删除锁文件。恢复新核只需完全退出旧核，移除该环境变量后重启。该入口不是设置页的“启用 Core”开关，历史启用配置不影响默认行为。

切核前仍应备份数据。当前版本的隔离旧安装夹具已验证新核→旧核→新核及历史保留；这不意味着任意旧版本二进制可以读取新版写入的数据。

## 升级与回退

停止本 Core，完整备份数据目录，再替换运行目录；数据与二进制分开保存。回退时同时恢复对应版本的数据备份，不假定旧版能读取新版写入的数据。不要覆盖已有试用或正式服务。

`core-runtime.json` 记录本包 Core 版本、平台和架构。SDK/native/WASM 随包携带；声明支持范围以成品验证清单为准。

### 桌面接入独立本机 Core（macOS / Linux；Windows 独立入口仍受平台门禁约束）

先用与桌面相同的配置根启动 Core：

```bash
profer-core --desktop-independent --config-dir "$PROFER_CONFIG_DIR"
```

独立模式默认由系统分配回环端口；也可显式传 `--listen 127.0.0.1:17791`。只有 owner 端口可动态变化，已启用的配对共享入口仍使用原端口。手工运行时用 Ctrl-C 停止；受进程管理器托管时，用该管理器停止对应服务（发送 SIGTERM）。不要根据描述符中的 PID 手工结束进程。

再用同一个 `PROFER_CONFIG_DIR` 和 `PROFER_LOCAL_CORE_MODE=independent` 启动桌面。未设置独立模式的桌面仍使用内置 Core。独立模式接入失败不会启动第二个 writer；可在独立 Core 就绪后从桌面重试。

- 关闭窗口或客户端断开：只断开桌面连接，不停止独立 Core。
- **完全退出 Profer：会通过本机 owner 协议请求 Core 优雅停服，并等待写锁释放。** 此行为也适用于桌面接入之前已经启动的同根独立 Core。不要让外部进程管理器对这份桌面数据根配置自动重启，否则可能在桌面退出后重新拉起 Core；需要外部托管常驻服务时，应使用前述独立数据目录，通过远程内核入口连接，而不是接入桌面同根 owner。
- 使用同一数据根执行 `profer core status --config-dir "$PROFER_CONFIG_DIR"` 只检查、不启动；`profer core stop --config-dir "$PROFER_CONFIG_DIR"` 请求停服并等待写锁释放；`profer core start --config-dir "$PROFER_CONFIG_DIR"` 启动或复用原根的独立 Core。重启保留原 Core 身份、共享端口、配对与历史，不静默回落到内置 Core。

独立模式沿用桌面的 `agent-workspaces/` 与 `agent-workspaces.json`。Core 在监听就绪后发布仅当前用户可读的 `.core-owner.json`（含本机 owner 凭据，请勿复制或共享）；Windows 独立入口当前仍未开放。已有 Core 共享端口与绑定不迁移、不重建，旧 Pocket 服务仍依附桌面。

### 独立 Core 的商业账号

商业桌面接入独立本机 Core 后，仍从原登录入口登录；账号、续期与官方模型目录由本机 Core 管理。Core 重启后恢复账号，桌面不复制旧登录令牌或单轮模型 Key。退出账号只清除官方渠道，保留 Core 自配渠道和会话历史。

账号管理只开放给本机 owner，配对设备不能登录、注销或读取账号凭据。远端设备可在既有授权范围内使用该 Core 的模型。开源桌面的账号入口保持不可用；连接 Core 不会改变发行版身份。
