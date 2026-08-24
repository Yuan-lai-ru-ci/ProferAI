# 学生 PPTX v1 冻结说明

**状态：冻结，不得作为 Profer 可交付 PPT 主链路。**

**冻结时间：** 2026-08-24

## 冻结原因

真实渲染样例已证明，该原型的核心问题不是 OOXML 文件无法打开，而是视觉生成质量不可接受：

- 连续内容页重复使用相同的柱状图、同一组数据和相同的左右栏构图；
- 标题与右侧 annotation 重复渲染，页面没有信息层级；
- 生成器曾在缺少真实数据时用 `100 / 78 / 63` 默认值创建图表，造成事实污染；
- 当前的 Deck Project、来源谱系、确认收据、语义对象与 OOXML 审计不能替代视觉创作能力；
- 用户不应被要求理解 Deck、Brief、Spec、hash 或审计内部术语。

因此，禁止以“结构审计通过”“有 Notes”“PPTX 可编辑”等理由表述为 PPT 质量通过或可对外交付。

## 冻结范围

下列现有能力只作为原型、测试资产或后续候选引擎的对照材料保存：

- `ppt-deck-*` 的 Deck Project / Brief / 编译工作流；
- 当前 `ppt-layout-engine.ts` 与 `ppt-slide-components.ts` 模板式编译；
- `academic-editorial` 和 `profer-cloud-dancer` 首版 Pack；
- 依赖现有 Deck Spec 的自动生成主链路。

冻结期间不得继续扩展 Style Pack、增加页面模板、增加 Deck 工具、增加确认步骤，或把这条链路注册为产品默认 PPT 功能。

## 本次审计降级修复

冻结前保留了最小安全修复，目标是避免 Agent 在执行中被审计系统反复卡死：

1. 编译阶段将来源版本、编辑措辞和布局密度问题改为 `warnings`，允许先生成可预览草稿；
2. 审计结果将 `hardBlocked`（P0）与可修订反馈（P1/P2）分开；普通质量问题不再阻止 Agent 预览、继续修改或生成下一轮草稿；
3. 只有最终交付判断才读取 P0；
4. 新增对相邻重复布局、相邻重复图表数据、同页重复 claim、缺失 chart 数据的确定性识别；
5. 图表没有真实 `labels + values` 时不再填充默认数据，而是显示“待补充真实数据”。

这些修复不等于认可视觉质量，更不等于解除冻结。

## 解冻前的硬前提

重新启动 PPT 产品工作前，必须先完成独立候选引擎 benchmark，而不是在本原型继续堆规则：

1. 以同一组真实中文学生材料生成并渲染样张；
2. 与至少一个成熟、许可证可用于 Profer 商业产品的开源或商业引擎做盲比；
3. 样张必须通过人工检查：不伪造数据、不连续重复构图、可讲、可编辑、中文排版可读；
4. 仅当候选样张明显优于该原型，才设计最小接入方案；
5. Profer 只保留对话理解、材料权限、预览、自然语言修订和导出等自身优势，不把当前模板生成器包装成设计能力。

## 验证记录

冻结前已实际运行并通过：

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-delivery-audit-service.test.ts src/main/lib/ppt-deck-compiler.test.ts src/main/lib/ppt-oo-xml-audit.test.ts src/main/lib/ppt-scientific-editorial-policy.test.ts src/main/lib/ppt-deck-agent-tools.test.ts
bun run typecheck
```

结果：28 tests passed，Electron main process TypeScript typecheck passed。
