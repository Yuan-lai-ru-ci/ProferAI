---
name: user-sense
description: Profer 内置的"用户感知"默认 Skill，开箱即用。目标是通过首次扫描本地环境（系统信息、已安装应用、文件类型统计、最近打开文件、浏览器书签分类）构建"本地用户画像"，让 Profer 懂用户的工作性质、作息习惯与兴趣方向，从而提供个性化对话和主动服务（Proactive Center）。当用户是新工作区首次使用、画像文件不存在或明显过期（>30 天）、用户提到"更懂我""记住我的偏好/习惯/工作性质""Proactive Center""个性化推荐"，或对话语境需要理解用户身份（开发者/科研/办公/娱乐）时触发。触发后先检查画像是否存在，再决定是构建、更新还是仅消费画像；构建画像前必须向用户说明扫描范围并征得同意，未经同意不得扫描。
group: profer
version: "1.0.1"
---

# UserSense（用户感知）

Profer 默认 Skill，随应用分发，所有用户开箱即用。职责：**构建、维护、消费本地用户画像**。

画像 = 对用户工作性质、作息、兴趣的**推断结论**（如"活跃时段集中在凌晨""工具以开发类为主""近期有论文阅读活动"），存放在工作区 `workspace-files/.context/memory-archive/user-profile.md`。

## 隐私硬约束（必须先于一切）

1. **本地处理**：所有扫描在用户本机完成，画像结论**不上传服务端**。
2. **结论入库，原文不留**：画像只记录推断结论，**绝不记录**具体文件路径、文件名、站点 URL。
3. **先同意后扫描**：首次构建画像前，向用户说明将扫描的范围（系统信息/已安装应用/文件类型统计/最近打开文件/浏览器书签分类），说明"不收集文件内容、不离开本机"，征得同意后才执行。
4. **用户可控**：告知用户画像可在能力中心查看、编辑、按来源关闭、一键清空；关闭某来源后不再采集该来源。
5. 用户明确拒绝时，跳过构建，直接进入会话，不反复劝说。

## 触发与决策

触发本 Skill 后按以下顺序决策：

1. 读取画像文件（`workspace-files/.context/memory-archive/user-profile.md`，注意区分 `manual` 与 `auto` 块）
2. 画像不存在 → 向用户说明扫描范围并征得同意，同意后执行"首次构建"
3. 画像存在但 `updated` 超过 30 天 → 提议增量更新（不强制）
4. 画像存在且新鲜 → 直接消费（在对话中运用画像信息，不重复扫描）

## 首次构建画像流程

按 L0→L4 顺序执行，每层只做统计、只写结论。以下为 Windows 平台的命令参考：

### L0 系统与作息
```powershell
# 系统信息（OS/架构/语言/时区）
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSLanguage, MUILanguages
Get-TimeZone | Select-Object Id
# 作息模式：统计本机 Agent 会话文件（~/.profer/agent-sessions/*.jsonl）创建时间的时段分布
Get-ChildItem "$env:USERPROFILE\.profer\agent-sessions" -Filter *.jsonl -ErrorAction SilentlyContinue |
  ForEach-Object { (Get-Date $_.CreationTime).Hour } | Group-Object | Sort-Object Count -Descending | Select-Object -First 3 Name, Count
```
结论示例：`活跃时段集中在凌晨 1-5 点（来源：系统/会话历史，置信度：中）`。

### L1 已安装应用
```powershell
# 注册表 Uninstall 键（HKLM 64/32 位 + HKCU），去重后按 DisplayName 统计
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*, HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*, HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* -ErrorAction SilentlyContinue |
  Where-Object DisplayName | Select-Object -ExpandProperty DisplayName | Sort-Object -Unique
```
结论示例：`安装有 VS Code/JetBrains 等开发工具，推断为开发者（来源：应用，置信度：高）`。分类维度：开发 / 办公 / 设计 / 娱乐 / 游戏 / 通讯。

### L2 文件类型统计
```powershell
# 统计用户目录下常见目录的扩展名分布（只数数量，不列文件名）
Get-ChildItem "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Desktop" -File -Recurse -Depth 1 -ErrorAction SilentlyContinue |
  Group-Object Extension | Sort-Object Count -Descending | Select-Object -First 8 Name, Count
```
结论示例：`近期下载以 PDF 为主（30+），推断有论文/文档阅读活动（来源：文件，置信度：中）`。**绝不记录任何文件名或路径**。

### L3 最近打开文件
```powershell
# Windows Recent 目录（.lnk 快捷方式），只按扩展名统计，不解析目标路径
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Recent" -Filter *.lnk -ErrorAction SilentlyContinue |
  ForEach-Object { $_.BaseName -replace '.*\.', '.' } | Group-Object | Sort-Object Count -Descending | Select-Object -First 6 Name, Count
```
结论示例：`近期频繁处理 .xlsx，推断为运营/数据场景（来源：最近文件，置信度：中）`。

### L4 浏览器书签分类（默认开启）
```powershell
# Chrome/Edge 书签 JSON，只统计顶层文件夹 children 数量与名称分类，不输出站点 URL
$paths = @("$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Bookmarks", "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Bookmarks")
foreach ($p in $paths) {
  if (Test-Path $p) {
    $bookmarks = Get-Content $p -Raw | ConvertFrom-Json
    $bookmarks.roots.bookmark_bar.children | Where-Object type -eq 'folder' | Select-Object -ExpandProperty name
  }
}
```
结论示例：`书签分类以视频/游戏/学习类为主，推断对娱乐内容有稳定兴趣（来源：书签，置信度：中）`。**只写分类占比，不写具体站点**。

## 画像文件格式规范

更新 `workspace-files/.context/memory-archive/user-profile.md`，遵守：

1. 自动结论写入 `## 自动画像（auto）` 区块，手工内容（`## 用户画像` 等原有区块）不动，标注为 `manual`
2. 每条结论格式：`- **<结论>**（来源：<系统/应用/文件/最近文件/书签>，置信度：<高/中/低>，时间：YYYY-MM-DD）`
3. frontmatter 更新 `updated: YYYY-MM-DD`
4. 相同结论已有且未过期（<30 天）则不重复写入
5. 用户在某能力中心关闭了来源，则该来源一律不再扫描、不再写入

## 画像的消费方式

- **对话个性化**：任务相关时引用画像信息（如科研用户推荐论文精读流程、开发者用户默认代码规范语境），但**不主动输出画像内容**，除非用户询问
- **主动服务对接**：画像信号是 Proactive Center 的输入（深夜活跃→建议工作模式、PDF 堆积→提醒整理/精读、频繁切项目→推荐快捷切换），发现匹配信号时可向用户提出建议
- **画像过期/变化**：用户行为明显变化（如新增大量设计工具）时，可提议增量更新，不擅自扫描

## 边界

- 不采集浏览器历史、聊天记录、密码、Cookie；只做书签**分类**统计
- 不做任何上传、不做远程分析
- 用户拒绝或关闭后，尊重选择，不反复询问
- 本 Skill 是流程定义，主进程 ProfileScanner（更快更全面的原生扫描）作为后续增强，实现后自动接管采集，本 Skill 的消费与维护规范不变
