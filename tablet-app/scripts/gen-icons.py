#!/usr/bin/env python3
"""生成 Profer 移动版 Android 启动图标。

源：Profer 桌面仓库 apps/electron/resources/icon.png（1024x1024 黑底圆角 Profer logo）
策略：
- ic_launcher.png / ic_launcher_round.png：源图直接缩放到各密度（Android 自动裁圆角）
- ic_launcher_foreground.png（adaptive 前景）：源图整幅填满 108dp 画布（黑底圆角方块），
  系统圆形裁切时四角露出的黑色与 background #000000 融为一体，白条纹完整显示
- ic_launcher_background 颜色改为 #000000
"""
from PIL import Image
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "apps" / "electron" / "resources" / "icon.png"
RES = ROOT / "tablet-app" / "android" / "app" / "src" / "main" / "res"
BG_COLOR = "#000000"
# 图标内容相对画布的缩放（1.0 = 满幅；0.9 = 整体缩小 10%，四周留黑边）
SCALE = 0.9

# 密度 -> (legacy 图标尺寸 px, adaptive foreground 108dp 尺寸 px)
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

src_img = Image.open(SRC).convert("RGBA")

for dpi, (legacy_size, fg_size) in DENSITIES.items():
    mipmap = os.path.join(RES, f"mipmap-{dpi}")
    os.makedirs(mipmap, exist_ok=True)

    # legacy 图标：黑色画布 + 居中缩放 90% 的源图（圆角外露黑底，launcher 上观感连续）
    canvas = Image.new("RGBA", (legacy_size, legacy_size), (0, 0, 0, 255))
    c_size = max(1, int(round(legacy_size * SCALE)))
    content = src_img.resize((c_size, c_size), Image.LANCZOS)
    off = (legacy_size - c_size) // 2
    canvas.alpha_composite(content, (off, off))
    canvas.save(os.path.join(mipmap, "ic_launcher.png"))
    canvas.save(os.path.join(mipmap, "ic_launcher_round.png"))

    # adaptive foreground：透明画布 + 居中缩放 90% 的源图（背景色由 ic_launcher_background 黑色承接）
    fg = Image.new("RGBA", (fg_size, fg_size), (0, 0, 0, 0))
    f_size = max(1, int(round(fg_size * SCALE)))
    scaled = src_img.resize((f_size, f_size), Image.LANCZOS)
    fg_off = (fg_size - f_size) // 2
    fg.alpha_composite(scaled, (fg_off, fg_off))
    fg.save(os.path.join(mipmap, "ic_launcher_foreground.png"))

    print(f"[icons] {dpi}: legacy {legacy_size}px (content {c_size}, scale {SCALE}), foreground {fg_size}px (content {f_size}, scale {SCALE}) OK")

# 背景色（adaptive 圆形裁切时四角颜色）
bg_xml = os.path.join(RES, "values", "ic_launcher_background.xml")
with open(bg_xml, "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">%s</color>\n</resources>\n' % BG_COLOR)
print(f"[icons] background -> {BG_COLOR}")
print("[icons] done")
