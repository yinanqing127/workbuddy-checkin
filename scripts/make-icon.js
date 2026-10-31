'use strict';

// 生成 WorkBuddy 每日签到图标（绿色圆形 + 白色对勾）。
// 设计目标：在保留「绿色圆形」品牌识别度的前提下，提升质感与专业度：
//   - 保留品牌绿（近似 #07C160）作为主识别元素
//   - 加入白色对勾，强化「签到 / check-in」语义
//   - 通过柔和线性渐变 + 顶部微高光 + 边缘微暗角 营造高级的层次与立体感（非拟物、现代简洁）
// 采用 8x 超采样 + 均值降采样实现高质量抗锯齿，无需任何外部依赖（纯 Node + zlib）。
//
// 导出 makePngBuffer(size) 与 renderPixels(size, scale) 供托盘图标与 Windows .ico 图标共用。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const cd = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cd), 0);
  return Buffer.concat([len, cd, crc]);
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// 品牌绿渐变两端（保持整体接近 #07C160 的识别绿）
const TOP = [26, 203, 116];   // 顶部略亮
const BOTTOM = [5, 176, 88];  // 底部略深

/**
 * 渲染一张图标的 RGBA 像素（透明背景），采用超采样抗锯齿。
 * @param {number} size 输出边长（像素）
 * @param {number} scale 超采样倍数
 * @returns {Float32Array} length = size*size*4，RGBA（0-255，未预乘）
 */
function renderPixels(size, scale) {
  const W = size;
  const H = size;
  const out = new Float32Array(W * H * 4);

  const cx = W / 2;
  const cy = H / 2;
  const margin = Math.max(1, Math.round(W * 0.035));
  const radius = W / 2 - margin;

  // 顶部高光中心（左上偏移）
  const hx = cx - 0.30 * radius;
  const hy = cy - 0.34 * radius;
  const hRadius = 0.98 * radius;

  // 对勾几何（归一化，y 向上为正），随后映射到图像坐标
  const NS = radius * 0.60; // 对勾半尺度
  const shiftX = cx - 0.015 * NS; // 轻微左移以光学居中
  // 三个顶点：左尖、底部拐点、右尖
  const ax = shiftX + -0.62 * NS, ay = cy - 0.08 * NS; // 左臂尖
  const bx = shiftX + -0.05 * NS, by = cy - -0.55 * NS; // 底部拐点（最低）
  const cxp = shiftX + 0.66 * NS, cyp = cy - 0.58 * NS; // 右臂尖（最高）
  const half = radius * 0.135; // 对勾半粗

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const fx = x + (sx + 0.5) / scale;
          const fy = y + (sy + 0.5) / scale;
          const dx = fx - cx;
          const dy = fy - cy;
          const d = Math.hypot(dx, dy);
          if (d > radius) continue; // 圆外 → 透明

          // 纵向渐变（顶亮底暗）
          const t = clamp(fy / H, 0, 1);
          let cr = lerp(TOP[0], BOTTOM[0], t);
          let cg = lerp(TOP[1], BOTTOM[1], t);
          let cb = lerp(TOP[2], BOTTOM[2], t);

          // 边缘暗角（靠近边缘轻微压暗，增加精致的体积感）
          const edge = d / radius;
          const vig = 1 - 0.10 * smoothstep(0.80, 1.0, edge);
          cr *= vig; cg *= vig; cb *= vig;

          // 顶部柔光（微妙高光，营造高级质感）
          const hd = Math.hypot(fx - hx, fy - hy);
          const sheen = Math.pow(clamp(1 - hd / hRadius, 0, 1), 1.5) * 0.14;
          cr += 255 * sheen; cg += 255 * sheen; cb += 255 * sheen;

          // 对勾：白色覆盖
          const d1 = distToSeg(fx, fy, ax, ay, bx, by);
          const d2 = distToSeg(fx, fy, bx, by, cxp, cyp);
          const dm = Math.min(d1, d2);
          if (dm <= half) {
            cr = 255; cg = 255; cb = 255;
          }

          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const inv = 1 / (scale * scale);
      const idx = (y * W + x) * 4;
      out[idx] = r * inv;
      out[idx + 1] = g * inv;
      out[idx + 2] = b * inv;
      out[idx + 3] = a * inv;
    }
  }
  return out;
}

/**
 * 生成一张图标的 PNG buffer（透明背景）。
 * @param {number} size 边长（像素）
 * @returns {Buffer}
 */
function makePngBuffer(size) {
  const W = size;
  const H = size;
  const scale = size >= 128 ? 6 : 8; // 大尺寸略降采样以提速，仍保持平滑

  const pix = renderPixels(size, scale);

  // 写入 RGBA，每行前加 filter 字节(0)
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0;
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      raw[p++] = Math.round(pix[idx]);
      raw[p++] = Math.round(pix[idx + 1]);
      raw[p++] = Math.round(pix[idx + 2]);
      raw[p++] = Math.round(pix[idx + 3]);
    }
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

if (require.main === module) {
  const outDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'tray-icon.png');
  const buf = makePngBuffer(32);
  fs.writeFileSync(outPath, buf);
  console.log('[make-icon] 已生成托盘图标:', outPath, `(${buf.length} bytes)`);
}

module.exports = { makePngBuffer, renderPixels };
