---
name: guizang-ppt-skill
description: "Create horizontal-swipe web PPTs as a single HTML file, with templates for WebGL backgrounds, chapter title cards, large-data callouts, image grids, and more. Provides two styles: 1) \"Digital Magazine x E-Ink\" (serif + fluid background + warm colors), and 2) \"Swiss Internationalism\" (sans serif + grid/dot matrix + IKB/lemon yellow/lemon green/safety orange accents). Use when users need a share/talk/launch-event-style web PPT, or mention \"magazine-style PPT\", \"Swiss-style PPT\", \"Swiss Style\", or \"horizontal swipe deck\"."
version: "1.1.2"
---

# Magazine Web Ppt

## What This Skill Does

Generate a **single-file HTML** horizontal-swipe PPT with two selectable visual directions:

### Style A · Digital Magazine x E-Ink (default)

- **WebGL fluid / contour / dispersion background** (visible on hero pages)
- **Serif headings (Noto Serif SC + Playfair Display) + sans-serif body + monospaced metadata**
- Suitable for: humanistic talks, industry observations, business launches, and presentations that need a "magazine feel"
- Template: `assets/template.html` · Theme colors: `references/themes.md` · Layouts: `references/layouts.md`
- Aesthetic anchor: like *Monocle* magazine with code pasted onto it

### Style B · Swiss Internationalism (Swiss Style)

- **WebGL ultra-fine grid + dot-matrix background** (information-driven design)
- **Sans serif throughout (Inter + Helvetica + Noto Sans SC) + extreme type-size contrast**
- **High-contrast functional colors**: Klein blue IKB / lemon yellow / lemon green / safety orange (choose one)
- Suitable for: technology products, data reporting, design/engineering talks, and annual summaries
- Template: `assets/template-swiss.html` · Theme colors: `references/themes-swiss.md` · Layouts: `references/layouts-swiss.md`
- Aesthetic anchor: like Massimo Vignelli + Helvetica Forever

**Shared by both styles**: horizontal swiping (keyboard ← →, wheel, touch, ESC index), Lucide icons, and Motion One entrance animations (local + CDN fallback).

## When to Use

**Good fits**:
- In-person talks / internal industry presentations / private salons
- AI product launches / demo days
- Talks with a strong personal style
- Web-based slides that should be produced once without a slide tool

**Poor fits**:
- Large tables, dense data, or layered charts (use a conventional PPT)
- Training materials (not enough information density)
- Multi-person collaborative editing (this is static HTML)

## Workflow

### Step 1 · Clarify Requirements (**required before starting**)

**If the user has already provided a complete outline + images**, skip directly to Step 2.

**If the user has only provided a topic or vague idea**, align on the following questions one at a time before starting. Do not write slides based on guesses—a wrong structure is expensive to revise later:

#### Runtime Adaptation

- **In Codex**: ask the user in ordinary conversation. Do not call Claude Code's `ask question` / `ask_question` mechanism or assume those tools exist. Ask at most 1-3 key questions at a time; if a missing detail does not block work, make a reasonable assumption and state it in the reply.
- **In Claude Code**: you may continue using the original `ask question` interaction method item by item.

#### Seven-Question Clarification Checklist

| # | Question | Why ask |
|---|---|---|
| 1 | **Style A or B?** (Digital Magazine / Swiss Internationalism) | **Must be asked first**; determines which template + layouts + themes files to use |
| 2 | **Who is the audience? What is the talk context?** (industry internal / business launch / demo day / private salon) | Determines language style and depth |
| 3 | **How long is the talk?** | 15 minutes ≈ 10 pages, 30 minutes ≈ 20 pages, 45 minutes ≈ 25-30 pages |
| 4 | **Are there source materials?** (documents / data / old PPT / article links) | Use source material when available; otherwise help build the structure |
| 5 | **Are there images? Where are they?** | See the "Image Convention" section below |
| 6 | **Which theme color set do you want?** | Magazine style has 5 sets (`themes.md`); Swiss style has 4 sets (`themes-swiss.md`); choose one |
| 7 | **Any hard constraints?** (must include XX data / must not include YY) | Prevents rework |

#### Style Selection Reference (Question 1)

