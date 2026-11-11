# 开源版 CI 打包与签名证书配置

> 2026-11-12 建立。对应工作流：`.github/workflows/oss-package.yml`。
> 商业版不走这条流水线：维护者在自有机器上执行 `dist:mac-commercial` / `dist:win-commercial`，产物落 `out-commercial/`。

## 1. 两套发行版的分工

| 项 | 开源版（OSS） | 商业版 |
|---|---|---|
| 谁来打包 | GitHub Actions（`oss-package.yml`） | 维护者本机（`dist:mac-commercial` / `dist:win-commercial`） |
| 主进程构建目标 | `build:main`（`__PROFER_BUILD_TARGET__="oss"`） | `build:main-commercial` |
| 产物目录 | `apps/electron/out/` | `apps/electron/out-commercial/` |
| 安装包名 | `Profer-<version>-arm64.dmg` / `Profer-Setup-<version>.exe` | `Profer-Commercial-<version>-arm64.dmg` / `Profer-Commercial-Setup-<version>.exe` |
| 更新目录 | `https://profer.cn/profer-updates/oss/` | `https://profer.cn/profer-updates/` |
| 更新源回退 | 国内备用源 → GitHub | 只走商业目录，绝不回退 GitHub |

两个发行版共用 `appId`（`com.profer.app`）与 `productName`（`Profer`），因此**不能在同一台机器上共存**；这是为了让存量用户的自动更新链不断，属于既定取舍。

## 2. 需要配置的 GitHub Secrets

仓库：`Yuan-lai-ru-ci/ProferAI` → Settings → Secrets and variables → Actions。

| Secret | 用途 | 缺失时的行为 |
|---|---|---|
| `OSS_MAC_CSC_LINK` | macOS 代码签名证书（`.p12` 的 base64） | 降级 ad-hoc 签名 + `::warning::` |
| `OSS_MAC_CSC_KEY_PASSWORD` | 上者密码 | 同上 |
| `APPLE_ID` | 公证（notarytool）Apple ID | 跳过公证 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID 专用密码 | 跳过公证 |
| `APPLE_TEAM_ID` | 开发者团队 ID | 跳过公证 |
| `OSS_WIN_CSC_LINK` | Windows Authenticode 证书（`.pfx` base64） | 降级未签名 + `::warning::` |
| `OSS_WIN_CSC_KEY_PASSWORD` | 上者密码 | 同上 |
| `PROFER_UPDATE_METADATA_PRIVATE_KEY` | `latest.yml.sig` 的 RSA 私钥 | 不生成 `.sig`，走 unsigned 校验分支 |
| `PROFER_UPDATE_METADATA_PUBLIC_KEY` | 校验 `.sig` 用公钥 | 与上者同进同退 |

注意：**不要**把上一代 Windows 流水线用的 `WIN_CSC_LINK` 直接复用给开源版——两套发行版应当各自持有证书，避免商业版证书私钥被开源流水线读取。

## 3. 证书准备

### 3.1 macOS：必须是 Apple Developer ID Application

自签名证书**不能**用于发布包：

- `codesign` 读不到 `TeamIdentifier`，`afterSign` 钩子会把它判定为无有效身份，重新签成 ad-hoc；
- 即使强行保留，DR 里没有 `anchor apple generic`，`verify:mac-signature` 会直接失败（这是 2026-11-12 新增的硬门禁）。

只有 Apple Developer Program（个人/组织，99 USD/年）签发的 **Developer ID Application** 证书可用。

导出步骤（在持有证书的 Mac 上）：

```bash
# 钥匙串访问 → 我的证书 → 找到 "Developer ID Application: <Name> (<TEAMID>)" → 导出为 .p12（设密码）
# 转成单行 base64（GitHub Secret 只能是单行文本）
base64 -i DeveloperID.p12 | tr -d '\n' > developerid.b64
gh secret set OSS_MAC_CSC_LINK --repo Yuan-lai-ru-ci/ProferAI < developerid.b64
gh secret set OSS_MAC_CSC_KEY_PASSWORD --repo Yuan-lai-ru-ci/ProferAI
```

