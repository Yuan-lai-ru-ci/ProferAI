# Profer Windows 执行能力验收指南

> 适用范围：P0 ShellSnapshot、P1 ProcessHandle / PowerShell 统一执行契约、P2 Pi 后台任务输出与停止。
>
> 建议环境：Windows 10/11 x64、PowerShell 5.1 或 PowerShell 7、Bun、Node.js、Git；Git Bash 和 WSL 测试按机器实际安装情况执行。

## 1. 验收原则

- 不执行 `git reset`、`git clean`、`git checkout`、`git stash`，不覆盖已有 WIP。
- Windows-only 测试必须在 Windows 真机运行；macOS/Linux 上的 `skip` 不能记为通过。
- 不在报告、截图或命令行中写入 API key、token、密码或带凭据的代理 URL。
- 先做源码/自动化验收，再做 GUI 和打包版验收。

## 2. 环境准备

```powershell
cd C:\profer\profer-main

git status -sb
git diff --check
git rev-parse --short HEAD

bun --version
node --version
git --version
$PSVersionTable
```

检查 Windows 系统组件：

```powershell
$env:SystemRoot
Test-Path "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
Test-Path "$env:SystemRoot\System32\taskkill.exe"
```

预期两个 `Test-Path` 都为 `True`。

检查 Git Bash：

```powershell
where.exe bash
bash --version
```

如未加入 PATH，可检查常见路径：

```powershell
@(
  "$env:ProgramFiles\Git\bin\bash.exe",
  "$env:ProgramFiles\Git\usr\bin\bash.exe",
  "${env:ProgramFiles(x86)}\Git\bin\bash.exe"
) | ForEach-Object {
  [PSCustomObject]@{ Path = $_; Exists = Test-Path $_ }
}
```

检查 WSL：

```powershell
wsl.exe --status
wsl.exe --list --verbose
wsl.exe -e bash -lc "printf 'wsl-ok\n'; command -v bash; command -v tr"
```

没有安装 WSL 时，记录为“WSL 未验证”，不要记为产品失败。

建议隔离测试配置：

```powershell
$env:PROFER_CONFIG_DIR = "C:\profer\test-config\execution-acceptance"
New-Item -ItemType Directory -Force $env:PROFER_CONFIG_DIR | Out-Null
Remove-Item Env:PROFER_PI_HARNESS -ErrorAction SilentlyContinue
```

## 3. 源码自动化验收

```powershell
cd C:\profer\profer-main\apps\electron
bun install --frozen-lockfile
```

### P0 ShellSnapshot

```powershell
bun test --isolate ./src/main/lib/shell-snapshot.test.ts
```

应验证：

- 同一 `sessionId + cwd + shell descriptor` 可复用快照；
- `envHash` 稳定，rebuild 后能改变；
- 至少探测 `bash`、`sh`、`bun`、`node`、`git`、`tr`；
- 敏感变量、代理凭据不落盘；
- 快照写入失败不阻断普通执行。

### P1 ProcessHandle 与 ExecutionService

```powershell
bun test --isolate ./src/main/lib/process-handle.test.ts
bun test --isolate ./src/main/lib/execution-service.test.ts
```

应验证 `shellPid` 与实际 `pid` 分离、`startTime` 保留、完成句柄可查询，以及 `cancel(handleId)` 能触发底层 AbortSignal。

### PowerShell 统一结果

```powershell
bun test --isolate ./src/main/lib/adapters/pi-powershell-tool.test.ts
```

Windows 真机上，以下测试不应再 skip：

- 原生 stdout；
- stderr 与非零 exit code；
- timeout；
- abort。

### Pi Bash / WSL / registry / routing

```powershell
bun test --isolate `
  ./src/main/lib/adapters/pi-agent-bash.test.ts `
  ./src/main/lib/runtime-process-registry.test.ts `
  ./src/main/lib/process-monitor.test.ts `
  ./src/main/lib/adapters/runtime-routing-agent-adapter.test.ts
```

### P2 后台任务

```powershell
bun test --isolate `
  ./src/main/lib/pi-background-task-manager.test.ts `
  ./src/main/lib/background-task-manager.test.ts
```

应验证：

- `sessionId + taskId` 隔离；
- stdout/stderr 输出 tail；
- block 查询等待终态；
- registry record 可恢复任务句柄；
- `TaskStop` 只允许停止同 session、已确认 `pid + startTime` 的 Pi shell 服务；
- 短命命令不进入后台任务 registry。

### 全量回归、类型检查与构建

```powershell
bun test --isolate
bun run typecheck
bun run build:main

cd C:\profer\profer-main
git diff --check
```

## 4. Windows 原生命令验收

### PowerShell 绝对路径

```powershell
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
& $ps -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -Command "[Environment]::OSVersion.Platform"
```

预期为 `Win32NT`。将 PATH 临时缩减后仍应可执行，证明 Profer 使用 SystemRoot 下的绝对路径而不是任意 PATH 命令：