| If the user says... | Recommended style |
|---|---|
| "Magazine feel" / "humanistic" / "Monocle style" / no preference | **A · Digital Magazine** |
| "Swiss style" / "Swiss Style" / "Helvetica" / "minimal" / "grid" / "infographic" / "data-driven" | **B · Swiss Internationalism** |
| Content is an AI product / technology / engineering / data report | B is more suitable |
| Content is an industry observation / human story / story / culture | A is more suitable |
| User provides many KPI numbers / roadmaps / processes | B is more suitable (`Data Hero` layout is a Swiss specialty) |
| User provides many documentary photos / humanistic images | A is more suitable (image grids and left-text/right-image are magazine specialties) |
| User needs GPT-M 2.0 to generate screenshots for redesign / infographics / evidence walls | B is also suitable (P23/P24 are Swiss image-specific layouts) |

#### Outline Assistance (when the user has no outline)

Use the "narrative arc" template as the skeleton, then fill in the content:

```
Hook              → 1 page  : create a contrast, question, or hard data point that makes people stop
Context           → 1-2 pages: explain the background, who you are, and why you are speaking
Core              → 3-5 pages: develop the main content, alternating Layout 4/5/6/9/10
Shift             → 1 page  : break expectations and introduce a new point of view
Takeaway          → 1-2 pages: a key line, suspense question, or action recommendation
```

Align the narrative arc, page-count plan, and theme-rhythm table (see `layouts.md`) **before moving to Step 2**.

The outline should be saved as `project-record.md` or `outline-v1.md` for later iteration.

#### Image Convention (tell the user)

Before starting, make these points clear to the user:

- **Folder location**: under `project/XXX/ppt/images/` (at the same level as `index.html`)
- **Naming convention**: `{page-number}-{semantic-name}.{ext}`, for example `01-cover.jpg` / `03-figma.jpg` / `05-dashboard.png`
  - Zero-pad page numbers for sorting
  - Use short, specific English semantics tied to the content
- **Recommended specs**:
  - Each image ≥ 1600px wide (to avoid blur on large screens)
  - JPG for photos/screenshots, PNG for transparent UI/charts
  - Keep the total size within 10MB (affects swipe smoothness)
- **How to replace**: same-name replacement is safest (no path changes needed in HTML); if the filename changes, globally search for `images/old-name` and update it
- **No images?**: align with the user; use placeholder color blocks to establish structure first and add images later. Tell the user that image/text mixed layouts such as Layout 4/5/10 cannot be visually validated without images.

#### Codex Image Generation (optional)

If the current runtime is **Codex**, after completing the deck draft proactively ask whether the user wants GPT-M 2.0 to generate and insert supporting images. Do not generate by default.

Recommended question:

> Would you like to generate a few images for this PPT? They can be documentary humanistic photos, magazine-style infographics, process/comparison/system relationship diagrams, or screenshot redesigns in a unified magazine style.

If the user confirms generation, ask what image type or style they want; if they have no preference, recommend 1-3 images that are most worth generating based on the pages.

When generating supporting images:

- Keep prompts short, framing only topic, purpose, style, and aspect ratio; do not write lengthy photography direction
- The image style must match the current deck style: Style A uses "Digital Magazine x E-Ink"; Style B uses "Swiss Internationalism / Swiss Style"
- Text language in infographics, charts, and screenshot redesigns must follow the language of the deck; use Chinese for a Chinese deck and English for an English deck
- First read `references/image-prompts.md` and choose an image type and base prompt
- Match the image aspect ratio to its final placement: primary visual 16:9, left text/right image 16:10 / 4:3, infographic 16:9 / 16:10, screenshot redesign 16:10, mixed-layout small image 3:2 / 3:4, grid images cropped to a uniform height
- Put generated images under `images/`, using `{page-number}-{semantic-name}.{ext}` naming

### Step 2 · Copy the Template

Based on the style selected in Step 1, copy the corresponding template to the target location (usually `project/XXX/ppt/index.html`), and create a sibling `images/` folder for incoming images.

```bash
mkdir -p "project/XXX/ppt/images"

# Style A · Digital Magazine
cp "<SKILL_ROOT>/assets/template.html" "project/XXX/ppt/index.html"

# Or Style B · Swiss Internationalism
cp "<SKILL_ROOT>/assets/template-swiss.html" "project/XXX/ppt/index.html"
```

Both `template*.html` files are **complete runnable files**—CSS, WebGL shaders, swipe JS, and font/icon CDNs are already configured. They only contain the `<!-- SLIDES_HERE -->` placeholder where slide content must be inserted.

**Important**: Styles A and B **must not be mixed**. Classes in `layouts.md` (such as `.h-hero` serif display headings, `.display-zh`, etc.) are defined only in `template.html`; classes in `layouts-swiss.md` (such as `.kpi-hero`, `.accent-block`, `.span-N`, `.dots`, etc.) are defined only in `template-swiss.html`. A deck must choose one set.

