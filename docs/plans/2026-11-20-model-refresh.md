# 2026-11 新模型属性与请求兼容更新

核验日期：2026-11-19（America/New_York）/ 2026-11-20（北京时间）。

## 实施范围

复用 `model-registry.ts` 的已知 SKU 元数据、Codex 目录补丁、共享 reasoning profile 与 context fallback。普通渠道仍从接口发现型号，不向用户渠道强制新增或启用模型。未更改用户渠道文件、未升级 Pi 0.86.1、未提交或发布。

下表价格单位均为 **USD / 1M tokens**，顺序为输入 / 输出 / 缓存读 / 缓存写，采用 Standard 基础价而非最终账单。官方只写 1M/128K 的项目，运行配置按 1,000,000/128,000 保守登记，不据此声称官方给出了精确整数。未知输出上限不借上下文窗口补齐。

| 型号 | 注册上下文 / 输出预算 | 图片 | 基础价格 I/O/CR/CW | 推理能力 |
|---|---:|---|---|---|
| `gpt-6.2-astra` | 1,050,000 / 128,000（官方代管及 Codex） | 是 | 8 / 40 / .4 / 10 | 继承 GPT6 low/medium/high/xhigh/max，不发送 none |
| `gpt-6.2-sol` | 同上 | 是 | 2 / 10 / .1 / 2.5 | 同上 |
| `claude-fable-5-2` | 1,000,000 / 128,000 | 是 | 8 / 40 / .2 / 10 | 始终 adaptive，五档含原生 xhigh，默认 high |
| `claude-opus-5-5` | 1,000,000 / 128,000 | 是 | 4 / 20 / .2 / 5 | 始终 adaptive，五档，默认 medium |
| `claude-sonnet-5-5` | 1,000,000 / 128,000 | 是 | 2 / 10 / .1 / 2.5 | 五档，默认 high；不把 between_tools 伪装成关闭思考 |
| `claude-haiku-5-5` | 1,000,000 / 128,000 | 是 | .1 / .5 / .01 / .125 | 五档，默认 medium；off 发 disabled（服务端默认 effort 在可关闭范围） |
| `gemini-4-carbon` / `gemini-4-argon` | 1,048,576 / 65,536 | 是 | 2 / 10 / .1 / 不适用 | low/medium/high，默认 medium，无 off |
| `gemini-4-hydrogen` | 1,048,576 / 65,536 | 是 | 1.5 / 7.5 / .075 / 不适用 | low/medium/high/xhigh，默认 high，无 off |
| `qwen4-max` | 1,000,000 / 262,144（思考+回答）；off 最多 131,072 | 是 | 未核实，不覆盖已有目录价格 | CC / Anthropic：low/high/xhigh；产品 low/medium/high 对应这三档，可关闭；默认产品 medium=官方 high |
| `qwen4-max-preview` | 1,000,000 / 393,216 | 是 | Token Plan，无按量单价 | low/medium/xhigh，默认 xhigh；不与正式版合并 |
| `glm-5.3-flash` / `glm-5.3-flashx` | 1,000,000 / 128,000 | 是 | .15 / .5 / .03 / 未公布；.37 / 1.25 / .075 / 未公布 | 强制思考，low/high/max；保留原 GLM 家族产品默认 high |
| `mimo-v2.6-pro` | 1,000,000 / 128,000 | 是 | .435 / .87 / .0036 / 未公布 | 只有开关，不发送虚构 effort；保留完整历史 reasoning_content |
| `mimo-v2.6-flash` | 同上 | 是 | .14 / .28 / .0028 / 未公布 | 同上 |
| `mimo-v2.6-pro-ultraspeed` | 同上 | 是 | 4.35 / 8.7 / .036 / 未公布 | 同上；保留配额 SKU，不保证普通账户可用 |
| `kimi-k3.1-pro-highspeed` | 1,048,576 / 131,072 默认预算 | 是 | 4 / 20 / .2 / 4（5m） | 继承 K3 low/high/max，不能关闭 |
| `MiniMax-M3.1-Flash` | 1,000,000 / 官方输出上限未知（目录或 64,000 保守预算） | 是 | .15 / .6 / .015 / 未公布 | 始终思考，low/medium/high/xhigh/max，默认 max |
| `grok-4.7` | 500,000 / 官方输出上限未知（目录或 64,000 保守预算） | 是 | 2 / 6 / .5 / 未公布 | low/medium/high/xhigh，默认 high，无 off |

### 重要边界

