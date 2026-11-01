# Release Notes

本目录存放 Profer 的版本发布说明与更新源数据。

## 文件说明

| 文件 | 用途 | 维护方式 |
|------|------|---------|
| `vX.Y.Z.md` | 单版本发布说明 | **手写**，发版前创建 |
| `releases.json` | 商业版「版本历史」数据源 | **自动生成**，`bun run release:releases-json` |

## `vX.Y.Z.md` 约定

- 文件名必须与 git tag 严格一致：tag `v0.16.0` → `release-notes/v0.16.0.md`。
- 内容为 Markdown，面向 GitHub Release 正文；首个标题建议 `# Profer vX.Y.Z`。
- 章节建议：`## 新功能` / `## 修复` / `## 数据保护` / `## 升级提示`（按需取用）。
- **它是发版流程的活跃输入**：`scripts/push-release.cjs`（Windows）与
  `scripts/push-mac-release.cjs`（macOS）在创建 GitHub Release 时都会读取
  `release-notes/<tag>.md` 作为 `--notes-file`；文件不存在时回退为 `--generate-notes`（自动生成）。

因此：新增版本时**必须同步补齐本目录的 `vX.Y.Z.md`**，否则该次发布只能回退到自动生成的简略说明。

## 覆盖状态

- 已收录：`v0.7.1` ~ `v0.15.57`（21 篇，历史不连续）。
- **缺口**：`v0.15.57` 之后到当前最新 tag（`v0.16.8`）之间的版本说明均未补写，
  这些发布当时回退到了 `--generate-notes`。补写时以 `releases.json` 中对应 tag 的 `body` 为准。

## `releases.json` 生成

```bash
bun run release:releases-json            # 仅生成到 release-notes/releases.json
bun run release:releases-json -- --upload  # 生成并上传到更新服务器
```

数据来源为 GitHub Releases，草稿剔除、预发布保留并带 `prerelease` 标记，按发布时间倒序。
详见 `scripts/build-releases-json.cjs` 头部注释。