#### 2.1 · Required Placeholder Replacement (**easy to miss**)

Immediately after copying, replace the following placeholders or the browser tab will display awkward text such as "[Required] Replace with PPT title":

| Location | Original | Replace with |
|---|---|---|
| `<title>` | `[Required] Replace with PPT title · Deck Title` | Actual deck title (for example, `A New Way of Working · Luke Wroblewski`) |

The first action after each `template.html` copy: run grep for `"[Required]"` and confirm that all instances have been replaced.

#### 2.2 · Choose a Theme Color (5 Presets · Custom Colors Not Allowed)

This Skill **allows only one of 5 carefully tuned presets**. Do not accept user-defined hex values—incorrect color combinations can immediately ruin the visual, so protect the aesthetic rather than offering arbitrary freedom.

| # | Theme | Suitable for |
|---|---|---|
| 1 | 🖋 Ink Classic | General / business launches / default when unsure |
| 2 | 🌊 Indigo Porcelain | Technology / research / data / technical launches |
| 3 | 🌿 Forest Ink | Nature / sustainability / culture / nonfiction |
| 4 | 🍂 Kraft Paper | Nostalgia / humanistic / literature / independent magazines |
| 5 | 🌙 Dune | Art / design / creative / galleries |

**Procedure**:
1. Recommend one based on the content, or ask the user to choose
2. Open `references/themes.md` and find the corresponding `:root` block
3. **Replace as a whole** the lines marked with the "theme colors" comment in the `:root{` block at the beginning of the copied `assets/template.html` (`--ink` / `--ink-rgb` / `--paper` / `--paper-rgb` / `--paper-tint` / `--ink-tint`)
4. All other CSS uses `var(--...)`; no other changes are needed

**Hard rules**:
- One deck uses one theme only; do not change colors mid-deck
- Do not accept arbitrary hex values from the user—politely decline and show the 5 sets for selection
- Do not mix sets (for example, ink from Ink Classic and paper from Dune); it will feel incoherent

### Step 3 · Fill the Content

#### 3.0 · Preflight: Class Names Must Be Defined in the Template's `<style>` (**most important**)

**This is the source of all generation problems**. Layout skeletons use many class names; if a class is missing from the template's `<style>`, the browser falls back to default styles—display-heading fonts are wrong, cards collapse, pipelines become a line, and images pile up at the bottom of the page.

The class sets for the two styles are mutually incompatible (repeated for emphasis):
- Style A template has `h-hero` (serif), `stat-card`, `grid-2-7-5`, `frame`, etc.
- Style B template has `h-hero` (sans serif), `kpi-hero`, `accent-block`, `span-N`, `dots`, `grid-12`, etc.
- The same class name has completely different visual behavior in the two templates (for example, Style A's `h-hero` is Noto Serif SC serif, while Style B's `h-hero` is Inter sans serif).

**Before writing any slide code**:

1. **Read the current template** (at least through the end of its `<style>` block):
   - Style A → `assets/template.html`
   - Style B → `assets/template-swiss.html`
2. Compare against the corresponding layouts file's Pre-flight list and confirm that every class you plan to use exists in `<style>`
3. If a class is missing: **add it to the template's `<style>`**, rather than rewriting it inline on each slide
4. The template is the only source of class names—do not invent new classes; use `style="..."` inline only when customization is necessary

**Common Style A classes that are easy to miss**:
`h-hero` / `h-xl` / `h-sub` / `h-md` / `lead` / `kicker` / `meta-row` / `stat-card` / `stat-label` / `stat-nb` / `stat-unit` / `stat-note` / `pipeline-section` / `pipeline-label` / `pipeline` / `step` / `step-nb` / `step-title` / `step-desc` / `grid-2-7-5` / `grid-2-6-6` / `grid-2-8-4` / `grid-3-3` / `grid-6` / `grid-3` / `grid-4` / `frame` / `frame-img` / `img-cap` / `callout` / `callout-src` / `chrome` / `foot`

