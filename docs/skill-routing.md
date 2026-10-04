# Skill 路由与门禁

本轮实现采用“可用范围”和“任务推荐”分离：预设/依赖过滤先行，任务匹配只决定主动提供哪些正文，不删除未被推荐的合法目录，不扩大权限。Claude 与 Pi 消费同一份策略投影和 slug 清单。

## 运行路径

1. `prepareRuntimeSkills` 合并全局/工作区启用状态与覆盖，得到内容指纹投影。
2. `createSkillRoutingSnapshot` 按冻结的 `EffectiveAgentPresetPolicy` 白名单、工具组、单工具、MCP 和实际工具清单筛选。
3. `preparePolicyRuntimeSkills` 创建该策略独立子投影，仅复制合法目录；投影 `name` 使用唯一目录 slug，用户源文件保持原样。
4. `routeSkillsForTask` 先解析本条消息的显式引用，再推荐最多 3 个匹配项。首轮/运行中追加消息共用同一冻结快照。
5. Claude `skills` 和 Pi `skillSlugs` 使用同一清单。Pi 原生二次 `/skill:` 展开关闭，避免扫描历史或重复注入。

队列同时等待 Skill 快照与 Runtime 注册完成；setup 失败/停止会释放等待，不允许回退到其他 Runtime。

## 自定义 Skill 路由

> `profer-routing.json` 已弃用：启动时会自动迁入 SKILL.json（迁移前后生效规则一致才删除侧车）；迁不了的原样保留并继续兼容读取。新 Skill 请直接写 SKILL.json。

旧格式参考（Skill 目录下的 `profer-routing.json`）：

```json
{
  "keywords": ["季度核算", "invoice audit"],
  "excludeKeywords": ["不要核算"],
  "requiredTools": ["mcp__reports-prod__fetch_report"],
  "requiredMcpServers": ["reports-prod"],
  "requiredToolGroups": ["web"]
}
```

所有字段都是字符串数组（`keywords` 已弃用，见下节）。排除关键字优先；英文单词关键字按单词边界匹配。`requiredTools` 全名精确匹配原始 MCP 身份；短名只有唯一匹配时才可通过，推荐使用全名。依赖工具组使用 shared capability registry 中的组 ID。缺少/禁用依赖时不加载 Skill；路由配置无效也会安全跳过并记录诊断。

依赖声明不会启用 MCP、工具或预设。`allowed-tools` 是 Skill 的允许工具声明，不视作必需依赖。未声明依赖的普通 Skill 不从描述中猜测依赖。内置 automation、collaboration、browser、PPT 有最低依赖映射，侧车不能移除这些要求。

## 模块清单（SKILL.json）与门禁

- 清单字段分两类。展示字段（name / description / interface）坏了，回退 frontmatter。
- 门禁字段（dependencies / policy）读不出来，一律按 `invalid-routing` 拦截。包括 JSON 损坏、schemaVersion 不受支持、字段校验失败。读不出依赖不等于没有依赖。
- 内置 Skill 的最低依赖按 slug 生效，与卡片取并集：卡片只能加严，不能放宽。
- 描述以清单为准（shortDescription > description > frontmatter）。运行时投影会把它写回 SKILL.md，模型看到的和路由用的是同一份。
- 词表（`triggers.keywords` 与侧车 `keywords`）已弃用，只为兼容保留。新 Skill 请把用户的说法写进描述。
- 显式引用的 Skill 没加载时，会话里会出现一条「Skill 未加载：…（原因）」提示，不依赖模型转述。
- 全局库的私有账本叫 `skill-library.json`（旧名 `skill.manifest.json` 首次读取时自动改名），不属于技能本体，不会复制进工作区副本或运行时投影。

## 主动推荐和预算

内置路由覆盖代码任务、功能设计、实施计划、协作、定时任务、受管浏览器，以及 PDF/Word/表格/PPT 文件信号。引用历史与代码块不作为本条任务信号；否定语句和一般问答有反例测试。未匹配或自定义 Skill 没有配置关键字时，仍保留可用目录让模型按描述发现。

- 字符 n-gram 兜底只在关键词和显式引用都没命中时介入，只看清洗后的本条消息。它只给位置提示、不注入正文，由模型决定是否读取。用户明确排除的 Skill（排除词、内置否定信号、`implicit: false`）不进入候选。
- `disable-model-invocation: true` 不自动推荐，但显式引用可以加载。
- 显式引用优先于推荐且去重；slug 优先于唯一 display name 别名。同名别名歧义返回诊断。
- 不支持的 qualified 引用不会截断成其他 slug。
- 正文默认总注入预算 24,000 字符，单次最多 64,000；超预算保留完整文件读取指引，不截断规则。
- 扫描单文件最大 512 KiB，正文总读取预算 8 MiB；超过正文预算只读最多 16 KiB frontmatter，保留 catalog，按需读取正文。

## 诊断与验证

主进程 `[Skill 路由]` 日志记录允许 slug、被拦 slug/原因、选中理由和显式引用失败，日志不含 Skill 正文或密钥。失败引用加入本轮 prompt，要求模型简要说明未加载原因；这是模型反馈，不是独立 UI 通知。

离线触发评测在 `skill-routing-eval.test.ts`，覆盖 should-trigger/should-not-trigger。`skill-routing-integration.test.ts` 验证共享 policy → 策略投影 → 真实 Pi ResourceLoader 和 Claude 最终 `sdk.query` 参数。Pi 队列测试使用真实 AgentSession 并验证抑制原生正文二次展开。

离线评测衡量规则是否命中，不等同真实模型采用率。未执行在线模型命中率评测或正式发布。
