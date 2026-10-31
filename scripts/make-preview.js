'use strict';

// 生成图标预览图（浅色 / 深色背景各一排多尺寸），用于人工核验质感。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { renderPixels } = require('./make-icon');

function crc32(buf) {
  let c = [];
  for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; c[n] = v >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = c[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii'); const cd = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0);
  return Buffer.concat([len, cd, crc]);
}
function writePng(file, W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) { raw[p++] = 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; raw[p++] = rgba[i]; raw[p++] = rgba[i+1]; raw[p++] = rgba[i+2]; raw[p++] = rgba[i+3]; } }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=6;
  fs.writeFileSync(file, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
  console.log('[preview]', file);
}

// 将透明图标合成到纯色背景上
function composite(size, bg) {
  const px = renderPixels(size, size >= 128 ? 6 : 8);
  const out = new Uint8Array(size * size * 4);
  const br = bg[0], bgc = bg[1], bgb = bg[2];
  for (let i = 0; i < size * size; i++) {
    const a = px[i*4+3] / 255;
    out[i*4]   = Math.round(br * (1 - a) + px[i*4]   * a);
    out[i*4+1] = Math.round(bgc * (1 - a) + px[i*4+1] * a);
    out[i*4+2] = Math.round(bgb * (1 - a) + px[i*4+2] * a);
    out[i*4+3] = 255;
  }
  return out;
}

function montage(sizes, bg, file) {
  const gap = 48, margin = 44;
  const W = sizes.reduce((s, v) => s + v, 0) + gap * (sizes.length - 1) + margin * 2;
  const H = sizes[0] + margin * 2;
  const canvas = new Uint8Array(W * H * 4).fill(255);
  // 填背景
  for (let i = 0; i < W * H; i++) { canvas[i*4]=bg[0]; canvas[i*4+1]=bg[1]; canvas[i*4+2]=bg[2]; canvas[i*4+3]=255; }
  let x = margin;
  const y0 = margin;
  for (const s of sizes) {
    const ic = composite(s, bg);
    for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) {
      const di = ((y0 + yy) * W + (x + xx)) * 4;
      const si = (yy * s + xx) * 4;
      canvas[di] = ic[si]; canvas[di+1] = ic[si+1]; canvas[di+2] = ic[si+2]; canvas[di+3] = 255;
    }
    x += s + gap;
  }
  writePng(file, W, H, canvas);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
montage([256, 128, 64, 32, 16], [242, 243, 245], path.join(outDir, 'preview-light.png'));
montage([256, 128, 64, 32, 16], [30, 30, 32], path.join(outDir, 'preview-dark.png'));