**Common Style B classes that are easy to miss** (after the 2026-05 refactor):
- Canvas: `canvas-card` / `chrome-min`
- Typography: `h-hero` (sans serif 7.4vw weight 200) / `h-statement` (9.6vw) / `h-xl` / `h-md` / `t-cat` (SemiBold 600 label) / `t-meta` (mono uppercase) / `lead` / `num-mega` / `mono`
- Cards (four mutually exclusive types): `card-ink` / `card-accent` / `card-fill` / `card-outlined`
- Grid: `grid-12` / `grid-2-9` / `grid-2-9-5` / `span-N`
- Timelines: `timeline-v` + `tl-node` + `tl-axis` + `dot` / `timeline-h` + `tl-h-node` + `tl-h-axis`
- Charts: `kpi-tower-row` + `bar-tower` / `h-bar-chart` + `bar-row` + `bar-fill` / `spec-bars` + `bar-vert`
- Decoration: `dot-mat` (solid dots via SVG mask) / `ring-mat` (outlined circles) / `cross-mat` (× grid) / `hr-hairline`
- Layout-specific: `cover-split` / `closing-split` / `duo-compare` + `vrule` / `manifesto-top` + `ink-banner-full` / `three-forces` / `loop-diagram` / `matrix-fill` + `matrix-cell` / `brief-grid` + `brief-card` / `system-diagram` / `why-now-grid` / `four-cards` / `stacked-ledger` + `ledger-row` / `tech-spec` / `image-hero` + `hero-img-wrap` + `hero-overlay-block` + `hero-stats`
- Image mixes: `frame-img` / `fit-contain` / `r-21x9` / `r-16x9` / `r-16x10` / `h-22` / `h-26` / `swiss-img-split` / `swiss-img-grid` / `swiss-img-caption` / `swiss-keyline` / `swiss-lined`
- Spacing tokens: `--sp-3`...`--sp-13` (8/12/16/24/32/40/48/64/80/96/160 px)

#### 3.0.5 · Plan the Theme Rhythm (**as important as the class preflight**)

**Before choosing layouts**, list the theme class for every page (`hero dark` / `hero light` / `light` / `dark`) in a document or draft and align it. See the "Theme Rhythm Planning" section at the beginning of `references/layouts.md` for details.

**Mandatory rules**:

- Every page section must carry one of `light` / `dark` / `hero light` / `hero dark`; do not write only `hero`
- Three or more consecutive pages with the same theme are visually tiring and are not allowed
- Decks over 8 pages must contain ≥1 `hero dark` and ≥1 `hero light`
- A deck cannot contain only `light` body pages; use `dark` body pages to create breathing room
- Insert one hero page (cover/chapter title/problem/large quote) every 3-4 pages

**Post-generation check**: `grep 'class="slide' index.html` to list all themes, then manually confirm that the rhythm is sound.

#### 3.1 · Choose a Layout

**Do not write slides from scratch**. Open the corresponding layouts file; it contains 10 ready-made layout skeletons, each a complete pasteable `<section>` code block.

**Style A** → `references/layouts.md`:

| Layout | Use |
|---|---|
| 1. Opening Cover | Page 1 |
| 2. Chapter Title Card | Start of each chapter |
| 3. Large Data Callout | Present hard data |
| 4. Left Text / Right Image (Quote + Image) | Identity contrast / story |
| 5. Image Grid | Multi-image comparison / screenshot evidence |
| 6. Two-Column Pipeline | Workflow |
| 7. Suspense Close / Question Page | End of chapter / closing |
| 8. Big Quote | Serif key line / takeaway |
| 9. Side-by-Side Comparison (Before / After) | Old model vs. new model |
| 10. Mixed Text and Image (Lead Image + Side Text) | Dense text-and-image page |

**Style B** → first read `references/swiss-layout-lock.md`, then read `references/layouts-swiss.md`.

Swiss style defaults to **Swiss locked mode**:

- Body pages may use only the 22 layouts `S01-S22` registered by the original reference PPT. New opening/closing pages may use only the explicitly provided `SWISS-COVER-ASCII` / `SWISS-CLOSING-ASCII`.
- Every `<section class="slide">` must include `data-layout="Sxx"`. Without `data-layout`, it is considered an unregistered layout.
- Do not invent body structures outside the original 22P, such as `P23/P24`, `Swiss Image Split`, or `Evidence Grid`, unless the user explicitly requests an experimental layout.
- Chinese headings at the top are left-aligned on the upper-left content axis by default. Do not put a small heading in the left column and a large heading in the right column to force visual centering; only the original statement/split layouts allow strongly centered narratives.
- SVG is for geometry only. Do not put text labels inside SVG; use HTML grids/cards/captions for all labels.
- Use `S08 + Swiss Map Component` for geography/history/city routes/place relationships: first read `references/swiss-map-component.md`, while retaining `data-layout="S08"`.

The original 22 body layouts are:

