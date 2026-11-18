# 壁纸皮肤：从素材到可见性（一次做对）

> 适用：用户提供壁纸、要求“看到背景图”、或皮肤要在 `.shell-bg` 上放图。
> 目标：不靠反复试参数，一次写出“壁纸看得见 + 文字可读”的皮肤。
> 机制原因见 `layering.md` §6.2；本文只给流程、数值和验收。

## 0. 判断触发

出现以下任一条件，就按本文流程走，**不要先写一套实色皮肤再补透明**：

- 用户给了壁纸 / 背景图 / 截图并要求用作背景；
- 用户说“壁纸看不见”“背景没生效”“想要半透明”；
- 你自己在 `skin.css` 里写了 `.shell-bg { background-image: ... }`。

## 1. 写 CSS 之前：素材体检

壁纸的亮度决定后面所有 alpha。先量，不要凭感觉。

```bash
# 有 PIL 时：整体均值 + 画布区均值/标准差
python3 - <<'PY'
from PIL import Image, ImageStat
im = Image.open('wallpaper.png').convert('RGB'); w, h = im.size
def s(box, name):
    st = ImageStat.Stat(im.crop(box))
    print(name, 'mean', tuple(round(v) for v in st.mean), 'stddev', tuple(round(v) for v in st.stddev))
s((0, 0, w, h), 'all')
s((int(w*.17), 0, int(w*.70), h), 'canvas')
PY

# 无 PIL 时：取 1×1 平均色（输出 6 位十六进制）
ffmpeg -v error -i wallpaper.png -vf scale=1:1 -f rawvideo -pix_fmt rgb24 - | xxd -p
```

判读：

| 整体均值亮度（取 RGB 最大通道 /255） | 结论 |
|---|---|
| < 18% | 太暗，必须提亮 1.45–1.6×，否则叠面板后是纯色 |
| 18–25% | 偏暗，提亮 1.2–1.4× |
| 25–35% | 可用，原样；遮罩 ≤ 0.08 |
| > 35% | 原样或压暗 0.9×；面板 alpha 要更高保文字 |

画布区 `stddev` < 10 说明纹理不足：即使提亮也只会是“有色渐变”，考虑换图或提高对比 1.05–1.1×。

提亮：

```bash
python3 - <<'PY'
from PIL import Image, ImageEnhance
im = Image.open('wallpaper.png').convert('RGB')
im = ImageEnhance.Brightness(im).enhance(1.45)
im = ImageEnhance.Contrast(im).enhance(1.06)
im.save('wallpaper-bright.png', optimize=True)
PY
```

单张 asset ≤ 4 MB，提亮后重新算包大小。

## 2. 按亮度选参数

| 壁纸均值 | 提亮 | `.shell-bg` 遮罩 | `bg-content-area` | `bg-sidebar` | `bg-surface-raised` / `bg-card` | `bg-dialog` |
|---|---|---|---|---|---|---|
| < 18% | 1.45–1.6× | 0.04–0.06 | 0.38 | 0.44 | 0.55 | 0.86 |
| 18–25% | 1.2–1.4× | 0.06 | 0.40 | 0.46 | 0.58 | 0.88 |
| 25–35% | 1.0 | 0.08 | 0.44 | 0.50 | 0.62 | 0.90 |
| > 35% | 0.9× | 0.12 | 0.50 | 0.56 | 0.66 | 0.92 |

其余承载类随档位取：`bg-background` ≈ content + 0.04，`bg-input-surface` / `.agent-input-surface` ≈ content，`bg-control` ≈ content + 0.10，`bg-surface-sunken` ≈ content − 0.04，`bg-popover` ≈ dialog + 0.02。

层级底线：`content` 与 `sidebar` 的 L 至少差 1–2 个百分点，`raised/card` 比 `content` 亮 4–6 个百分点；否则透过壁纸后区域会糊成一片。

## 3. CSS 骨架（照抄，只改数值）

