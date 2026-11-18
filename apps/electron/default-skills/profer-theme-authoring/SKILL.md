---
name: profer-theme-authoring
description: The meta-prompt for Profer skins (皮肤 / skin packages) — identifies the task type, routes to the single token contract, enforces the v2 surface hierarchy, and keeps acceptance honest. Use when users ask to create, modify, reproduce or optimize a Profer skin, a special style, dark or light palettes, skin previews, skin tokens or title-bar colors, or report that a skin is not taking effect, still looks like the default colors, loses button or selected-session styles, has invisible status colors, cannot achieve a transparent background, is not followed by the settings page or input field, loads more slowly after switching, or is not synchronized across windows.
compatibility: Modifying built-in skin source requires read/edit/bash access to the Profer source repository (apps/electron); user skins only require create_skin or read/write access to the user skin directory.
version: "1.3.1"
---

# Profer Skin Meta-Prompt

Your job is to turn a skin request into an **installable, verifiable** skin package, and to report honestly how far verification actually went. This file defines decisions, routing and hard constraints; mechanism, CSS recipes and acceptance details live in `references/` and are read on demand.

## 1. Identify the task type first

| Type | Approach | Risk |
|---|---|---|
| New skin | Design tokens → implement → acceptance | Medium |
| Wallpaper / see-through background | Material check → alpha table → CSS → screenshot | Medium |
| Adjust an existing user skin | Edit only inside the user skin directory; verify window and surfaces | Low |
| Change native light / dark mode | Do not override `:root` / `.dark` with skin tokens by default; explain impact and get explicit confirmation | High |
| Change only the preview image | Verify card asset and framing; do not claim visual verification | Low |
| Fix a skin that "broke" (lost button styles, selected-session colors, status dots, transparency) | Diagnose the failing layer first via `references/layering.md`; do not recolor blindly | Medium |

If the user supplies a palette or screenshot, treat it as the visual baseline; do not replace it with a supposedly "better" scheme.

## 2. Read the single source of truth; do not work from memory

All repo paths below are relative to the Profer repository root (the directory containing `apps/electron`). Resolve it first; do not assume the session cwd is the repo root.

- **Token contract (authoritative)**: `apps/electron/resources/skin-template/skin.css` and `manifest.json`. The Settings "authoring guide" imports these exact files and the component comment calls them the only source of truth. Read them before writing any token.
- **Consumers of the contract**: `renderer/styles/skin-base.css` (public rules that consume optional tokens), `tailwind.config.js` (token → utility mapping), and the `:root` / `.dark` defaults in `renderer/styles/globals.css`.
- **Validation**: `main/lib/skin-service.ts` `auditSkinCss` (what CSS is rejected) and `main/lib/skin-manager-service.ts` (package limits, manifest fields).
- **Built-in skins are examples, not the contract.** Read at most one light and one dark (`forest-light` / `forest-dark`) to compare real layer separation. All built-in skins map v2 tokens onto their v1 palette (`--shell-surface: var(--background)`); that is a compatibility shape, not the canonical contract. Only `skin-template/skin.css` assigns v2 surfaces directly — use it for token syntax.
- **Wallpaper-driven skins**: `references/wallpaper-visibility.md`. Material check, brightness-based alpha table, CSS skeleton and screenshot acceptance. Read it before writing any `.shell-bg` rule.
- Mechanism, title bar, caching and install locations: `references/mechanism.md`.
- **Hierarchy, value formats, cascade and failure modes**: `references/layering.md`. Read it before touching any surface or diagnosing a "style disappeared" report. It supersedes older wording that "an undefined token simply falls back to the component default" — for `skin-base.css` tokens an undefined bare `var()` resolves to `unset` (usually transparent), and `!important` then hides the component's own fallback.
- Selectors, token groups and special-case rules: `references/css-recipes.md`.
- Acceptance and delivery wording: `references/verification.md`.
- When the issue is "colors do not follow the skin" inside rendering code (visualization, browser preview), also read `workspace-files/.context/memory-archive/theme-token-plumbing.md`.
- **Scan boundaries**: `ls` / `rg` inside these fixed roots is fine and expected: `apps/electron/resources/skins/`, `apps/electron/resources/skin-template/`, `apps/electron/src/renderer/styles/`, and the user skin directory (`~/.profer/skins/`, dev builds `~/.profer-dev/skins/`). Only full-disk recursive scans (`find /`, `ls -R ~`, `Get-ChildItem -Recurse` from home) are forbidden — they cross protected directories such as `~/Music` and trigger macOS privacy prompts. The `installedPath` returned by `create_skin` is the definitive install location; do not search for it afterwards.

