# 模型推理档位能力矩阵（2026-10）

## 问题

旧实现把「模型 → 推理档位」写成 `resolveReasoningProfile` 里的一串型号硬编码：

```ts
modelId.startsWith('gpt-5') || modelId === 'gpt-6-astra' || /^(o1|o3|o4)/.test(modelId)
  ? (modelId === 'gpt-6-astra' ? ASTRA : /^gpt-5\.6/ ? MAX : STANDARD)
  : modelId === 'glm-5.3' ? ...
```

后果有三类：

1. **同族新 SKU 静默掉档**：`gpt-6.1-sol`、`glm-5.3-flash`、`grok-4.7`、`kimi-k3.1-pro`
   都不在匹配表里，界面退回 Claude 的 low/medium/high/max，运行时也不再注入任何
   reasoning 参数（用户看到的档位与实际请求脱节）。
2. **档位与官方能力不符**：GLM-5.3 被当成「思考开关」，只给 off/high；官方实际是
   `reasoning_effort: low/high/max` 且**不允许关闭思考**。Kimi K3 给了 off，
   但 K3 始终思考。Grok 给了 off，xAI 当前模型也始终思考。
3. **catalog 兼容位被覆盖**：命中 profile 时 `compat` 直接取 profile 的值，丢掉 catalog 的
   `thinkingFormat`、`requiresReasoningContentOnAssistantMessages` 等上游字段
   （Kimi K3 多轮必须回传 `reasoning_content`，丢了会直接报错）。

## 设计

四层，各自单一职责：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 家族 tag | `packages/shared/src/types/reasoning-model-tag.ts` | 模型 ID → 能力家族；**前缀 + 最低版本**代际规则，同族新版本自动继承 |
| 档位 profile | `packages/shared/src/types/reasoning-profile.ts` | 每个 tag 的可用档位、默认档、档位 → provider 请求值 |
| SKU 元数据 | `packages/agent-provider-pi/src/pi/model-registry.ts` | catalog 未收录的新型号补齐窗口 / 输出 / 价格 / 图片能力 |
| 请求兼容位 | 同上 | catalog `compat` 与 profile `compat` **合并**，profile 只覆写它明确知道的字段 |

`resolveReasoningProfile` 现在只做两件事：查 tag、确认该 transport 有已验证编码。
未打标返回 `undefined`，由 Pi catalog 元数据兜底——不再猜档位。

`ReasoningEncodingKind` 新增两种：

- `provider-toggle`：只有 thinking 开关的模型（Kimi K2.6、MiMo、旧 GLM、Qwen3.x）。
  请求格式沿用 catalog 的 `thinkingFormat`，profile 只声明「off / 高」两档。
- `qwen-thinking-effort`：Qwen 的 `enable_thinking` + `reasoning_effort` 组合。

## 能力矩阵

档位使用 Profer 产品档位（off/minimal/low/medium/high/xhigh/max）；
「实际请求值」是发送给 provider 的值，界面据此显示「所选档位 → 实际强度」。

### OpenAI