```powershell
$oldPath = $env:Path
$env:Path = "$env:SystemRoot\System32"
& $ps -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -Command "'powershell-absolute-path-ok'"
$env:Path = $oldPath
```

### stdout、stderr 与非零退出

```powershell
& $ps -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -Command "[Console]::Out.WriteLine('stdout-marker'); [Console]::Error.WriteLine('stderr-marker'); exit 7"
$LASTEXITCODE
```

应同时看到两个 marker，退出码为 `7`；非零退出不能被归类为 `spawn_error`。

### timeout / abort / taskkill

```powershell
$p = Start-Process -FilePath $ps -ArgumentList @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-Command', 'Start-Sleep -Seconds 60'
) -PassThru
Start-Sleep -Seconds 2
taskkill.exe /PID $p.Id /T /F
```

产品内点击 Agent 停止按钮时，应确认：命令结束、子进程树被终止、registry 不留下 active-looking record，且不影响其他 session。

## 5. Git Bash 与 WSL 验收

### Git Bash

在 Git Bash 中：

```bash
cd /c/profer/profer-main
printf 'git-bash-ok\n'
command -v bash
command -v sh
command -v tr
command -v git
pwd
```

在 Profer 中启动长期服务，例如：

```bash
bun run dev -- --port 5177
```

确认状态按以下顺序变化：

```text
pending -> shellPid -> process monitor 确认 pid/startTime -> running
```

### WSL

```powershell
wsl.exe -e bash -lc "cd /mnt/c/profer/profer-main && pwd && printf 'path-conversion-ok\n'"
```

在 Profer 的 WSL runtime 中启动服务，例如：

```bash
cd /mnt/c/profer/profer-main
bun run dev -- --port 5178
```

确认：

- Windows 路径转为 `/mnt/c/...`；
- launcher 识别为 `wsl.exe`；
- Linux 子进程不被当成 PowerShell 进程；
- WSL task 的 TaskOutput/TaskStop 只作用于当前 task；
- Git Bash 与 WSL 不共用错误 snapshot。

## 6. Pi / Claude / Harness 端到端验收

### Pi

在 GUI 中确认：

1. 普通文本回复、session JSONL persistence、completion 正常；
2. `printf stdout; printf stderr >&2; exit 7` 保留 stdout/stderr/exitCode；
3. `sleep 60` 设置短 timeout 后能终止并 settle；
4. 点击停止可终止 abort；
5. 长命服务可查询 TaskOutput、执行 TaskStop；
6. 错误 session/task 不会跨会话读取或停止。

### Claude

使用 Claude runtime 重复普通文本、工具、后台任务、TaskOutput、TaskStop 和停止操作，确认 Claude 仍使用自己的 SDK process lifecycle、权限链和后台任务管理器，不被 Pi 的 `/bin/bash`、Pi registry 或 Pi task manager 接管。

### Harness

默认开启。直接启动 Pi turn，确认 Harness 创建 Goal/Turn/sidecar/graph focus，并且只观察当前 Pi turn，不能自动重试、修复或启动下一轮 Agent。

需要回退时，按进程显式关闭：

```powershell
$env:PROFER_PI_HARNESS = '0'
```

测试后清除覆盖：

```powershell
Remove-Item Env:PROFER_PI_HARNESS -ErrorAction SilentlyContinue
```

## 7. 可选打包验收

仅做本地无签名验证时，在 Windows 主机执行：

```powershell
cd C:\profer\profer-main\apps\electron
bun run verify:packaging-host:win
bun run release:verify:windows:unsigned
```

重点确认：打包应用能启动、Pi SDK native runtime 存在、Pi Bash/PowerShell/后台任务可用、snapshot 写入正确配置目录。未实际执行打包版时，不要在报告中写“打包版通过”。

## 8. 报告模板

```text
# Profer Windows 执行能力验收报告

日期：
Windows 版本/架构：
PowerShell：
Bun / Node / Git：
WSL / Git Bash：
Profer commit：

自动化测试：
全量测试：
typecheck：
build:main：
git diff --check：

Git Bash：
WSL：
PowerShell stdout/stderr/non-zero：
PowerShell timeout/abort/taskkill：
Pi 普通执行：
Pi TaskOutput/TaskStop：
Claude 链：
Harness 默认开启 / `PROFER_PI_HARNESS=0` 显式关闭：
打包版：

通过：
失败：
跳过：
未验证：
潜在风险：
```

## 9. 通过标准

```text
自动化测试 0 fail；
typecheck、main build、git diff --check 通过；
Windows-only PowerShell 测试在 Windows 上实际执行而不是 skip；
Git Bash、WSL、PowerShell descriptor 不互相污染；
Pi 普通执行、timeout、abort、TaskOutput、TaskStop 正常；
Claude 原有链路正常；
Harness 默认开启且不接管执行；可用 `PROFER_PI_HARNESS=0` 按进程关闭；
旧 startTime 不能停止已变化或已退出的进程。
```
