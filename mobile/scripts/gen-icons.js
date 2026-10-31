'use strict';

// 纯 Node 生成 PWA 图标（无第三方依赖）：绿色圆角方块 + 白色对勾。
// 生成：icon-192.png、icon-512.png、icon-512-maskable.png

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function makeIcon(size, fullBg) {
  const buf = Buffer.alloc(size * size * 4); // 全透明
  const green = [7, 193, 96, 255];
  const white = [255, 255, 255, 255];

  const pad = fullBg ? 0 : Math.round(size * 0.12);
  const r = fullBg ? 0 : Math.round(size * 0.22);
  const w = size - pad * 2;
  const x0 = pad;
  const y0 = pad;

  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    buf[i + 3] = c[3];
  };

  // 圆角方块
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside;
      if (fullBg) {
        inside = true;
      } else {
        const inX = x >= x0 && x < x0 + w;
        const inY = y >= y0 && y < y0 + w;
        if (!inX || !inY) {
          inside = false;
        } else {
          const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
          const cy = Math.min(Math.max(y, y0 + r), y0 + w - r);
          inside = Math.hypot(x - cx, y - cy) <= r;
        }
      }
      if (inside) set(x, y, green);
    }
  }

  // 对勾（在点阵中心，按安全区缩放；maskable 时收进中心 60% 区域）
  const cx = size / 2;
  const cy = size / 2;
  const s = fullBg ? size * 0.46 : size * 0.5;
  const thick = Math.max(2, Math.round(size * 0.085));
  const p1 = [cx - 0.34 * s, cy + 0.02 * s];
  const p2 = [cx - 0.10 * s, cy + 0.30 * s];
  const p3 = [cx + 0.38 * s, cy - 0.30 * s];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (buf[i + 3] === 0) continue; // 只在绿色区域内画
      const d1 = distToSeg(x + 0.5, y + 0.5, p1[0], p1[1], p2[0], p2[1]);
      const d2 = distToSeg(x + 0.5, y + 0.5, p2[0], p2[1], p3[0], p3[1]);
      if (d1 <= thick || d2 <= thick) set(x, y, white);
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(outDir, 'icon-192.png'), encodePNG(192, makeIcon(192, false)));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), encodePNG(512, makeIcon(512, false)));
fs.writeFileSync(path.join(outDir, 'icon-512-maskable.png'), encodePNG(512, makeIcon(512, true)));
console.log('图标已生成：icon-192.png / icon-512.png / icon-512-maskable.png');