| Layout | Use |
|---|---|
| S01 Index Cover | Original index cover |
| S02 Vertical Timeline + KPI | Evolution comparison / changes over time |
| S03 Split Statement | Core argument / split screen |
| S04 Six Cells | Definition of 6 concepts |
| S05 Three Layers | Three-layer architecture |
| S06 KPI Tower | Visualize height differences across 4 data points |
| S07 H-Bar Chart | Ranking comparison across 5-10 items |
| S08 Duo Compare | Before/After comparison |
| S09 Dot Matrix Statement | Large quotation / statement |
| S10 Split Closing | Closing page |
| S11 Horizontal Timeline | 4-7 step process |
| S12 Manifesto + Ink Banner | Stage conclusion |
| S13 Three Forces | Deepen 3 equivalent concepts |
| S14 Loop Form | Self-learning loop / automation |
| S15 Matrix + Hero Stat | 8-12 item matrix + headline metric |
| S16 Multi-card Brief | 6 short-news cards |
| S17 System Diagram | Three-layer architecture / ecosystem map |
| S18 Why Now | Three arguments + data support |
| S19 Four Cards | 4 equally weighted features |
| S20 Stacked KPI Ledger | Vertical ledger data |
| S21 Tech Spec Sheet | Product specifications / benchmark |
| S22 Image Hero | 21:9 top image + title block + three-column KPI |

**Registered extension**: `S08 + Swiss Map Component` is for locations, residences, routes, cities, and other place relationships. It is not a new layout; it is a MapLibre map component in the right-side slot of S08. Implement it according to the points, lines, cards, and top-right zoom/drag controls in `references/swiss-map-component.md`.

Choose the corresponding layout, paste it, and change the copy and image paths. **Complete the 3.0 preflight first.**

**Style B layout diversity hard rules**:
- A 7-8 page deck must use at least **6 different S-numbered layouts**; a deck of 10 or more pages must use at least 8 different layouts.
- If the user says "test the template / see the effect / use more layouts", include: one cover, one closing page, at least one comparison or timeline (S08/S11/S02), at least one structural diagram (S14/S17/S15), and at least one image layout (S22 or an image-grid adaptation of S15/S16).
- Do not use the same main structure for 3 consecutive pages, such as three consecutive `head + grid + card` pages.
- Do not invent a new structure for image pages. For 2-3 images, adapt the original grid skeleton from S15/S16; use S22 for one large image.
- Before writing HTML, draft `page number → data-layout → reason for selection → image slot`; before delivery, run `node <SKILL_ROOT>/scripts/validate-swiss-deck.mjs index.html`.

#### 3.2 · Image Aspect-Ratio Rules

Always use **standard aspect ratios**; do not preserve unusual source-image ratios such as `2592/1798`:

| Scenario | Recommended ratio |
|---|---|
| S22 top hero image | **21:9**; keep the key subject in the central safe area |
| S15/S16 image grid | Uniform 21:9 or uniform 16:10; never mix |
| Left text / right image hero (Style A) | 16:10 or 4:3 + `max-height:56vh` |
| Image grid (Style A) | **fixed `height:26vh`**, do not use aspect-ratio |
| Full-screen primary visual | 16:9 + `max-height:64vh` |
| Small mixed-layout illustration | 3:2 or 3:4 |

**Do not default to `align-self:end` for images**—they slide to the bottom and can easily touch the pagination component. Use a grid container + `align-items:start` (already configured in the template) so images align to the top; only Style B P23 may use `.swiss-img-split.align-image-bottom`, because the template includes the `--nav-safe-bottom` safe area for it.

**Additional Swiss Style rules**:
- Use S22 for a single large image; for multiple images adapt the original card grids from S15/S16; do not use unregistered P23/P24
- Before generating images, write `data-image-slot`: for example `s22-hero-21x9` / `s15-grid-21x9` / `s16-brief-21x9`
- S22 supporting images default to 21:9; prompts must contain `subject centered in the safe middle area`; image containers use `object-position:center 35%`, not `top center`
- Image containers must be square-cornered, without shadows or rounded corners; default background is white `var(--paper)`, not a gray wrapper around a white infographic
- White-background GPT infographics/process diagrams/UI images should not get an outer border by default; do not casually apply `.swiss-keyline`; when emphasis is needed, use only the top accent line of `.swiss-lined`
- Use `.fit-contain` only for user-provided screenshots or text-dense UI/infographic images; if an image was regenerated for an S15/S16 slot, it must fill the container with `.frame-img.r-21x9` / `.frame-img.r-16x10`; do not shrink it into a fixed `height:18vh`
- Images in the same group must use the same slot, ratio, and height; do not mix them
- GPT-M 2.0 generated images use the "Style B: Swiss Internationalism Image Rules" in `image-prompts.md`
- The lowest point of any image, caption, timeline label, or footnote must not enter the bottom pagination area; when content needs to sit near the bottom, use `.nav-safe-bottom` / `.nav-safe-bottom-tight`, not a handwritten `bottom:2vh`

