// 纯 Node 生成 Android 各密度启动图标 PNG（绿色圆角方块 + 白色对勾）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, table = crc32.t || (crc32.t = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function makeIcon(s) {
  const buf = Buffer.alloc(s * s * 4);
  const r = s * 0.18;            // 圆角半径
  const bg = [7, 193, 96];       // #07C160
  const fg = [255, 255, 255];
  const lw = s * 0.13;           // 对勾线宽
  const p1 = [s * 0.30, s * 0.52];
  const p2 = [s * 0.44, s * 0.66];
  const p3 = [s * 0.72, s * 0.34];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = (y * s + x) * 4;
    // 圆角矩形遮罩
    let inside = true;
    const cx = Math.min(Math.max(x, r), s - 1 - r);
    const cy = Math.min(Math.max(y, r), s - 1 - r);
    if (Math.hypot(x - cx, y - cy) > r) inside = false;
    let col = null;
    if (inside) {
      // 对勾
      const d = Math.min(distToSeg(x, y, p1[0], p1[1], p2[0], p2[1]), distToSeg(x, y, p2[0], p2[1], p3[0], p3[1]));
      col = d < lw / 2 ? fg : bg;
    }
    if (col) { buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255; }
    else { buf[i + 3] = 0; }
  }
  return encodePNG(s, s, buf);
}

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const outDir = path.join(__dirname, 'res');
for (const [name, size] of Object.entries(densities)) {
  const dir = path.join(outDir, `mipmap-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), makeIcon(size));
  console.log(`wrote mipmap-${name} (${size}px)`);
}
console.log('icons generated');