公证凭据（三件套必须同时存在才会开启）：

```bash
gh secret set APPLE_ID --repo Yuan-lai-ru-ci/ProferAI                       # 开发者账号邮箱
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo Yuan-lai-ru-ci/ProferAI    # appleid.apple.com 生成的专用密码
gh secret set APPLE_TEAM_ID --repo Yuan-lai-ru-ci/ProferAI                  # 10 位团队 ID
```

### 3.2 Windows：Authenticode 证书

- OV/EV 代码签名证书（`.pfx`）。自签名证书只会让 SmartScreen 继续提示"未知发布者"，但 `Get-AuthenticodeSignature` 会返回 `UnknownError`，`verify:release-assets` 会失败——所以要么给真证书，要么走 unsigned 分支。
- EV 证书通常要求硬件令牌，云端 CI 需要 HSM/云签名服务；本工作流当前只支持 `.pfx` 直传，接 EV 需要另做（属于后续工作）。

```bash
base64 -i codesign.pfx | tr -d '\n' > codesign.b64   # macOS 上的写法
gh secret set OSS_WIN_CSC_LINK --repo Yuan-lai-ru-ci/ProferAI < codesign.b64
gh secret set OSS_WIN_CSC_KEY_PASSWORD --repo Yuan-lai-ru-ci/ProferAI
```

### 3.3 更新元数据签名密钥

```bash
# 生成（只做一次，公钥会进仓库，私钥只进 Secret）
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out update-metadata-private.pem
openssl rsa -pubout -in update-metadata-private.pem -out update-metadata-public.pem
gh secret set PROFER_UPDATE_METADATA_PRIVATE_KEY --repo Yuan-lai-ru-ci/ProferAI < update-metadata-private.pem
gh secret set PROFER_UPDATE_METADATA_PUBLIC_KEY --repo Yuan-lai-ru-ci/ProferAI < update-metadata-public.pem
```

## 4. 运行工作流

```bash
gh workflow run oss-package.yml --repo Yuan-lai-ru-ci/ProferAI \
  -f ref=main -f publish=false

gh run list --repo Yuan-lai-ru-ci/ProferAI --workflow oss-package.yml --limit 3
```

- `publish=false`（默认）：只上传 Actions Artifact（保留 14 天），不产生任何外部副作用。
- `publish=true`：额外把产物上传到**已存在**的 `v<version>` GitHub Release；工作流不会创建 Release，也不会推国内更新源。
- 国内更新源（`/oss/` 目录）的上传目前仍由 `push-mac-release.cjs` / `push-release.cjs` 完成，不由 CI 触发。

## 5. 签名模式断言

CI 会按「是否提供证书」设置 `PROFER_EXPECT_MAC_SIGNATURE_MODE`：

- 有 `OSS_MAC_CSC_LINK` → 期望 `developer-id`；
- 无证书 → 期望 `adhoc`。

产物签名模式与期望不符时构建失败。这条断言专门拦截"看起来配了证书、实际还是 ad-hoc"的静默降级。

## 6. 从 ad-hoc 迁到 Developer ID 的代价

同一发行版一旦以某种签名形态发布，DR 就固定了：

- ad-hoc：DR = `identifier "com.profer.app"`；
- Developer ID：DR = `identifier "com.profer.app" and anchor apple generic and certificate leaf[subject.OU] = "<TEAMID>"`。

两者互不满足。开源版目前**还没有对外发布过**，现在切到 Developer ID 不需要迁移成本；一旦对外发过 ad-hoc 版本，再切就需要老用户手动重装一次。商业版同理，且它已经在 ad-hoc 上发布了 0.15.78 ~ 0.16.25，切 Developer ID 会让存量用户必须手动重装——这是商业版签名决策必须先算清的账。
