// gradient.js —— 渐变背景/色块图片生成器
// 用途：pptxgenjs 不支持原生渐变填充，用此模块生成渐变 PNG，作为 slide 背景或色块图片。
// 支持：线性渐变(linear, 任意角度) + 径向渐变(radial) + 多停止点。
// 用法：
//   const { linearGradient, radialGradient, gradientToBase64 } = require('./gradient')
//   const buf = await linearGradient({ from:'1E2761', to:'065A82', width:1920, height:1080, angle:135 })
//   const data = gradientToBase64(buf)  // 可直接喂给 pptxgenjs addImage({data})
const sharp = require('sharp');

/**
 * 解析 '#RRGGBB' 或 'RRGGBB' 为 [r,g,b]
 */
function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) throw new Error(`非法颜色: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * 生成线性渐变 PNG
 * @param {object} opts
 *   from, to: 起始/结束色（支持 '#RRGGBB' 或 'RRGGBB'）
 *   stops: 可选，多停止点数组 [{pos:0~1, color:'RRGGBB'}]，优先级高于 from/to
 *   angle: 渐变方向角度(度)，0=向上，90=向右，默认 90（水平）
 *   width/height: 输出尺寸(px)，默认 1920x1080
 * @returns {Promise<Buffer>} PNG buffer
 */
async function linearGradient(opts = {}) {
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const angle = ((opts.angle != null ? opts.angle : 90) % 360) * Math.PI / 180;

  let stops;
  if (opts.stops && opts.stops.length) {
    stops = opts.stops.map(s => ({ pos: s.pos, rgb: hexToRgb(s.color) }));
  } else {
    const from = hexToRgb(opts.from || '000000');
    const to = hexToRgb(opts.to || 'FFFFFF');
    stops = [{ pos: 0, rgb: from }, { pos: 1, rgb: to }];
  }
  stops.sort((a, b) => a.pos - b.pos);

  // 用 1 像素宽的横向渐变，再放大 + 旋转，实现任意角度。
  // 做法：先在一条长度 L 的线上算渐变色 → 生成 1xL 的渐变条 → SVG 包裹做旋转。
  // 为简单可靠，改用逐像素在 CPU 上计算（分辨率高时会慢，但对背景图足够）。
  const raw = Buffer.alloc(width * height * 3);
  // 渐变方向单位向量
  const dx = Math.sin(angle), dy = -Math.cos(angle); // 90° => (1,0) 水平
  // 投影范围（用于归一化 t 到 0~1）
  const corners = [[0,0],[width-1,0],[0,height-1],[width-1,height-1]];
  let projMin = Infinity, projMax = -Infinity;
  for (const [cx, cy] of corners) {
    const p = cx * dx / width + cy * dy / height;
    if (p < projMin) projMin = p;
    if (p > projMax) projMax = p;
  }
  const projRange = (projMax - projMin) || 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (x * dx / width + y * dy / height - projMin) / projRange;
      const t = Math.max(0, Math.min(1, p));
      // 在 stops 之间插值
      let rgb;
      if (t <= stops[0].pos) rgb = stops[0].rgb;
      else if (t >= stops[stops.length - 1].pos) rgb = stops[stops.length - 1].rgb;
      else {
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i], b = stops[i + 1];
          if (t >= a.pos && t <= b.pos) {
            const f = (t - a.pos) / (b.pos - a.pos || 1);
            rgb = [
              Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
              Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
              Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
            ];
            break;
          }
        }
      }
      const idx = (y * width + x) * 3;
      raw[idx] = rgb[0]; raw[idx + 1] = rgb[1]; raw[idx + 2] = rgb[2];
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/**
 * 生成径向渐变 PNG（从中心向外）
 * @param {object} opts
 *   from/to 或 stops，center：[cx,cy] 归一化 0~1，默认 [0.5,0.5]
 * @returns {Promise<Buffer>}
 */
async function radialGradient(opts = {}) {
  const width = opts.width || 1920;
  const height = opts.height || 1080;
  const cx = (opts.center && opts.center[0] != null ? opts.center[0] : 0.5) * width;
  const cy = (opts.center && opts.center[1] != null ? opts.center[1] : 0.5) * height;
  let stops;
  if (opts.stops && opts.stops.length) {
    stops = opts.stops.map(s => ({ pos: s.pos, rgb: hexToRgb(s.color) }));
  } else {
    stops = [
      { pos: 0, rgb: hexToRgb(opts.from || 'FFFFFF') },
      { pos: 1, rgb: hexToRgb(opts.to || '000000') },
    ];
  }
  stops.sort((a, b) => a.pos - b.pos);
  const maxR = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(width - cx, cy),
    Math.hypot(cx, height - cy),
    Math.hypot(width - cx, height - cy)
  ) || 1;

  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxR;
      const t = Math.max(0, Math.min(1, d));
      let rgb;
      if (t <= stops[0].pos) rgb = stops[0].rgb;
      else if (t >= stops[stops.length - 1].pos) rgb = stops[stops.length - 1].rgb;
      else {
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i], b = stops[i + 1];
          if (t >= a.pos && t <= b.pos) {
            const f = (t - a.pos) / (b.pos - a.pos || 1);
            rgb = [
              Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
              Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
              Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
            ];
            break;
          }
        }
      }
      const idx = (y * width + x) * 3;
      raw[idx] = rgb[0]; raw[idx + 1] = rgb[1]; raw[idx + 2] = rgb[2];
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Buffer → pptxgenjs 可直接用的 data 字符串 */
function gradientToBase64(buf) {
  return 'image/png;base64,' + buf.toString('base64');
}

// CLI: node gradient.js --type linear --from 1E2761 --to 065A82 --angle 135 -o out.png
if (require.main === module) {
  // 手写参数解析，避免引入 minimist 依赖
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = process.argv[i + 1];
      if (nxt && !nxt.startsWith('--')) { args[k] = nxt; i++; }
      else { args[k] = true; }
    } else if (a === '-o' && process.argv[i + 1]) {
      args.o = process.argv[++i];
    }
  }
  (async () => {
    const type = args.type || 'linear';
    const opts = {
      from: args.from, to: args.to, angle: args.angle != null ? Number(args.angle) : undefined,
      width: Number(args.width) || 1920, height: Number(args.height) || 1080,
      stops: args.stops ? JSON.parse(args.stops) : null,
    };
    const buf = type === 'radial' ? await radialGradient(opts) : await linearGradient(opts);
    if (args.o || args.out) {
      require('fs').writeFileSync(args.o || args.out, buf);
      console.log('WROTE', args.o || args.out);
    } else {
      console.log(gradientToBase64(buf).slice(0, 60) + '...');
    }
  })().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { linearGradient, radialGradient, gradientToBase64, hexToRgb };