## 3. Implementation approach

- **A wallpaper is an input, not a decoration.** Before writing CSS, run the material check in `references/wallpaper-visibility.md` §1 (mean brightness, canvas stddev) and brighten the asset when mean < 18%. Take alpha values from its §2 table instead of guessing; the table is the difference between a one-pass skin and three rounds of "still can't see it".
- **Use `create_skin` by default**: pass `id`, `name`, `tone` (`light`|`dark`), `skinCss`; pass `wallpaperPath` when an authorized wallpaper exists, `previewPath` when a thumbnail is needed, `previewScale` / `previewPosition` for framing, `titlebarColor` / `titlebarSymbolColor` for the title bar. It copies wallpapers into `assets/`, audits the CSS, installs atomically and refreshes the library. It writes `contractVersion: 2` for you.
- `apply` defaults to `true`; pass `apply: false` only when the user explicitly wants it installed but not activated.
- **Adjust a user skin**: edit files under `~/.profer/skins/{id}/` directly, then refresh in Settings.
- **Change a built-in skin**: edit `apps/electron/resources/skins/{id}/`, then `bun run build:resources` and rebuild. High-cost path; prefer a user skin unless explicitly requested.
- A user skin with the same id as a built-in skin is skipped in favor of the built-in one. Use a different id, or confirm the conflict before installing.
- One asset image ≤ 4 MB, whole package ≤ 5 MB, `skin.css` ≤ 512 KB, preview ≤ 2 MB.
- Pass `replace: true` only with explicit overwrite authorization.

## 4. Hard design constraints

