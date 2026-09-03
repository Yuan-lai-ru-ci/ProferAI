---
name: pptx
description: "Use this skill whenever a PowerPoint .pptx file is involved as input or output. This includes creating, reading, editing, modifying, combining, splitting, previewing, or exporting PowerPoint files; working with templates, layouts, speaker notes, comments, charts, and native editable objects. Trigger on requests to create or handle a PowerPoint file, PPT, 幻灯片, 演示文稿, or a .pptx filename. Do not introduce extra project paperwork, specification contracts, source tracking, or confirmation workflows unless the user explicitly requests formal review or submission governance."
license: Proprietary. LICENSE.txt has complete terms
version: "1.2.1"
---

# PPTX Skill

## Profer 默认视觉约定

除非用户明确指定模板、品牌色或其他风格，Profer 生成的 `.pptx` 默认采用 **Cloud Dancer Academic（云端舞者学术风）**。完整设计规范以工作区 `workspace-files/.context/profer-ppt-design-system.md` 为准；生成前必须先读取该文件。

最低要求：

- 使用 PptxGenJS 生成可编辑原生对象；默认暖灰/米白底（`E8E3D7` / `F2EFE7` / `D3CCBF`）和近黑文字（`1D1C19`）。
- 文本框、信息块、图表容器优先使用直角 `RECTANGLE`，不要默认圆角卡片墙、胶囊按钮或气泡容器。
- 文本框可使用极浅低位移外阴影：`blur: 4–6`、`offset: 1–2`、`opacity: 0.10–0.16`；阴影服务于层级分离，不做装饰。
- 整体气质必须硬朗、克制、学术、编辑化；云朵舞者插画只作为风格参考或章节视觉，不铺满每页。
- 仍须遵守逐页主张—证据、真实视觉元素、网格、渲染 QA 和交付审计要求。

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |
| 高级图表（组合图/双轴/84种） | Read [scripts/chartlib.md](scripts/chartlib.md) |
| 渐变背景/色块 | 用 `scripts/gradient.js`，见 [pptxgenjs.md](pptxgenjs.md) |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview
python scripts/thumbnail.py presentation.pptx

# Raw XML
python scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

---

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.**

Use when no template or reference presentation is available.

**补充能力**：pptxgenjs 做不了的组合图/双 Y 轴/精细图表，用 `scripts/chartlib.py`（python-pptx 封装 84 种图表），见 [scripts/chartlib.md](scripts/chartlib.md)；渐变背景用 `scripts/gradient.js`。

## Creation Guidance

Create an editable PowerPoint directly using the available PPTX tooling. Use sensible defaults when details are missing, and do not block ordinary requests on internal paperwork or confirmation workflows.


## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## Profer 正式预览（必须遵守）

PPTX 生成或修改后，必须进入 Profer 当前 Agent 会话的正式文件预览，让用户与 Agent 围绕同一份文件继续工作：使用 `open_file_preview` 请求现有 PreviewPanel/PreviewTabContent 刷新或打开 PPTX。不要创建 `Preview.html`，不要把 PPTX 转成本地网页，不要使用 `BrowserPreviewOpen`、BrowserScreenshot、Quick Look 或任何独立截图旁路来替代 Profer PPT 预览。浏览器工具只用于用户明确要求访问网页或预览 HTML/网页 PPT。

`open_file_preview` 只负责把 PPTX 交给正式预览入口，不代表视觉设计已经通过；应等待用户在同一预览中反馈，或在具备可靠视觉观察能力时基于正式预览状态继续修订。结构、内容、可编辑性检查仍需单独完成。

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

**When using templates, check for leftover placeholder text:**

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before declaring success.

### Visual QA

**⚠️ USE SUBAGENTS** — even for 2-3 slides. You've been staring at the code and will see what you expect, not what's there. Subagents have fresh eyes.

Convert slides to images (see [Converting to Images](#converting-to-images)), then use this prompt:

```
Visually inspect these slides. Assume there are issues — find them.

Look for:
- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative lines positioned for single-line text but title wrapped to two lines
- Source citations or footers colliding with content above
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Columns or similar elements not aligned consistently
- Low-contrast text (e.g., light gray text on cream-colored background)
- Low-contrast icons (e.g., dark icons on dark backgrounds without a contrasting circle)
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content

For each slide, list issues or areas of concern, even if minor.

Read and analyze these images:
1. /path/to/slide-01.jpg (Expected: [brief description])
2. /path/to/slide-02.jpg (Expected: [brief description])

Report ALL issues found, including minor ones.
```

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Converting to Images

Convert presentations to individual slide images for visual inspection.

**Profer 本机（Windows + Office）优先用 PowerPoint COM 转图**（已装本机 PowerPoint，未装 LibreOffice/Poppler）：

```bash
powershell -File scripts/office/pptx2png.ps1 -InputPath output.pptx
```

生成 `render/slide-01.png`、`render/slide-02.png` 等，分辨率 1280×720。

无 Office 的环境用 LibreOffice + Poppler：

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

This creates `slide-01.jpg`, `slide-02.jpg`, etc.

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
```

---

## Dependencies

- `pip install "markitdown[pptx]"` - text extraction
- `pip install Pillow` - thumbnail grids
- `npm install -g pptxgenjs` - creating from scratch
- LibreOffice (`soffice`) - PDF conversion (auto-configured for sandboxed environments via `scripts/office/soffice.py`)
- Poppler (`pdftoppm`) - PDF to images
