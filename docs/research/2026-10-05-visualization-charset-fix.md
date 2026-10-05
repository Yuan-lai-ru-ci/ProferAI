# 修复 present-visualization 中文乱码问题

**日期**: 2026-10-05  
**问题**: Profer 的 HTML 预览在显示包含中文的 fragment 时出现乱码  
**根本原因**: fragment 缺少 `<meta charset="UTF-8">` 声明，导致浏览器使用错误的字符编码解析 UTF-8 文件

## 问题分析

### 现象
用户报告通过 `BrowserPreviewOpen` 打开的 HTML 文件（如 `binary-search.fragment.html`）在 Chrome 中显示正常，但在 Profer 预览中显示为乱码（如 `ä¸Šä¸€æ­¥` 应该是 `上一步`）。

### 技术原因
1. **通过 `present_visualization` 工具发布的可视化**会经过 `buildVisualizationSrcDoc` 自动包装，添加 `<meta charset="UTF-8">`，因此不会乱码
2. **直接通过 `BrowserPreviewOpen` 打开的本地 HTML 文件**不会经过包装，如果文件本身缺少 charset 声明，浏览器会推断编码，可能使用错误的字符集（如 ISO-8859-1）解析 UTF-8 文件

### 设计缺陷
原有 `present-visualization` Skill 和工具描述都要求"只写内容片段（不要 doctype/html/head/body）"，这导致：
- Agent 生成的 fragment 缺少必要的 HTML 结构
- 文件在不同预览场景下表现不一致
- 依赖宿主自动包装的假设过于脆弱

## 解决方案

采用**方案 2：修改 Skill 规范，强制要求包含非 ASCII 字符的 fragment 必须是完整的 HTML 文档**。

### 1. 更新 Skill 文档
**文件**: `apps/electron/default-skills/present-visualization/SKILL.md`

在"结构"部分明确说明：
```markdown
- 只写**内容片段**：不要 `<!doctype>`、`<html>`、`<head>`、`<body>`、`<main>`。
  **例外：当片段包含中文或其他非 ASCII 字符时，为了确保在各种预览场景下都能正确显示，
  必须包含完整的 HTML 结构和字符编码声明**：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>标题</title>
</head>
<body>
  <div id="widget">
    <!-- 你的内容 -->
  </div>
</body>
</html>
```

纯英文 fragment 可以省略外壳，但包含中文/日文/韩文/emoji 等 UTF-8 字符时，
缺少 `<meta charset="UTF-8">` 会在某些预览环境中导致乱码。
```

### 2. 更新工具描述
**文件**: `apps/electron/src/main/lib/agent-visualization-tools.ts`

修改 `PRESENT_VISUALIZATION_DESCRIPTION` 中关于 fragment 的部分：
```typescript
// 旧的描述
content fragment only (no doctype/html/head/body/main, no inline event handlers)