- **Design by layer, using the v2 surface contract.** The layers and their real carriers are listed in `references/css-recipes.md` §3 and `references/layering.md` §4. Minimum distinct set for a dark skin: shell (`--shell-surface`), main canvas (`--content-area`), raised/card (`--raised-surface` / `--card`), input (`--input-surface`), overlay (`--dialog` / `--popover`). "Everything gray at 7%–10% lightness" is not a hierarchy.
- **Match the value format to the consumer.** Tailwind-mapped tokens (most colors) take HSL triples only (`H S% L%`). Tokens consumed directly by `skin-base.css` (`--item-selected-bg`, `--selection-bg`, `--mode-slider-bg`, `--scroll-thumb-*`, `--shell-bg-gradient`, `--dialog-glow-shadow`, `--code-block-header-bg`, …) take complete CSS values. Mixing them produces invalid declarations that look like "lost styles". The exact lists and a grep self-check are in `references/layering.md` §1.
- **Declaring v2 is not the same as implementing v2.** `create_skin` always writes `contractVersion: 2`. If the CSS only fills the old ~20 shadcn tokens, the remaining v2 surfaces either inherit `.dark` defaults or, for optional tokens, become transparent. Fill groups A/B/C at minimum; D/E/F when overlays, messages, status or charts matter.
- **Undefined optional tokens are not "inert".** `skin-base.css` consumes `--item-selected-bg`, `--scroll-thumb-*`, `--selection-bg`, `--mode-slider-bg`, `--dialog-glow-shadow` with bare `var()` plus `!important`. Leaving them out makes the selected row / slider / scrollbar transparent and can override the component's own subtle fallback. Define them when the user cares about selection states, scrollbars or code blocks.
- **Cascade beats injection order.** `:root.ui-classic` overrides a skin `:root` `--radius`; `.ui-classic .agent-input-surface` overrides a bare skin rule; `:where()` zeroes specificity. Use `html[class*="skin-"]` prefixes and same-specificity `!important` overrides, and do not put `transform` / `filter` / `backdrop-filter` on `html`, `body`, `#root` or `.shell-bg` (it breaks fixed dialogs and title-bar drag hit-testing). Details in `references/layering.md` §3.
- **A wallpaper is invisible until panels go translucent — and "visible" needs numbers.** Putting an image on `.shell-bg` only shows it through the gaps: `body`, `.shell-bg`, `bg-content-area`, `bg-sidebar`, `bg-card`, `bg-surface-raised` and `bg-dialog` each paint an opaque layer above it. A wallpaper skin is therefore a two-part job: (1) brighten the asset when its mean brightness is < 18% (`references/wallpaper-visibility.md` §1), (2) apply the carrier-class alpha table from §2 (`content-area` 0.38–0.44, `sidebar` 0.44–0.50, `raised`/`card` 0.55–0.62, `dialog` 0.86–0.90, wallpaper scrim 0.04–0.10). Alpha must live on those classes, never inside a Tailwind token triple. Do not ship a wallpaper skin without a screenshot or say "壁纸已生效"; without one the honest wording is "壁纸只在面板缝隙可见".
- **Transparency has a chain, and the main window is opaque.** `body` (`bg-background`), `.shell-bg` (`bg-surface-shell`), panels (`bg-content-area` / `bg-sidebar` / `bg-card`) and the `BrowserWindow` `backgroundColor` each block it. A skin can make internal layers translucent; it cannot by itself make the desktop show through the main window. Never claim "transparent background" without clarifying which of the three meanings and without window-level evidence. Recipes in `references/layering.md` §6.
- **`tone` is not a label.** It drives `html.dark`; a dark palette declared `tone: light` loses dark shadows/variants, a light palette declared `tone: dark` gets dirty dark shadows. Keep manifest tone and the `:root` palette consistent (and prefer a `-light` id suffix for light skins to avoid first-frame tone inference flashes).
- **Status colors are split across layers.** Left sidebar / switcher / delegation icons use `--info` / `--warning` / `--success`; top-bar tab status borders are still hard-coded in `globals.css`. If the user wants them consistent, add explicit skin overrides (selectors in `references/layering.md` §5.3). Also note that `.session-item-selected * { color: inherit !important }` flattens status icon colors inside the selected row.
- **Text contrast**: body text ≥ 4.5:1 against its background; explain the tradeoff for intentionally low-contrast art styles.
- **Do not override native styles**: do not change global tokens for native light / dark mode unless the high-risk task in §1 is confirmed.
- **Resource safety**: `url()` and `src()` may only reference lowercase `assets/…png|webp|svg|jpg|jpeg`. `data:`, `file:`, external links, absolute paths, `../`, `@import`, `@font-face` and CSS escapes inside `url()` are rejected by `auditSkinCss`. Wallpaper rules belong on `.shell-bg`.
- **Verify the pipeline before tuning colors**: if a skin looks like default dark mode, first use a high-contrast probe to confirm the renderer received the skin tokens, then remove the probe immediately.
- **Platform differences are real**: `manifest.titlebar` is applied live via `setTitleBarOverlay` only on Windows; on macOS the color is read when the window is created, so a skin switch may require a restart to show the new frame color. Never report a macOS title-bar check as if it were a Windows overlay check.

## 5. Acceptance and delivery

- Follow `references/verification.md`. Static checks, a successful build or a successful install are **not** "the skin is implemented".
- **Wallpaper skins are only accepted with a screenshot.** Run `references/wallpaper-visibility.md` §4: grep the carrier rules, capture the window, and judge texture (canvas p95−p5 ≥ 25) and text (p95−p50 ≥ 40). A successful `create_skin` result is not acceptance.
- A complete acceptance pass covers: token format (triples vs full values), shell / sidebar / main canvas / card / input / dialog surfaces, one default + one outline + one secondary button, a selected session row, a running/blocked/completed status indicator, scrollbar and selection, and the classic UI (`ui-classic`) variant if the user uses it.
- For transparency claims, state which meaning is being verified (desktop see-through vs internal translucency) and provide computed backgrounds for `body`, `.shell-bg` and the main panel. Desktop see-through on the main window is not a skin-level capability.
- Only claim runtime verification when you actually have computed-style or visual evidence. If the session has no DevTools/CDP access, say so and list it as unverified instead of inventing a result.
- The final response must list: skin name and id; files involved (package directory and any source changes); the key palette/tokens by layer; whether a probe or debug panel was removed; which static and runtime checks were actually performed; and what remains unverified (for example main-process restart, title bar, multi-window sync).