- **GPT6.2**：6.2 官方卡明确拒绝 none；完整 effort 枚举沿用现有 GPT6 家族策略，未宣称五档逐项真实 API 实测。未知 GPT 中转不因补属性自动升级到 1.05M；用户 context1m 强开/强关仍优先。
- **价格**：静态 cost 只是基础估价，未实现厂商所有阶梯、地区、峰谷、Fast/Batch、TTL 计费算法。数值字段受 Pi 限制；cacheWrite=0 表示未单列写费/未公布/不适用之一，不等于核验有免费写缓存 API。Qwen 未知价格不覆盖已有目录数据，无目录价格时仍使用旧的零值未知兜底。
- **Gemini 调价**：Carbon/Argon 至 2026-11-30 为 2/10/.1，2026-12-01 起为 4/20/.2；注册时按 UTC 生效日切换。只支持隐式缓存，不声称显式 cache 写入免费。长解码未实现，所以普通同步输出仅登记 65,536。
- **Claude 阶梯/TTL**：Haiku prompt>100,000 时 I/O/CR/CW(5m) 为 .5/2.5/.05/.625；100,000 本身仍低价。表内采用低档基础价。Claude 1h 写缓存不同于表内 5m：Fable 16、Opus 8、Sonnet 4、Haiku .2 或 1。Sonnet 的 between_tools 模式未作为独立产品档位实现，不显示 off。旧 Claude 档位不变。
- **Kimi**：补齐原 `kimi-k3.1-pro` 5m cacheWrite=2；Highspeed=4，1h 分别4/8。131,072 是 K3 家族默认预算；官方允许更大值但受输入+输出共享窗口限制，此处未扩大运行默认。
- **Grok**：prompt>=200,000 时 I/O/CR=4/12/1，US regional 另乘1.1；表内为短上下文标准价。API Key、OAuth 补齐目录及 UI fallback 均使用500K，不再继承4.6的1M。Fast不是公共xAI API新ID，不新增。
- **Qwen**：CC 与 `qwen-anthropic` 路径都验证 effort 和 off 预算。Anthropic 用 enabled + output_config.effort，不发送 Claude adaptive/display。Responses 的关闭协议未获此次精确核验，不新增该 transport 的 profile，未宣称本轮覆盖。Preview 在2026-11-25 24:00 UTC+8退役，仍只在端点提供该ID时按其独立属性处理。
- **可用性**：GLM FlashX 未进入 Coding Plan；MiMo Ultraspeed 需保留配额；没有把这些 SKU 强制加入任何套餐。Mythos/Cyber 等受限型号不加入普通目录。MiMo V2.5退役不擅自迁移用户配置。

## 请求与兼容实现

- Google Chat 改用 thinkingLevel，旧 Gemini2.5仍用thinkingBudget。Pi 的可持久化补丁识别 Gemini4，实际序列化保留 XHIGH。
- Qwen4 正式/Preview 分开 effort 映射；精确正式 ID 的非思考输出在 CC / Anthropic 限131,072，不截断Preview或旧Qwen。
- MiMo 新 SKU 复用 deepseek 格式开关和 reasoning_content 回传，显式 supportsReasoningEffort=false，避免未知网关自动探测后发送不存在的档位参数。完整非空工具历史推理已做离线payload验证。
- profile 编译合并保留 catalog compat；已知 SKU 补充 compat 不抹掉 catalog 其余字段。统一小写/命名空间归一的元数据匹配。
- 原 retry 补丁保留；依赖仍为 Pi0.86.1，冻结安装成功应用补丁，bun.lock无附带修改。

## 官方证据

本轮由研究协作实际读取，父任务追加读取了 Qwen / MiniMax 协议页。仅文档与离线请求核验，没有付费 API 实测。

- OpenAI：[Astra模型卡](https://developers.openai.com/api/docs/models/gpt-6.2-astra.md)、[Sol模型卡](https://developers.openai.com/api/docs/models/gpt-6.2-sol.md)、[6.2发布说明](https://openai.com/index/introducing-gpt-6-2-astra-sol)
- Claude：[Fable5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview)、[Opus5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)、[Sonnet5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、[Haiku5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- Google：[Carbon](https://aistudio.google.com/docs/models/gemini-4-carbon.md)、[Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen.md)、[定价](https://aistudio.google.com/docs/pricing#gemini-4-hydrogen)、[思考档位](https://aistudio.google.com/docs/thinking.md)
- Qwen：[正式模型规格](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen4-max)、[Preview](https://www.alibabacloud.com/help/en/model-studio/qwen4-max-preview)、[Anthropic协议](https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages)
- GLM：[Flash规格](https://docs.z.ai/guides/vlm/glm-5.3-flash)、[价格](https://docs.z.ai/guides/overview/pricing)、[强制思考规则](https://docs.z.ai/guides/capabilities/thinking-mode)
- MiMo：[Pro](https://mimo.mi.com/models/en-US/mimo-v2.6-pro)、[Flash](https://mimo.mi.com/models/en-US/mimo-v2.6-flash)、[Ultraspeed](https://mimo.mi.com/models/en-US/mimo-v2.6-pro-ultraspeed)、[深思与历史回传](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)
- Kimi：[价格](https://www.kimi.ai/resources/kimi-k3-1-pro-pricing)、[模型总览](https://platform.kimi.ai/docs/api/models-overview)、[预算参数](https://platform.kimi.ai/docs/api/chat)、[effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort)
- MiniMax：[正式Flash发布与价格](https://www.minimax.io/blog/minimax-m31f)、[Anthropic协议](https://platform.minimax.io/docs/api-reference/text-anthropic-api)
- xAI：[Grok4.7](https://docs.x.ai/developers/models/grok-4.7)、[价格](https://docs.x.ai/developers/pricing)、[reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)

## 验收

- 离线注册规格、Codex目录、官方/中转差异、用户1M偏好、API Key/OAuth xAI路径。
- 真实 Pi streamSimple/onPayload、Google genai SDK假fetch序列化，覆盖Gemini4 XHIGH、Claude原生xhigh/Haiku disabled、Qwen两协议effort及预算、MiMo非空reasoning_content历史。
- `bun test --isolate packages/agent-provider-pi` 加共享reasoning/context、core相关provider、Electron模型/档位/配置兼容回归：**501 pass，0 fail，46 files**（完整命令及日志保存在本轮会话.context）。
- shared 全包另跑：**240 pass，0 fail，29 files**（与上述存在重叠，不相加为独立总数）；最后上下文及新模型定向复测 **67 pass，0 fail**。
- shared / core / agent-provider-pi / Electron 类型检查通过；`git diff --check`通过。
- 未调用付费接口、未打包、未提交或发布；真实账户授权和网关实现仍由用户端点决定。