#### 3.2.1 · Chinese Display-Heading Size Tiers (required for Style B)

Chinese square glyphs occupy more visual area and cannot directly use the English hero's 6.8-7vw. Tier Chinese display headings before writing them:

| Heading form | Recommended size |
|---|---|
| 1 line, ≤ 8 Chinese characters | `min(6.4vw,11.2vh)` |
| 2 lines, ≤ 8 Chinese characters per line | `min(5.8vw,10.2vh)` |
| 2 lines, 9-12 Chinese characters on either line | `min(5.2vw,9.2vh)` |
| 3 or more lines | Prefer rewriting the heading; if unavoidable use `min(4.6vw,8.2vh)` |

If the heading crowds the image or body region, shorten the heading copy first, then lower the font size; do not force-fit it by pushing the content below to the bottom.

Component details (fonts, colors, grids, icons, callouts, stat cards, etc.) are in `references/components.md`.

### Step 4 · Run the Self-Check Checklist

After generation, always open `references/checklist.md` and check every item. It summarizes **all pitfalls found during real iteration**. P0 issues (emoji, image overflow, heading wrapping, font roles) must all pass.

#### 4.0 · Do Not Inspect Code Only: Perform a Visual Web Check

Code can prove that class names and structure exist, but not that the layout feels right. After generation, open the web page and inspect every page:

1. Open the original reference PPT, the current template or generated page, and the test PPT at the same time. Use the upstream author's reference pages for the original reference (they are not distributed with this Skill); within this Skill, `assets/template-swiss.html` can be used for comparison.
2. Wait for entrance animations to stabilize (about 1-2 seconds) before taking screenshots; do not treat an animation's intermediate state as a layout defect.
3. Inspect visually first: display-heading weight, heading/content spacing, image/body alignment, and whether images/captions touch the bottom pagination component.
4. Inspect code second: confirm that the selected layout matches the content shape, that a data-specific layout is not being used to explain a concept, and that optional components have not been piled on as decoration.
5. When comparing with the original reference template, use actual page usage as the source of truth. Do not rely only on CSS helper definitions; the original pages' large text is often 200/300, so do not let raw CSS values such as 700/800/900 mislead you.
6. If a page feels awkward, first decide whether the layout is wrong, a required component is missing, an optional component is overused, or spacing/safe-area rules are the problem; do not try to rescue it by adding margins blindly.

#### Style A · Digital Magazine Must-Check

1. **Display headings must use serif fonts**—if they render as sans serif, 99% of the time the Step 3.0 preflight was skipped and the `h-hero` class is missing from `template.html`
2. **Image grids use only `height:Nvh`, never `aspect-ratio`** (which can overflow)
3. **Images must not pile up at the bottom**—do not use `align-self:end`; use grid + `align-items:start` (see Step 3.2)
4. **Images must use standard ratios only** (16:10 / 4:3 / 3:2 / 1:1 / 16:9); do not copy unusual source ratios
5. **Chinese display headings ≤ 5 characters and use `nowrap`** (to avoid one character per line)
6. **Use Lucide, not emoji**
7. **Headings use serif, body uses sans serif, metadata uses monospace**

#### Style B · Swiss Internationalism Must-Check