| 家族 / 型号 | 档位 | 实际请求值 | 备注 | 来源 |
| --- | --- | --- | --- | --- |
| GPT-6 代际（gpt-6-astra、**gpt-6.1-sol**、后续 6.x） | low / medium / high / xhigh / max | 同名 effort | 取消 `none` 与 `minimal`，默认 medium；1.05M 上下文 / 128K 输出 | [GPT-6.1 Sol 模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |
| GPT-5.6 系列（sol/terra/luna） | off / low / medium / high / xhigh / max | off→none，其余同名 | 5.6 起新增 max | Pi catalog `openai.json` |
| GPT-5.0–5.5、o1/o3/o4 | off / low / medium / high / xhigh | off→none，minimal→low | 具体可用档位由 catalog 收窄（o 系列只有 low/medium/high，gpt-5-pro 只有 high） | Pi catalog + OpenAI 模型页 |
| `*-chat-latest`、gpt-4.x | 无档位 | — | 非推理变体，显式排除 | Pi catalog |

### Anthropic

| 家族 | 档位 | 实际请求值 | 备注 |
| --- | --- | --- | --- |
| Claude 5.x（Haiku/Sonnet/Opus/Fable）、Opus 4.7/4.8、Mythos Preview | off / minimal / low / medium / high / xhigh / max | off→省略字段，minimal→low，xhigh→max | 只接受 adaptive，旧版 budget 会 400 |
| Claude 4.6 及更早 | 由 catalog 决定 | — | 4.6 走 adaptive（catalog 标记），4.5 及以下走 manual |

### DeepSeek

| 型号 | 档位 | 实际请求值（Anthropic `output_config.effort`） | 备注 |
| --- | --- | --- | --- |
| deepseek-flash（含 `deepseek-v4-flash`、`deepseek-v4.1-flash`、带日期变体） | off / low / high / max | low→low，high→high，max→max | V4.1 Flash，原生图片；产品「更高」与「高」同值，不再单列 |
| deepseek-v4-pro（含 `deepseek-pro`、`-0813`） | off / high / max | high→high，max→max | Pro 官方只有 high / max，产品「低」「更高」都会落到同一个值，因此不单列 |

DeepSeek 官方只有 **low / high / max 三个 effort 值** + 思考开关（off）。产品档位只保留
能产生不同请求值的那些，避免界面出现「选不同档位、实际发同一个值」。

第三方网关（如 qwen-token-plan）自己的 `deepseek-v4.1-flash` 条目优先于归一后的官方 ID，
否则会把网关需要的 `thinkingFormat=qwen` 换成 DeepSeek 的 `thinking` 协议。

来源：[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、Pi catalog `deepseek.json`。

### Kimi

| 型号 | 档位 | 实际请求值 | 备注 | 来源 |
| --- | --- | --- | --- | --- |
| kimi-k3 / **kimi-k3.1-pro**（含 highspeed、k3-256k、kimi-for-coding） | low / high / max | low→low，medium/high→high，xhigh/max→max | 思考始终开启（off 不发送 thinking 字段）；默认 max，Profer 默认 high | [K3.1 Pro 快速开始](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)、[Reasoning Effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort) |
| kimi-k2.7-code（含 highspeed） | 高（唯一档） | thinking.type=enabled | 只接受 enabled，传 disabled 会报错 | [Thinking Models](https://platform.kimi.ai/docs/guide/use-thinking-models) |
| kimi-k2.6 | off / high | thinking.type enabled/disabled | 可关闭思考 | 同上 |
| kimi-k2.5 及更早 | 由 catalog 决定 | — | 官方已弃用 | [Model List](https://platform.kimi.ai/docs/models) |

K3.1 Pro 的 SKU 数据（catalog 尚未收录）：上下文 1M、默认输出 131072（最大 1048576）、
价格 $2 / $10、缓存命中 $0.20，支持图片（仅 base64 / `ms://`，不支持公网 URL）。

### 智谱 GLM

| 型号 | 档位 | 实际请求值 | 备注 | 来源 |
| --- | --- | --- | --- | --- |
| GLM-5.3 / 5.3-flash / 5.3-highspeed | low / high / max | low→low，medium/high→high，xhigh/max→max | **思考强制开启**，`thinking.type=disabled` 不再支持 | [GLM-5.3 文档](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[Z.AI Deep Thinking](https://docs.z.ai/guides/capabilities/thinking) |
| GLM-5.2 / 5.2-highspeed | off / high / max | low/medium/high→high，xhigh/max→max | 可关闭思考 | 同上 |
| GLM-4.x / 5-turbo | off / high | thinking 开关 | 只有开关，没有 effort | Pi catalog `zai.json` |

### xAI Grok

| 型号 | 档位 | 备注 | 来源 |
| --- | --- | --- | --- |
| grok-4.6 及之后（含 4.7） | low / medium / high / xhigh | 始终推理，无 off；官方无 max | [xAI Grok 4.6](https://x.ai/news/grok-4-6-vertex-ai) |
| grok-4.5 | low / medium / high | 最高到 high | 同上 |
| grok-4.3 | off / low / medium / high | 可关闭思考 | Pi catalog `xai.json` |

### 阿里 Qwen

| 型号 | 档位 | 实际请求值 | 备注 | 来源 |
| --- | --- | --- | --- | --- |
| qwen3.8 系列 | low / medium / high | low→low，medium→medium，high→xhigh | 官方档位 low/medium/xhigh，默认 xhigh；catalog 标记 off 不可用 | [Qwen3.8 实践指南](https://www.alibabacloud.com/blog/qwen3-8-27b-practical-guide-control-reasoning-depth-and-extend-context-to-1m-tokens_603509) |
| qwen3.0–3.7 | off / high | enable_thinking 开关 | 没有 effort | Pi catalog `qwen-token-plan.json` |

### 小米 MiMo

| 型号 | 档位 | 备注 | 来源 |
| --- | --- | --- | --- |
| mimo-v2.5 / v2.5-pro / v2.5-pro-ultraspeed | off / high | `thinking.type` 开关，默认开启 | [MiMo 深度思考](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking) |

### 明确交给 catalog 的家族

- **MiniMax M2.7 / M3**：Anthropic 协议，catalog 没有档位表；M3 可关思考、M3.1 只接受
  adaptive，厂商行为还在变动，Profer 不写死档位。
- **Claude 4.6 及更早**：catalog 已带 `forceAdaptiveThinking` 或走 manual budget。
- **已弃用 / 非 chat 模型**：kimi-k2.5、deepseek-v3.2、gpt-realtime-*。

这些在 `packages/agent-provider-pi/src/pi/model-family-coverage.test.ts` 里是显式豁免，
新增家族要么进 tag 表，要么进豁免清单，不会再有「悄悄没档位」的第三种状态。

## 验证

- `packages/shared/src/types/reasoning-profile.test.ts`：每个家族的档位、变体继承、
  gpt-6.1-sol / kimi-k3.1-pro / glm-5.3-* / grok-4.7 / qwen3.8 / mimo 的映射。
- `packages/agent-provider-pi/src/pi/model-family-coverage.test.ts`：扫描 Pi catalog
  全部推理模型，断言已建代际规则的家族没有漏标。
- `apps/electron/src/main/lib/adapters/pi-model-registry.test.ts`：新 SKU 的窗口 / 输出 /
  价格 / 档位表，以及 catalog compat 合并不丢 `requiresReasoningContentOnAssistantMessages`。
- `bun run typecheck`（全 workspace）+ 上述测试。

## 已知取舍

- **产品默认档仍是 high**：厂商默认值各不相同（GPT-6 medium、Kimi K3 max、Qwen xhigh），
  Profer 统一以 high 作为「未显式选择」时的默认，避免同一设置在不同模型上跳变；
  界面会显示「所选档位 → 实际请求值」，差异对用户可见。
- **GPT-6.1 Sol 只在官方代管渠道按 1.05M 注册**：自建网关仍按保守 200K，避免把官方规格
  当成任意网关的能力假设。
- **GLM-5.3 的 Anthropic 端点仍走 manual budget**：智谱 coding plan 的 Anthropic 兼容层
  没有公开 `output_config.effort` 说明，保持原行为，只在 OpenAI 协议侧启用 effort。