// 新的描述
when the HTML contains non-ASCII characters (Chinese, Japanese, Korean, emoji, etc.), 
it MUST be a complete HTML document with <!DOCTYPE html>, <html>, <head> containing 
<meta charset="UTF-8">, and <body>; pure ASCII fragments may omit the wrapper
```

### 3. 更新验证逻辑
**文件**: `apps/electron/src/main/lib/visualization-validation.ts`

修改 `validateFragment` 函数，允许两种形式：
1. **纯片段**（不含 doctype/html/head/body）
2. **完整 HTML 文档**（必须包含 doctype、html、head、body 和 `<meta charset="UTF-8">`）

拒绝不完整的 HTML 结构（只有部分标签）。

```typescript
export function validateFragment(html: string): void {
  // 允许两种形式：
  // 1. 纯片段（不含 doctype/html/head/body）
  // 2. 完整 HTML 文档（包含 doctype/html/head/body，且必须有 <meta charset="UTF-8">）
  const hasDoctype = /<\s*!doctype\b/i.test(html)
  const hasHtmlTags = /<\s*\/?\s*(?:html|head|body)\b/i.test(html)
  const hasMain = /<\s*\/?\s*main\b/i.test(html)
  
  if (hasMain) {
    throw new Error('可视化片段不能包含 <main> 标签；根容器用 #widget')
  }
  
  // 如果包含任何完整 HTML 结构标签，就要求必须是完整的、带 charset 的文档
  if (hasDoctype || hasHtmlTags) {
    if (!hasDoctype || !hasHtmlTags) {
      throw new Error('可视化片段如果包含 HTML 结构标签，必须是完整文档（doctype + html + head + body）')
    }
    // 检查是否有 <meta charset="UTF-8">
    if (!/<meta\s+charset=["']?utf-8["']?\s*\/?>|<meta\s+[^>]*charset=["']?utf-8["']?[^>]*>/i.test(html)) {
      throw new Error('包含中文或非 ASCII 字符的完整 HTML 文档必须在 <head> 中声明 <meta charset="UTF-8">')
    }
  }
  
  validateHtml(html)
  // ... 其余验证逻辑
}
```

### 4. 更新测试用例
**文件**: `apps/electron/src/main/lib/visualization-chart.test.ts`

更新测试用例验证新的行为：
```typescript
test('严格片段接受局部JS，拒绝不完整HTML和内联事件，但允许带charset的完整HTML', () => {
  // 接受纯片段
  validateFragment('<div id="widget"><button class="btn">切换</button></div><script>...</script>')
  
  // 接受带 charset 的完整 HTML
  validateFragment('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div id="widget">内容</div></body></html>')
  
  // 拒绝不完整的 HTML 结构
  expect(() => validateFragment('<html><body>page</body></html>')).toThrow('完整文档')
  expect(() => validateFragment('<!DOCTYPE html><html><body>缺少charset</body></html>')).toThrow('charset')
  
  // 拒绝内联事件
  expect(() => validateFragment('<button onclick="alert(1)">Click</button>')).toThrow('内联事件')
})
```

## 验证

1. **修复示例文件**: 为 `binary-search.fragment.html` 添加完整 HTML 结构和 charset 声明
2. **测试预览**: 通过 `BrowserPreviewOpen` 打开，中文、日文、韩文和 emoji 都正确显示
3. **运行测试**: 所有 54 个 visualization 相关测试通过
4. **创建测试文件**: 创建包含多语言字符的测试页面，验证在 Profer 预览中正常显示

## 影响范围

### 向后兼容性
- **已有纯片段**：仍然可以正常工作（验证逻辑允许不带 doctype/html/head/body 的纯片段）
- **已有完整 HTML 但缺少 charset**：会被拒绝，需要补充 `<meta charset="UTF-8">`
- **通过 `present_visualization` 工具发布的可视化**：不受影响（仍然经过 `buildVisualizationSrcDoc` 包装）

### 行为变化
- Agent 生成包含非 ASCII 字符的 fragment 时，会自动使用完整的 HTML 结构
- 验证更加严格：不允许"半成品"HTML（只有部分标签）
- 错误信息更明确：指出缺少 charset 或结构不完整

## 为什么选择方案 2

考虑过两个方案：
1. **在 `BrowserPreviewOpen` 层面自动添加 charset**
2. **修改 Skill 规范，要求完整 HTML**

选择方案 2 的原因：
1. **自包含性**: HTML 文件本身就应该是完整的、可独立运行的
2. **可移植性**: 文件被导出、分享或用其他方式打开时，不依赖 Profer 的特殊处理
3. **明确契约**: 显式的规范比隐式的自动包装更可靠
4. **减少魔法**: 不需要在运行时动态修改用户文件内容
5. **更好的错误提示**: 验证时就能发现问题，而不是在预览时表现不一致

## 后续建议

1. **文档更新**: 在用户文档中强调字符编码的重要性
2. **模板优化**: 为常见场景提供完整的 HTML 模板
3. **IDE 提示**: 在生成代码时自动包含完整的 HTML 结构
4. **迁移指南**: 为已有的不带 charset 的 fragment 提供迁移指导

## 相关文件

- `apps/electron/default-skills/present-visualization/SKILL.md`
- `apps/electron/src/main/lib/agent-visualization-tools.ts`
- `apps/electron/src/main/lib/visualization-validation.ts`
- `apps/electron/src/main/lib/visualization-chart.test.ts`
- `apps/electron/src/renderer/lib/visualization-bridge.ts` (已有自动包装逻辑，保持不变)