1. **Sans serif throughout**—any serif font is wrong (check that `font-family` does not use a `--serif` class variable)
2. **Only one accent color**—a deck must not show multiple highlights such as IKB blue + lemon yellow + safety orange
3. **No gradients / shadows / rounded corners**—all blocks are square-cornered solid colors; remove any `box-shadow` / `linear-gradient` / `border-radius` > 0 (except rule lines)
4. **Extreme type-size contrast**—the main-heading/body ratio must be ≥ 8:1
5. **Large type requires a dual height constraint**—use `font-size:min(Xvw, Yvh)`; using only vw overflows on standard 16:9 screens (learned from P15/P20/P22)
6. **Large type weight is 200** (ExtraLight)—the larger the type, the thinner it should be, the soul of Swiss style; **do not use** 600/700/800 for large type
7. **Card fill types are mutually exclusive**—`card-ink` / `card-accent` / `card-fill` / `card-outlined` **must not be mixed** (no "blue fill + blue border", "gray fill + border", etc.)
8. **Use one style for parallel cards**—3-12 cards use the same class (prefer `card-fill` gray fill); highlight one item separately with `card-accent`, and **only one card may use it**
9. **Square corners everywhere**—no `border-radius`; use 8×8 square blocks for decoration, **not** 9px circular dots
10. **Use Lucide icons; do not draw SVG yourself**—`<i data-lucide="name"></i>` + `lucide.createIcons()`, with angular styles (avoid round, bulbous icons)
11. **Align timelines**—the axis column is fixed at 12px and the dot is absolutely positioned; **do not** use grid `justify-self` (it will misalign with the dashed line)
12. **Chapter-level heading/content spacing ≥ 9vh**—avoid crowding (learned from P15/P16)
13. **One semantic animation recipe per page**—not a uniform fade-up: use scale-in for numbers, scaleY lift for bars, SVG stroke drawing, sequential node lighting, etc.; **do not** use one generic recipe on every page
14. **Reveal containers at the `playSlide` entry point**—force `[data-anim]` containers to `opacity:1` first, then override inside the recipe with Motion `{opacity:[0,1]}`, or some pages will be invisible
15. **ESC index visibility**—cloned slides must have a CSS override that makes `[data-anim]` opaque in thumbnails
16. **Helvetica/Inter fallback Chinese fonts**—Windows users may not have "PingFang"; always fall back to `"Microsoft YaHei UI", "Noto Sans SC"`
17. **Font weight roles**: large type 200 / body 300 / `t-cat` SemiBold 600 / `t-meta` mono uppercase
18. **Keep the low-power shortcut**—the lower-right corner must show `B Static`; pressing `B` switches `body.low-power`, stops WebGL/ASCII canvas RAF and Motion entrance animations
19. **Keep decorative elements inside the grid**—bar matrices, dot matrices, and ring-mat must not touch the edges or overflow the page
20. **Reserve bottom space for navigation**—nav is around ~97vh; content must end no lower than 93vh (learned from the P22 KPI overflow issue)
21. **Image containers are square-cornered and shadowless**—`.frame-img` must not have `border-radius` / `box-shadow`; boundaries use hairlines only
22. **P23/P24 image groups must be consistent**—images in one group use the same ratio, height, margins, and line thickness; infographics/UI images use `.fit-contain`
23. **Use components for their intended roles**—P23/P24 captions are required information anchors; P22 KPI/explanation is required; data-specific layouts must contain real data and cannot be filled with copy alone
24. **Distinguish general and specialized layouts**—P3/P8/P11/P19/P23 are more general; P6/P7/P20/P21/P22 are for data/case-specific content; P14/P15/P17 are structural layouts

### Step 5 · Local Preview

Open `index.html` directly in a browser. On macOS:

```bash
open "project/XXX/ppt/index.html"
```

No local server is needed. Images use relative paths such as `images/xxx.png`.

### Step 6 · Iterate

Revise based on user feedback—the template CSS is heavily parameterized, so 90% of adjustments are inline style changes (font size `font-size:Xvw` / height `height:Yvh` / spacing `gap:Zvh`).

---

## Resource File Guide

```
guizang-ppt-skill/
├── SKILL.md                  ← the file you are reading
├── assets/
│   ├── template.html         ← Style A · Digital Magazine template (seed file)
│   ├── template-swiss.html   ← Style B · Swiss Internationalism template (seed file)
│   └── motion.min.js         ← local Motion One copy (offline fallback, about 64KB, shared)
├── scripts/
│   └── validate-swiss-deck.mjs ← Style B static validator: registered layouts, image slots, SVG text, title alignment
└── references/
    ├── components.md         ← component guide (fonts, colors, grids, icons, callouts, stats, pipelines, animation; Style A)
    ├── layouts.md            ← Style A · 10 page-layout skeletons (ready to paste, with animation markers)
    ├── swiss-layout-lock.md  ← Style B · original 22-page layout lock; body pages must be registered here
    ├── layouts-swiss.md      ← Style B · original 22-page skeleton notes + a small explicitly marked experimental area
    ├── swiss-map-component.md ← Style B · S08 map extension (MapLibre points, lines, cards, controls)
    ├── themes.md             ← Style A · 5 theme-color presets (choose one; no custom colors)
    ├── themes-swiss.md       ← Style B · 4 Swiss-style theme-color presets (IKB / lemon yellow / lemon green / safety orange)
    ├── image-prompts.md      ← GPT-M 2.0 image types, ratios, and base prompts
    └── checklist.md          ← quality checklist (P0/P1/P2/P3 levels)
```