```css
/* 文档层与外壳透明 */
html[class*="skin-"],
html[class*="skin-"] body,
html[class*="skin-"] #root { background-color: transparent !important; }

/* 面板半透明：alpha 只能落在承载类上，不能塞进 Tailwind 三元组 */
html[class*="skin-"] [class~="bg-background"]      { background-color: hsl(var(--background) / 0.44) !important; }
html[class*="skin-"] [class~="bg-content-area"]    { background-color: hsl(var(--content-area) / 0.40) !important; }
html[class*="skin-"] [class~="bg-sidebar"]         { background-color: hsl(var(--sidebar-surface) / 0.46) !important; }
html[class*="skin-"] [class~="bg-surface-raised"]  { background-color: hsl(var(--raised-surface) / 0.58) !important; }
html[class*="skin-"] [class~="bg-card"]            { background-color: hsl(var(--card) / 0.58) !important; }
html[class*="skin-"] [class~="bg-surface-sunken"]  { background-color: hsl(var(--sunken-surface) / 0.36) !important; }
html[class*="skin-"] [class~="bg-control"]         { background-color: hsl(var(--control-surface) / 0.52) !important; }
html[class*="skin-"] [class~="bg-input-surface"]   { background-color: hsl(var(--input-surface) / 0.44) !important; }
html[class*="skin-"] [class~="bg-dialog"]          { background-color: hsl(var(--dialog) / 0.86) !important; }
html[class*="skin-"] [class~="bg-popover"]         { background-color: hsl(var(--popover) / 0.88) !important; }
html[class*="skin-"] .agent-input-surface          { background-color: hsl(var(--input-surface) / 0.44) !important; }

/* 壁纸必须在类规则之后，且显式清掉 bg-surface-shell 的底色 */
html[class*="skin-"] .shell-bg {
  background-color: transparent !important;
  background-image:
    linear-gradient(hsl(164 22% 5% / 0.08), hsl(160 18% 6% / 0.04)),
    url("assets/background.webp");
  background-size: cover;
  background-position: center;
}
```

## 4. 验收（三步，缺一不可）

```bash
# 1) 静态：面板规则真的进包了
grep -nE '\[class~="bg-(content-area|sidebar|card|dialog)"\]' skin.css

# 2) 运行时：截图（macOS，先取窗口 bounds 再截）
osascript -e 'tell application "System Events" to tell process "Profer" to get {position, size} of window 1'
screencapture -x -R<x>,<y>,<w>,<h> window.png
```

3）看截图里**画布区是否有可见纹理**，并抽查文字：正文与背景肉眼可分辨、选中行/输入框没有被冲淡。有 PIL 时给客观值：

```bash
python3 - <<'PY'
from PIL import Image; import numpy as np
a = np.asarray(Image.open('window.png').convert('L'))
c = a[200:1400, 780:2800]            # 按实际裁剪调整
print('p5/p50/p95', np.percentile(c, [5, 50, 95]))
PY
```

判据：p95 与 p50 的差值应 ≥ 40（文字可读）；画布区 p95−p5 ≥ 25（纹理可见）。达不到就按 §5 调。

没有截图或 computed 通道时，交付必须写“壁纸可见性未验证”，不能写“壁纸已生效”。

## 5. 失败对照

| 症状 | 原因 | 改什么 |
|---|---|---|
| 纯色，完全没纹理 | 遮罩 ≥ 0.3，或面板 alpha ≥ 0.7 | 遮罩降到 0.04–0.10；面板按 §2 表 |
| 只有面板缝隙有图 | 只写了 `.shell-bg`，没写承载类 alpha | 补 §3 的 7–11 条规则 |
| 有纹理但发灰发闷 | 壁纸本身太暗，被面板压死 | 提亮素材 1.4× 左右 |
| 正文糊、看不清 | alpha 太低或壁纸太亮 | content 提 0.04–0.06，或 foreground 提到 96% |
| 浮层透明到读不了 | dialog/popover 跟着面板一起降 | 单独保持 0.86–0.92 |
| 切肤瞬间闪一下 | `tone` 与 `:root` 明暗不符 | 修 manifest tone / id 后缀 |
| 缩略图比实际亮很多 | 派生预览不含 CSS 遮罩 | 交付时说明，或显式传 previewPath |

## 6. 边界

- 以上只能做到**层间半透明**（壁纸从面板下透出）。**看不到桌面**：主窗口 `transparent: false` 且 `backgroundColor` 不透明，属主进程改动。
- `body` 透明会影响快速任务窗口；若该窗口需要实体卡片，给它的容器单独补不透明底。
- 多显示器下 `screencapture -R` 的坐标是合并坐标系；窗口跨屏时截图会出现空白边，裁剪内容区即可，不代表界面异常。