**Recommended loading order**:
1. Read `SKILL.md` (this file) to understand the whole system
2. In Step 1 requirement clarification, determine Style A or B with the **first question**, then:
   - Style A: read `themes.md` to help the user choose a theme color
   - Style B: read `themes-swiss.md` to help the user choose a theme color
3. **Before starting, read the `<style>` block of the corresponding template**—it is the sole source of class names; missing classes can collapse the whole page's styling
   - Style A → `assets/template.html`
   - Style B → `assets/template-swiss.html`
4. Read the corresponding layouts file to choose layouts:
   - Style A → `layouts.md` (includes the Pre-flight class list, theme-rhythm planning, and animation-recipe decision tree at the top)
   - Style B → **first read `swiss-layout-lock.md`**, then `layouts-swiss.md`; body pages must choose from S01-S22 and write `data-layout`
5. If Style B needs a map of places, routes, residences, or city relationships, read `swiss-map-component.md`
6. If generating images in Codex, read `image-prompts.md` to choose the image type, ratio, and base prompt
7. For detail adjustments, read `components.md` for components (including the Motion animation system, mainly for Style A; Style B component details are in the appendix of `layouts-swiss.md`)
8. After generation, run `node scripts/validate-swiss-deck.mjs path/to/index.html`, then read `checklist.md` for self-checking

**Animation**: the template embeds Motion One loading and recipe logic in its bottom module script. You do not need to edit JS; add `data-anim` / `data-animate` to the HTML according to the skeletons in `layouts.md` / `layouts-swiss.md`. Offline demos use `assets/motion.min.js`; when offline, they automatically degrade to "no animation but readable content". The Style B template must retain the `B` key low-power mode: after switching, it stops WebGL/ASCII canvas RAF, cancels running Web Animations, and reveals the current page content directly in its final static state.

## Core Design Principles (Philosophy)

### Style A · Digital Magazine (Five-Round Iteration Summary)

> Violate any one of these and the magazine feel collapses.

1. **Restraint over showmanship** — WebGL backgrounds should show through only on hero pages; ordinary pages should barely reveal them
2. **Structure over decoration** — no shadows, floating cards, or padding boxes; all information relies on **large type + font contrast + grid whitespace**
3. **Hierarchy is defined jointly by size and typeface** — largest serif = main heading, medium serif = subhead, large sans serif = lead, small sans serif = body, monospaced = metadata
4. **Images are first-class citizens** — crop only the bottom of images so the top and left/right remain complete; use fixed `height:Nvh` for grids and do not let `aspect-ratio` stretch them
5. **Rhythm comes from hero pages** — alternate hero and non-hero pages to reduce eye fatigue
6. **Keep terminology consistent** — Skills are Skills; do not translate terms inconsistently between Chinese and English

### Style B · Swiss Internationalism

> Violate any one of these and the page drops from Swiss style into PowerPoint instantly.

1. **Single anchor color** — a deck uses one accent only; no multicolor highlight collage
2. **Extreme type-size contrast** — main heading/body ratio ≥ 8:1; KPI must be a "Data Hero" (18-22% of screen width)
3. **One sans-serif family** — Inter / Helvetica / Noto Sans SC; any serif is wrong
4. **Square solid color** — no gradients / shadows / rounded corners (except rule lines)
5. **Grid above all** — all elements snap to a 12-column grid; left alignment + generous whitespace create the asymmetric aesthetic
6. **Hairline as scalpel** — a 1px hairline divider is enough; do not thicken it or add a shadow
7. **Dot-matrix decoration appears only on hero pages** — body pages keep a clean solid background

## Reference Works

The two styles in this Skill draw on:

**Style A · Digital Magazine**:
- Gui-Zang, “One-Person Company: The Organization Folded by AI” talk (2026-04-22, 27 pages)
- *Monocle* magazine layouts
- YC president Garry Tan's "Thin Harness, Fat Skills" blog demo

**Style B · Swiss Internationalism**:
- Massimo Vignelli's NYC Subway / Unimark systems
- The typographic language of *Helvetica Forever*
- Josef Müller-Brockmann's classic works on grid systems
- Contemporary design: Acne Studios / Off-White / IKEA / Beck Design

Use them as style anchors.
